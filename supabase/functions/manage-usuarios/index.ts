// Versão exata pinada (em vez de "@2") para que uma release nova do
// supabase-js não entre em produção sem passar por um commit e revisão.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";

// AppVendas — gestão de usuários (criar, editar, resetar senha, excluir).
// Roda com a service role para poder falar com auth.admin.*; a autorização
// de quem pode chamar cada ação é verificada manualmente aqui dentro
// (verify_jwt fica desligado no deploy porque a primeira chamada — criação
// do administrador inicial — acontece sem ninguém logado ainda).
//
// Multiempresas: usuários com papel "caixa" precisam estar vinculados a uma
// empresa ativa (empresa_id obrigatório); administradores podem ficar sem
// empresa (enxergam todas).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Exigido só na criação do primeiro admin (nenhum usuário cadastrado ainda,
// logo ninguém consegue estar logado para essa chamada). Sem isso, quem
// descobrisse a URL do projeto antes do setup real terminar largava na
// frente e virava o primeiro (e único) admin. Ver README, seção AppVendas.
const BOOTSTRAP_SECRET = Deno.env.get("APPVENDAS_BOOTSTRAP_SECRET") || "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const DIACRITICS_RE = new RegExp("[̀-ͯ]", "g");

function sanitizeLogin(raw: string) {
  return String(raw || "")
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  // `admin.auth.getUser(token)` faz uma checagem "ao vivo" contra a sessão no
  // GoTrue (diferente de RLS/auth.uid(), que só decodifica o JWT) — por isso
  // esta é a única rota do app onde uma sessão revogada/expirada aparece como
  // falha (as outras telas falam com o Postgres via RLS, que não confere a
  // sessão). Guardamos separado se "havia token mas a sessão não é mais
  // válida" para não confundir isso com "não é administrador" (ver uso logo
  // abaixo) — um admin de verdade vendo "acesso restrito a administradores"
  // não tem como adivinhar que o problema é sessão expirada, não permissão.
  let caller: { id: string } | null = null;
  let sessaoInvalida = false;
  if (token) {
    const { data, error } = await admin.auth.getUser(token);
    if (!error && data.user) caller = { id: data.user.id };
    else sessaoInvalida = true;
  }

  const { count, error: countError } = await admin
    .from("usuarios")
    .select("id", { count: "exact", head: true });

  if (countError) return json({ error: countError.message }, 500);

  const isBootstrap = (count || 0) === 0;

  let callerIsAdmin = false;
  let callerEmpresaId: string | null = null;
  if (caller && !isBootstrap) {
    const { data: callerRow } = await admin
      .from("usuarios")
      .select("role, ativo, empresa_id")
      .eq("id", caller.id)
      .maybeSingle();
    callerIsAdmin = Boolean(callerRow && callerRow.role === "admin" && callerRow.ativo);
    callerEmpresaId = callerRow?.empresa_id ?? null;
  }
  // Admin "global" = admin sem empresa vinculada — mesmo critério do
  // front-end (auth.js: isGlobalAdmin) e das RLS policies (is_global_admin()
  // na migration 0020). Só ele pode mexer em usuários/empresas fora da
  // própria empresa.
  const callerIsGlobalAdmin = callerIsAdmin && callerEmpresaId === null;

  if (isBootstrap) {
    if (body.action !== "create") {
      return json({ error: "Nenhum usuário cadastrado ainda. Cadastre o primeiro administrador." }, 400);
    }
    if (!BOOTSTRAP_SECRET || String(body.bootstrap_secret || "") !== BOOTSTRAP_SECRET) {
      return json({ error: "Código de inicialização ausente ou incorreto." }, 403);
    }
    body.role = "admin";
  } else if (!callerIsAdmin) {
    const msg = sessaoInvalida
      ? "Sua sessão expirou. Atualize a página e faça login novamente."
      : "Acesso restrito a administradores.";
    return json({ error: msg }, 403);
  }

  // No bootstrap, ninguém está logado ainda (caller é null) — trata como
  // "global admin" para fins de handleCreate, senão a checagem abaixo
  // travaria empresa_id como se fosse um admin de empresa sem empresa.
  const canCreateAcrossEmpresas = isBootstrap || callerIsGlobalAdmin;

  switch (body.action) {
    case "create":
      return await handleCreate(admin, body, canCreateAcrossEmpresas, callerEmpresaId);
    case "update":
      return await handleUpdate(admin, body, caller, callerIsGlobalAdmin, callerEmpresaId);
    case "reset_password":
      return await handleResetPassword(admin, body, callerIsGlobalAdmin, callerEmpresaId);
    case "delete":
      return await handleDelete(admin, body, caller, callerIsGlobalAdmin, callerEmpresaId);
    default:
      return json({ error: "Ação inválida." }, 400);
  }
});

