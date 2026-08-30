import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";
import Stripe from "https://esm.sh/stripe@17.4.0?target=deno";

// AppVendas — cria uma Stripe Checkout Session para uma venda OU para a 1ª
// parcela de uma matrícula com forma de pagamento "Stripe" (`p_tipo`, ver
// abaixo — "venda" é o padrão, mantém compatibilidade com chamadas antigas
// sem o campo). Fluxo "link/QR": o cliente paga pelo próprio celular (o app
// nunca vê dados de cartão), então o registro nasce como
// 'aguardando_pagamento' e só vira 'confirmada'/'ativa' quando o webhook
// stripe-webhook recebe a confirmação do Stripe — ver migration 0013
// (vendas) e 0015 (matriculas).
//
// Matrícula parcelada + Stripe: uma Checkout Session é cobrança única, não
// assinatura recorrente — por isso só a 1ª parcela é cobrada aqui; as
// demais nascem como títulos a receber com vencimento futuro (ver
// criar_matricula) e são recebidas manualmente depois.
//
// Chamado autenticado (verify_jwt ligado no deploy): o cliente Supabase
// abaixo é criado com o JWT de quem chamou, então is_admin()/
// current_empresa_id() dentro de criar_venda/criar_matricula funcionam
// exatamente como na chamada direta da RPC (mesma checagem de
// empresa/permissão).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

// Tempo de vida do QR/link — curto de propósito (mínimo aceito pelo Stripe
// é 30 min): isso é um pagamento de balcão, não faz sentido um QR de venda
// continuar válido horas depois. Ao expirar, o Stripe manda
// checkout.session.expired e o webhook cancela a venda automaticamente.
const CHECKOUT_EXPIRES_IN_SECONDS = 30 * 60;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const successUrl = typeof body.success_url === "string" ? body.success_url : "";
  const cancelUrl = typeof body.cancel_url === "string" ? body.cancel_url : "";
  if (!/^https?:\/\//.test(successUrl) || !/^https?:\/\//.test(cancelUrl)) {
    return json({ error: "success_url/cancel_url inválidos." }, 400);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  const tipo = body.p_tipo === "matricula" ? "matricula" : "venda";

  if (tipo === "matricula") {
    return await criarCheckoutMatricula(supabaseAsUser, body, successUrl, cancelUrl);
  }
  return await criarCheckoutVenda(supabaseAsUser, body, successUrl, cancelUrl);
});

async function criarCheckoutVenda(
  supabaseAsUser: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  successUrl: string,
  cancelUrl: string,
) {
  const { data: vendaId, error: criarError } = await supabaseAsUser.rpc("criar_venda", {
    p_cliente_id: body.p_cliente_id ?? null,
    p_data_venda: body.p_data_venda ?? null,
    p_forma_pagamento: "Stripe",
    p_observacoes: body.p_observacoes ?? null,
    p_desconto: body.p_desconto ?? 0,
    p_itens: body.p_itens ?? [],
    p_empresa_id: body.p_empresa_id ?? null,
    p_status: "aguardando_pagamento",
    // Proposta do CRM de origem (se houver) — criar_venda resolve o preço
    // negociado sozinha a partir dela; preco_unitario vindo em p_itens é
    // só um valor de exibição, nunca é usado para cobrar (ver migration
    // 0044).
    p_proposta_id: body.p_proposta_id ?? null,
  });

  if (criarError || !vendaId) {
    return json({ error: criarError?.message || "Não foi possível criar a venda." }, 400);
  }

  const { data: venda, error: vendaError } = await supabaseAsUser
    .from("vendas")
    .select("numero, total")
    .eq("id", vendaId)
    .single();

  if (vendaError || !venda) {
    await supabaseAsUser.rpc("cancelar_venda", { p_venda_id: vendaId });
    return json({ error: "Venda criada, mas não foi possível lê-la de volta." }, 500);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: vendaId,
      metadata: { tipo: "venda", venda_id: vendaId },
      line_items: [
        {
          price_data: {
            currency: "brl",
            product_data: { name: `Venda #${venda.numero}` },
            unit_amount: Math.round(Number(venda.total) * 100),
          },
          quantity: 1,
        },
      ],
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_IN_SECONDS,
      success_url: `${successUrl}${successUrl.includes("?") ? "&" : "?"}venda=${vendaId}`,
      cancel_url: `${cancelUrl}${cancelUrl.includes("?") ? "&" : "?"}venda=${vendaId}`,
    });

    return json({ url: session.url, venda_id: vendaId, numero: venda.numero });
  } catch (err) {
    console.error("Falha ao criar Stripe Checkout Session:", err);
    // A venda já existe como 'aguardando_pagamento' — sem sessão do Stripe
    // associada ela nunca seria confirmada nem expiraria sozinha, então
    // desfaz aqui mesmo em vez de deixar uma pendência órfã.
    await supabaseAsUser.rpc("cancelar_venda", { p_venda_id: vendaId });
    return json({ error: "Não foi possível iniciar o pagamento no Stripe." }, 502);
  }
}

