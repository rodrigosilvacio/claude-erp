// ERPConnect — sessão, login/logout e checagem de permissões.
//
// Login é feito com "usuário" (não e-mail): mapeamos para um e-mail interno
// fictício (usuario@appvendas.local) porque o Supabase Auth exige e-mail —
// a mesma conversão é feita no back-end (edge function manage-usuarios) na
// hora de criar a conta, então login e senha continuam sendo o único dado
// que a pessoa realmente digita.

import { supabase } from "./supabaseClient.js";

const EMAIL_DOMAIN = "appvendas.local";
const DIACRITICS_RE = /[̀-ͯ]/g;

export function sanitizeLogin(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
}

let currentSession = null;
let currentUsuario = null;
let ready = false;
const listeners = new Set();

async function loadUsuario(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from("usuarios")
    .select("id, nome, login, role, ativo, empresa_id, empresa:empresas(nome_aplicacao, menus_habilitados, horarios_agenda, cor_primaria, papel_padrao_novo_usuario)")
    .eq("id", userId)
    .maybeSingle();
  return data || null;
}

// Revalida periodicamente se a conta logada continua ativa, sem depender só
// da renovação de token (que só acontece ~1x por hora). Se um admin desativar
// alguém com sessão aberta, essa checagem derruba a sessão em até 1 minuto —
// sem re-renderizar nada enquanto a conta continuar ativa.
let ativoWatchTimer = null;
let ativoWatchFocusHandler = null;

function startAtivoWatch(userId) {
  stopAtivoWatch();
  const check = async () => {
    if (document.hidden) return;
    const { data } = await supabase.from("usuarios").select("ativo").eq("id", userId).maybeSingle();
    if (!data || !data.ativo) await signOut();
  };
  ativoWatchTimer = setInterval(check, 60000);
  ativoWatchFocusHandler = check;
  window.addEventListener("focus", ativoWatchFocusHandler);
}

function stopAtivoWatch() {
  if (ativoWatchTimer) {
    clearInterval(ativoWatchTimer);
    ativoWatchTimer = null;
  }
  if (ativoWatchFocusHandler) {
    window.removeEventListener("focus", ativoWatchFocusHandler);
    ativoWatchFocusHandler = null;
  }
}

// Chaveado pelo access_token da sessão sendo aplicada. Isso evita trabalho e
// re-render duplicados quando o mesmo login dispara duas notificações (o
// refresh manual em signIn() + o evento SIGNED_IN automático chegando logo
// em seguida) — mas, ao contrário de só comparar e pular a segunda chamada,
// aqui ela reaproveita a MESMA promise em andamento. Isso importa: se só
// pulássemos a segunda chamada, um caller que dependesse dela (como
// signIn() checando se a conta está ativa) poderia seguir em frente antes
// da primeira chamada terminar de buscar o usuário — foi exatamente esse
// race que fazia logins válidos serem derrubados como "conta desativada".
let refreshToken = null;
let refreshPromise = null;

function refresh(session) {
  const nextSession = session || null;
  const token = nextSession ? nextSession.access_token : null;

  if (token === refreshToken) {
    return refreshPromise || Promise.resolve();
  }

  refreshToken = token;
  refreshPromise = (async () => {
    currentSession = nextSession;
    currentUsuario = currentSession ? await loadUsuario(currentSession.user.id) : null;

    if (currentSession && currentUsuario && currentUsuario.ativo) {
      startAtivoWatch(currentSession.user.id);
    } else {
      stopAtivoWatch();
    }

    listeners.forEach((fn) => fn());
  })();

  return refreshPromise;
}

export function onAuthChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

let initPromise = null;

export function initAuth() {
  if (!initPromise) {
    initPromise = (async () => {
      const { data } = await supabase.auth.getSession();
      await refresh(data.session);
      ready = true;
      supabase.auth.onAuthStateChange((event, session) => {
        // INITIAL_SESSION já foi tratado pelo getSession() acima. TOKEN_REFRESHED
        // acontece em segundo plano só pra renovar o JWT — o usuário continua o
        // mesmo, então não há motivo pra re-renderizar a tela (isso já causou
        // perda de carrinho em andamento na tela de Vendas). Só atualizamos o
        // token em memória e seguimos.
        if (event === "INITIAL_SESSION") return;
        if (event === "TOKEN_REFRESHED") {
          if (session) {
            currentSession = session;
            refreshToken = session.access_token;
          }
          return;
        }
        refresh(session);
      });
    })();
  }
  return initPromise;
}

export function isAuthReady() {
  return ready;
}

export function getCurrentUsuario() {
  return currentUsuario;
}

// Bug corrigido: papel/empresa/menus do usuário só eram recarregados no
// login — se um admin promovesse alguém a admin global (ou mudasse
// menus_habilitados) enquanto essa pessoa já estava com o app aberto,
// isAdmin()/isGlobalAdmin() continuavam respondendo com o valor antigo até
// um F5 (o único recarregamento periódico, ativoWatch, só confere
// `ativo`). Usado por app.js como uma segunda checagem, só no momento em
// que uma navegação seria bloqueada — não é chamado a cada rota, então não
// arrisca interromper um formulário em andamento em outra tela.
export async function refreshCurrentUsuario() {
  if (!currentSession) return null;
  const atualizado = await loadUsuario(currentSession.user.id);
  if (atualizado) currentUsuario = atualizado;
  return currentUsuario;
}

export function isLoggedIn() {
  return Boolean(currentSession && currentUsuario && currentUsuario.ativo);
}

export function isAdmin() {
  return Boolean(currentUsuario && currentUsuario.role === "admin" && currentUsuario.ativo);
}

// Admin não vinculado a nenhuma empresa (empresa_id nulo) — o único papel que
// pode configurar a "casca" do app (nome exibido + menus) de qualquer
// empresa. Um admin vinculado a uma empresa específica passa em isAdmin() mas
// não neste.
export function isGlobalAdmin() {
  return Boolean(isAdmin() && currentUsuario.empresa_id == null);
}

export function getCurrentEmpresaId() {
  return currentUsuario ? currentUsuario.empresa_id ?? null : null;
}

export async function signIn(login, senha) {
  const email = `${sanitizeLogin(login)}@${EMAIL_DOMAIN}`;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });

  if (error) {
    const message = /invalid login credentials/i.test(error.message)
      ? "Usuário ou senha inválidos."
      : error.message;
    throw new Error(message);
  }

  await refresh(data.session);

  if (!currentUsuario || !currentUsuario.ativo) {
    await supabase.auth.signOut();
    await refresh(null);
    throw new Error("Este usuário está desativado. Fale com um administrador.");
  }

  return currentUsuario;
}

export async function signOut() {
  await supabase.auth.signOut();
  await refresh(null);
}

export async function callManageUsuarios(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke("manage-usuarios", {
    body: { action, ...payload },
  });

  if (error) {
    let message = error.message;
    try {
      const body = await error.context.json();
      if (body?.error) message = body.error;
    } catch {
      // resposta não era JSON — mantém a mensagem original do erro de rede
    }
    throw new Error(message);
  }

  if (data?.error) throw new Error(data.error);
  return data;
}