async function validarEmpresa(admin: ReturnType<typeof createClient>, empresaId: string) {
  const { data: empresa } = await admin.from("empresas").select("id, ativo").eq("id", empresaId).maybeSingle();
  return Boolean(empresa && empresa.ativo);
}

async function handleCreate(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  canCreateAcrossEmpresas: boolean,
  callerEmpresaId: string | null,
) {
  const nome = String(body.nome || "").trim();
  const login = sanitizeLogin(String(body.login || ""));
  const senha = String(body.senha || "");
  const role = body.role === "admin" ? "admin" : body.role === "caixa" ? "caixa" : null;

  if (!nome) return json({ error: "Informe o nome." }, 400);
  if (!login) return json({ error: "Informe um usuário (login) válido." }, 400);
  if (senha.length < 6) return json({ error: "A senha deve ter ao menos 6 caracteres." }, 400);
  if (!role) return json({ error: "Papel inválido." }, 400);

  // Admin de empresa só cria usuários dentro da própria empresa — o
  // empresa_id enviado pelo cliente é ignorado nesse caso (mesma trava que
  // a policy de RLS aplica em usuarios_update_admin). Isso também impede um
  // admin de empresa de criar um novo admin GLOBAL diretamente (role
  // "admin" + empresa_id nulo), que era a segunda via para o mesmo
  // escalonamento de privilégio.
  let empresaId: string | null;
  if (!canCreateAcrossEmpresas) {
    empresaId = callerEmpresaId;
  } else {
    const empresaIdRaw = body.empresa_id ? String(body.empresa_id) : null;
    if (role !== "admin" && !empresaIdRaw) {
      return json({ error: "Selecione uma empresa para este usuário." }, 400);
    }
    empresaId = null;
    if (empresaIdRaw) {
      if (!(await validarEmpresa(admin, empresaIdRaw))) {
        return json({ error: "Selecione uma empresa válida." }, 400);
      }
      empresaId = empresaIdRaw;
    }
  }

  // Configurações > Usuários > "Limite de usuários" (empresas.limite_usuarios,
  // roadmap Fase — reestruturação do painel de configurações): checado ANTES
  // de criar a conta no auth, para não deixar um usuário órfão no GoTrue se o
  // limite estiver atingido. Só se aplica quando o usuário fica vinculado a
  // uma empresa — admin global (empresaId nulo) nunca é contado num limite.
  if (empresaId) {
    const { data: empresaCfg } = await admin
      .from("empresas")
      .select("limite_usuarios")
      .eq("id", empresaId)
      .maybeSingle();
    const limite = empresaCfg?.limite_usuarios;
    if (typeof limite === "number" && limite > 0) {
      const { count: usuariosAtivos } = await admin
        .from("usuarios")
        .select("id", { count: "exact", head: true })
        .eq("empresa_id", empresaId)
        .eq("ativo", true);
      if ((usuariosAtivos || 0) >= limite) {
        return json({ error: `Esta empresa atingiu o limite de ${limite} usuário${limite === 1 ? "" : "s"} ativos. Desative outro usuário ou aumente o limite em Administração → Configurações.` }, 400);
      }
    }
  }

  const email = `${login}@appvendas.local`;

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { nome, login },
  });

  if (createError || !created.user) {
    const msg = /already.*registered|already exists/i.test(createError?.message || "")
      ? "Já existe um usuário com este login."
      : createError?.message || "Não foi possível criar o usuário.";
    return json({ error: msg }, 400);
  }

  const { data: row, error: insertError } = await admin
    .from("usuarios")
    .insert({ id: created.user.id, nome, login, role, ativo: true, empresa_id: empresaId })
    .select()
    .single();

  if (insertError) {
    await admin.auth.admin.deleteUser(created.user.id);
    const msg = insertError.code === "23505" ? "Já existe um usuário com este login." : insertError.message;
    return json({ error: msg }, 400);
  }

  return json({ usuario: row });
}