// Matrícula: a Checkout Session cobra só a 1ª parcela (criar_matricula já
// deixa todas as parcelas como 'pendente' quando p_status é
// 'aguardando_pagamento' — a parcela 1 só vira 'pago' na confirmação do
// webhook, ver confirmar_pagamento_stripe_matricula).
async function criarCheckoutMatricula(
  supabaseAsUser: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  successUrl: string,
  cancelUrl: string,
) {
  const { data: matriculaId, error: criarError } = await supabaseAsUser.rpc("criar_matricula", {
    p_cliente_id: body.p_cliente_id ?? null,
    p_produto_id: body.p_produto_id ?? null,
    p_meses: body.p_meses ?? null,
    p_numero_parcelas: body.p_numero_parcelas ?? null,
    p_forma_pagamento: "Stripe",
    p_data_matricula: body.p_data_matricula ?? null,
    p_desconto: body.p_desconto ?? 0,
    p_observacoes: body.p_observacoes ?? null,
    p_empresa_id: body.p_empresa_id ?? null,
    p_status: "aguardando_pagamento",
    // Proposta do CRM de origem (ver crm.js/matriculas.js) — sem isso, uma
    // matrícula convertida via Stripe cobraria o preço de catálogo do
    // curso, ignorando o que foi negociado na proposta. criar_matricula
    // resolve o valor negociado sozinha a partir dela, nunca a partir de um
    // número solto vindo do cliente (ver migration 0044).
    p_proposta_id: body.p_proposta_id ?? null,
  });

  if (criarError || !matriculaId) {
    return json({ error: criarError?.message || "Não foi possível criar a matrícula." }, 400);
  }

  const { data: parcela1, error: parcelaError } = await supabaseAsUser
    .from("matricula_parcelas")
    .select("valor, matricula:matriculas(numero, numero_parcelas)")
    .eq("matricula_id", matriculaId)
    .eq("numero_parcela", 1)
    .single();

  if (parcelaError || !parcela1) {
    await supabaseAsUser.rpc("cancelar_matricula", { p_matricula_id: matriculaId });
    return json({ error: "Matrícula criada, mas não foi possível ler a 1ª parcela." }, 500);
  }

  const numero = parcela1.matricula?.numero;
  const numeroParcelas = parcela1.matricula?.numero_parcelas;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      client_reference_id: matriculaId,
      metadata: { tipo: "matricula", matricula_id: matriculaId },
      line_items: [
        {
          price_data: {
            currency: "brl",
            product_data: { name: `Matrícula #${numero} — parcela 1/${numeroParcelas}` },
            unit_amount: Math.round(Number(parcela1.valor) * 100),
          },
          quantity: 1,
        },
      ],
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_IN_SECONDS,
      success_url: `${successUrl}${successUrl.includes("?") ? "&" : "?"}matricula=${matriculaId}`,
      cancel_url: `${cancelUrl}${cancelUrl.includes("?") ? "&" : "?"}matricula=${matriculaId}`,
    });

    return json({ url: session.url, matricula_id: matriculaId, numero });
  } catch (err) {
    console.error("Falha ao criar Stripe Checkout Session:", err);
    await supabaseAsUser.rpc("cancelar_matricula", { p_matricula_id: matriculaId });
    return json({ error: "Não foi possível iniciar o pagamento no Stripe." }, 502);
  }
}
