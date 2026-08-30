// Versão exata pinada (mesmo motivo das outras edge functions do app): uma
// release nova do supabase-js não deve entrar em produção sem passar por um
// commit e revisão.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";

// AppVendas — Roadmap Fase 3: uma proposta enviada já dispara e-mail pro
// cliente (enviar-proposta); uma venda ou matrícula fechada, não. Esta
// function reaproveita a MESMA infra Resend pra mandar um recibo simples,
// fechando o ciclo de comunicação em vez de deixá-lo pela metade.
//
// Chamada de forma best-effort pelo front (vendas.js/matriculas.js, no
// mesmo ponto — finalizarComSucesso — que já cobre tanto o fechamento em
// dinheiro/cartão quanto a confirmação via webhook do Stripe): nunca deve
// travar nem "errar" o fluxo de venda/matrícula por trás. Por isso quase
// todo caminho aqui devolve `{ ok: true, sent: false, motivo }` em vez de
// um erro HTTP — só entrada inválida (tipo/id ausentes) é 400 de verdade.
//
// Chamado autenticado (verify_jwt ligado, padrão): o cliente Supabase
// abaixo carrega o registro com o JWT de quem chamou, então a RLS de
// vendas/matriculas garante sozinha que só é possível confirmar negócio da
// própria empresa (ou de qualquer uma, se admin global) — mesmo racional de
// enviar-proposta/create-stripe-checkout.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

// Precisa ser um endereço de um domínio verificado no SEU Resend — o
// endereço sandbox onboarding@resend.dev só entrega de fato para o e-mail
// dono da conta Resend, então todo recibo para um cliente real falharia com
// 403 (validation_error). Configure com
// `supabase secrets set RESEND_FROM_ADDRESS=notificacoes@seudominio.com`
// (ver scripts/README.md). Nome de exibição segue dinâmico por empresa
// (mesmo padrão de enviar-proposta/appvendas-lembretes).
const RESEND_ADDRESS = Deno.env.get("RESEND_FROM_ADDRESS") || "onboarding@resend.dev";
const RESEND_FROM_PADRAO = "ERPConnect";
function nomeRemetente(nome: string | null | undefined): string {
  const limpo = (nome || RESEND_FROM_PADRAO).replace(/[<>"]/g, "").trim();
  return limpo || RESEND_FROM_PADRAO;
}

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

function escapeHtml(str: unknown): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

function formatCurrencyBRL(value: number): string {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(isoDate: string | null): string {
  if (!isoDate) return "—";
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("pt-BR");
}

async function enviarEmail(to: string, subject: string, html: string, fromName = RESEND_FROM_PADRAO): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: `${nomeRemetente(fromName)} <${RESEND_ADDRESS}>`, to: [to], subject, html }),
    });
    if (!res.ok) {
      console.error("Resend error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Falha ao chamar Resend:", err);
    return false;
  }
}

function envelope(empresaNome: string, corpo: string, rodape: string | null | undefined): string {
  return `
    <div style="font-family: Arial, sans-serif; color:#222; max-width:600px; margin:0 auto;">
      <h2 style="margin-bottom:0;">${escapeHtml(empresaNome)}</h2>
      ${corpo}
      <p style="margin-top:24px; color:#666; font-size:13px;">Qualquer dúvida, é só responder este e-mail.</p>
      ${rodape ? `<p style="margin-top:12px; padding-top:12px; border-top:1px solid #e5e5e5; color:#888; font-size:12px;">${escapeHtml(rodape).replace(/\n/g, "<br>")}</p>` : ""}
    </div>
  `;
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

  const tipo = body.tipo === "matricula" ? "matricula" : body.tipo === "venda" ? "venda" : null;
  const id = String(body.id || "");
  if (!tipo || !id) return json({ error: "Informe tipo ('venda' ou 'matricula') e id." }, 400);

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  if (tipo === "venda") return await confirmarVenda(supabaseAsUser, id);
  return await confirmarMatricula(supabaseAsUser, id);
});