async function handleUpdate(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  caller: { id: string } | null,
  callerIsGlobalAdmin: boolean,
  callerEmpresaId: string | null,
) {
  const id = String(body.id || "");
  if (!id) return json({ error: "Usuário inválido." }, 400);

  const { data: currentRow, error: currentError } = await admin
    .from("usuarios")
    .select("role, empresa_id")
    .eq("id", id)
    .maybeSingle();
  if (currentError) return json({ error: currentError.message }, 400);
  if (!currentRow) return json({ error: "Usuário não encontrado." }, 400);

  // Admin de empresa só gerencia usuários da própria empresa — mesma trava
  // da policy usuarios_update_admin (migration 0020).
  if (!callerIsGlobalAdmin && currentRow.empresa_id !== callerEmpresaId) {
    return json({ error: "Você só pode gerenciar usuários da sua própria empresa." }, 403);
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.nome === "string" && body.nome.trim()) patch.nome = body.nome.trim();
  if (body.role === "admin" || body.role === "caixa") patch.role = body.role;
  if (typeof body.ativo === "boolean") patch.ativo = body.ativo;

  const effectiveRole = (patch.role as string) || currentRow.role;

  let effectiveEmpresaId: string | null;
  if (!callerIsGlobalAdmin) {
    // Admin de empresa nunca move um usuário para fora da própria empresa
    // nem o transforma em admin global — o empresa_id enviado pelo cliente
    // é ignorado, travado na empresa de quem está chamando.
    effectiveEmpresaId = callerEmpresaId;
    patch.empresa_id = callerEmpresaId;
  } else {
    const empresaProvided = Object.prototype.hasOwnProperty.call(body, "empresa_id");
    const empresaIdRaw = empresaProvided && body.empresa_id ? String(body.empresa_id) : null;
    effectiveEmpresaId = empresaProvided ? empresaIdRaw : currentRow.empresa_id;

    if (empresaProvided) {
      if (empresaIdRaw) {
        if (!(await validarEmpresa(admin, empresaIdRaw))) {
          return json({ error: "Selecione uma empresa válida." }, 400);
        }
      }
      patch.empresa_id = empresaIdRaw;
    }
  }

  if (effectiveRole !== "admin" && !effectiveEmpresaId) {
    return json({ error: "Selecione uma empresa para este usuário." }, 400);
  }

  if (caller && caller.id === id) {
    if (patch.role && patch.role !== "admin") {
      return json({ error: "Não é possível remover seu próprio papel de administrador." }, 400);
    }
    if (patch.ativo === false) {
      return json({ error: "Não é possível desativar o próprio usuário." }, 400);
    }
  }

  if (Object.keys(patch).length === 0) return json({ error: "Nada para atualizar." }, 400);

  const { data, error } = await admin.from("usuarios").update(patch).eq("id", id).select().single();
  if (error) return json({ error: error.message }, 400);
  return json({ usuario: data });
}

async function checkMesmaEmpresa(
  admin: ReturnType<typeof createClient>,
  id: string,
  callerIsGlobalAdmin: boolean,
  callerEmpresaId: string | null,
) {
  if (callerIsGlobalAdmin) return null;
  const { data: targetRow } = await admin.from("usuarios").select("empresa_id").eq("id", id).maybeSingle();
  if (!targetRow || targetRow.empresa_id !== callerEmpresaId) {
    return json({ error: "Você só pode gerenciar usuários da sua própria empresa." }, 403);
  }
  return null;
}

async function handleResetPassword(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  callerIsGlobalAdmin: boolean,
  callerEmpresaId: string | null,
) {
  const id = String(body.id || "");
  const senha = String(body.senha || "");
  if (!id) return json({ error: "Usuário inválido." }, 400);
  if (senha.length < 6) return json({ error: "A senha deve ter ao menos 6 caracteres." }, 400);

  const forbidden = await checkMesmaEmpresa(admin, id, callerIsGlobalAdmin, callerEmpresaId);
  if (forbidden) return forbidden;

  const { error } = await admin.auth.admin.updateUserById(id, { password: senha });
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}

async function handleDelete(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  caller: { id: string } | null,
  callerIsGlobalAdmin: boolean,
  callerEmpresaId: string | null,
) {
  const id = String(body.id || "");
  if (!id) return json({ error: "Usuário inválido." }, 400);
  if (caller && caller.id === id) return json({ error: "Não é possível excluir o próprio usuário." }, 400);

  const forbidden = await checkMesmaEmpresa(admin, id, callerIsGlobalAdmin, callerEmpresaId);
  if (forbidden) return forbidden;

  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
}
