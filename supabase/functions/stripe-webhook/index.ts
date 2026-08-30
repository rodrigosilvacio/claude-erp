import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";
import Stripe from "https://esm.sh/stripe@17.4.0?target=deno";

// AppVendas — recebe eventos do Stripe sobre as Checkout Sessions criadas
// por create-stripe-checkout e confirma (ou cancela) a venda ou a matrícula
// pendente correspondente — `session.metadata.tipo` (setado no create-
// stripe-checkout) decide qual RPC chamar; sessões antigas sem esse campo
// são tratadas como "venda" por compatibilidade. Ver migration 0013/0015 e
// supabase/functions/create-stripe-checkout.
//
// Endpoint público (deploy com --no-verify-jwt, quem chama é o Stripe, não
// um cliente Supabase autenticado) — a segurança é a verificação de
// assinatura abaixo (cabeçalho stripe-signature + STRIPE_WEBHOOK_SECRET),
// mesmo papel que o "?secret=" cumpre em oraculo-webhook, só que aqui é o
// mecanismo padrão do próprio Stripe em vez de um secret nosso.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});
// Verificação de assinatura usa SubtleCrypto (Deno não tem o módulo `crypto`
// nativo do Node que o SDK usa por padrão) — provider oficial do próprio
// SDK do Stripe para runtimes tipo Deno/edge.
const cryptoProvider = Stripe.createSubtleCryptoProvider();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const signature = req.headers.get("stripe-signature");
  if (!signature) return json({ error: "Assinatura ausente." }, 400);

  // Precisa do corpo cru (não JSON.parse) — a assinatura é calculada sobre
  // os bytes exatos recebidos.
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    console.error("Assinatura do webhook do Stripe inválida:", err);
    return json({ error: "Assinatura inválida." }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function confirmar(session: Stripe.Checkout.Session) {
    const referenceId = session.client_reference_id;
    if (!referenceId) {
      console.error("checkout.session sem client_reference_id:", session.id);
      return;
    }
    const paymentIntentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? null;

    if (session.metadata?.tipo === "matricula") {
      const { error } = await supabase.rpc("confirmar_pagamento_stripe_matricula", {
        p_matricula_id: referenceId,
        p_stripe_checkout_session_id: session.id,
        p_stripe_payment_intent_id: paymentIntentId,
      });
      if (error) console.error("Falha ao confirmar pagamento da matrícula", referenceId, error);
      return;
    }

    const { error } = await supabase.rpc("confirmar_pagamento_stripe", {
      p_venda_id: referenceId,
      p_stripe_checkout_session_id: session.id,
      p_stripe_payment_intent_id: paymentIntentId,
    });
    if (error) console.error("Falha ao confirmar pagamento da venda", referenceId, error);
  }

  async function marcarFalhou(session: Stripe.Checkout.Session) {
    const referenceId = session.client_reference_id;
    if (!referenceId) return;

    if (session.metadata?.tipo === "matricula") {
      const { error } = await supabase.rpc("marcar_stripe_pagamento_falhou_matricula", { p_matricula_id: referenceId });
      if (error) console.error("Falha ao marcar pagamento como não concluído para a matrícula", referenceId, error);
      return;
    }

    const { error } = await supabase.rpc("marcar_stripe_pagamento_falhou", { p_venda_id: referenceId });
    if (error) console.error("Falha ao marcar pagamento como não concluído para a venda", referenceId, error);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      // Métodos instantâneos (cartão) já chegam com payment_status "paid"
      // neste evento; métodos assíncronos (ex.: boleto) completam a sessão
      // mas só pagam de fato depois, via checkout.session.async_payment_succeeded.
      if (session.payment_status === "paid") await confirmar(session);
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      await confirmar(event.data.object as Stripe.Checkout.Session);
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      await marcarFalhou(event.data.object as Stripe.Checkout.Session);
      break;
    }
    default:
      // Evento que não precisamos tratar — 200 pra não gerar retry do Stripe.
      break;
  }

  return json({ received: true });
});