async function confirmarVenda(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  vendaId: string,
) {
  const { data: venda, error } = await supabase
    .from("vendas")
    .select(
      "id, numero, data_venda, status, forma_pagamento, subtotal, desconto, total, " +
        "cliente:clientes(nome, email), empresa:empresas(nome_fantasia, nome_aplicacao, rodape_documentos)",
    )
    .eq("id", vendaId)
    .maybeSingle();

  if (error) return json({ error: error.message }, 400);
  if (!venda) return json({ ok: true, sent: false, motivo: "Venda não encontrada." });
  if (venda.status !== "confirmada") return json({ ok: true, sent: false, motivo: "Venda ainda não confirmada." });

  const email = venda.cliente?.email;
  if (!email) return json({ ok: true, sent: false, motivo: "Cliente sem e-mail cadastrado." });

  const { data: itens } = await supabase
    .from("venda_itens")
    .select("quantidade, preco_unitario, subtotal, produto:produtos(nome)")
    .eq("venda_id", vendaId)
    .order("created_at", { ascending: true });

  const empresaNome = venda.empresa?.nome_aplicacao || venda.empresa?.nome_fantasia || "ERPConnect";
  const nomeCliente = venda.cliente?.nome || "Cliente";

  const linhasHtml = (itens ?? [])
    // deno-lint-ignore no-explicit-any
    .map((i: any) => `
      <tr>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5;">${escapeHtml(i.produto?.nome || "Produto")}</td>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; text-align:center;">${i.quantidade}</td>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; text-align:right;">${formatCurrencyBRL(i.subtotal)}</td>
      </tr>
    `)
    .join("");

  const corpo = `
    <p style="color:#666; margin-top:4px;">Recibo da venda nº ${venda.numero}</p>
    <p>Olá, ${escapeHtml(nomeCliente)}!</p>
    <p>Confirmamos sua compra${venda.forma_pagamento ? ` — pagamento em <strong>${escapeHtml(venda.forma_pagamento)}</strong>` : ""}, realizada em ${formatDateBR(venda.data_venda)}.</p>
    <table style="width:100%; border-collapse:collapse; margin:16px 0;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:6px 8px; text-align:left;">Produto</th>
          <th style="padding:6px 8px; text-align:center;">Qtd.</th>
          <th style="padding:6px 8px; text-align:right;">Subtotal</th>
        </tr>
      </thead>
      <tbody>${linhasHtml}</tbody>
    </table>
    <table style="width:100%; max-width:260px; margin-left:auto; font-size:14px;">
      <tr><td style="color:#666;">Subtotal</td><td style="text-align:right;">${formatCurrencyBRL(venda.subtotal)}</td></tr>
      <tr><td style="color:#666;">Desconto</td><td style="text-align:right;">${formatCurrencyBRL(venda.desconto)}</td></tr>
      <tr><td style="font-weight:bold; padding-top:6px;">Total</td><td style="text-align:right; font-weight:bold; padding-top:6px;">${formatCurrencyBRL(venda.total)}</td></tr>
    </table>
  `;

  const enviado = await enviarEmail(email, `Recibo da compra #${venda.numero} — ${empresaNome}`, envelope(empresaNome, corpo, venda.empresa?.rodape_documentos), empresaNome);
  return json({ ok: true, sent: enviado });
}

async function confirmarMatricula(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  matriculaId: string,
) {
  const { data: matricula, error } = await supabase
    .from("matriculas")
    .select(
      "id, numero, data_matricula, status, forma_pagamento, meses, numero_parcelas, valor_mensalidade, desconto, valor_total, " +
        "produto:produtos(nome), cliente:clientes(nome, email), empresa:empresas(nome_fantasia, nome_aplicacao, rodape_documentos)",
    )
    .eq("id", matriculaId)
    .maybeSingle();

  if (error) return json({ error: error.message }, 400);
  if (!matricula) return json({ ok: true, sent: false, motivo: "Matrícula não encontrada." });
  if (matricula.status === "aguardando_pagamento") return json({ ok: true, sent: false, motivo: "Matrícula ainda aguardando pagamento." });

  const email = matricula.cliente?.email;
  if (!email) return json({ ok: true, sent: false, motivo: "Cliente sem e-mail cadastrado." });

  const empresaNome = matricula.empresa?.nome_aplicacao || matricula.empresa?.nome_fantasia || "ERPConnect";
  const nomeCliente = matricula.cliente?.nome || "Cliente";
  const nomeProduto = matricula.produto?.nome || "Serviço";

  const corpo = `
    <p style="color:#666; margin-top:4px;">Confirmação de matrícula nº ${matricula.numero}</p>
    <p>Olá, ${escapeHtml(nomeCliente)}!</p>
    <p>Sua matrícula em <strong>${escapeHtml(nomeProduto)}</strong> foi confirmada em ${formatDateBR(matricula.data_matricula)}.</p>
    <table style="width:100%; margin-top:16px; font-size:14px;">
      <tr><td style="color:#666; padding:2px 0;">Duração</td><td>${matricula.meses} mês${matricula.meses === 1 ? "" : "es"}</td></tr>
      <tr><td style="color:#666; padding:2px 0;">Parcelamento</td><td>${matricula.numero_parcelas}x de ${formatCurrencyBRL(matricula.valor_mensalidade)}</td></tr>
      ${matricula.forma_pagamento ? `<tr><td style="color:#666; padding:2px 0;">Forma de pagamento</td><td>${escapeHtml(matricula.forma_pagamento)}</td></tr>` : ""}
      <tr><td style="font-weight:bold; padding-top:8px;">Valor total</td><td style="font-weight:bold; padding-top:8px;">${formatCurrencyBRL(matricula.valor_total)}</td></tr>
    </table>
  `;

  const enviado = await enviarEmail(email, `Matrícula confirmada #${matricula.numero} — ${empresaNome}`, envelope(empresaNome, corpo, matricula.empresa?.rodape_documentos), empresaNome);
  return json({ ok: true, sent: enviado });
}
