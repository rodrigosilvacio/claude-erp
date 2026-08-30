// Versão exata pinada (mesmo motivo de manage-usuarios/appvendas-lembretes):
// uma release nova do supabase-js não deve entrar em produção sem passar por
// um commit e revisão.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";

// AppVendas — CRM: envia uma proposta por e-mail ao contato (cliente
// cadastrado ou lead) e marca a proposta como "enviada" se ainda estiver em
// rascunho. Reaproveita a MESMA infra de e-mail já usada pelo Oráculo/
// appvendas-lembretes (Resend) — não é uma secret nova.
//
// Chamado autenticado (verify_jwt ligado no deploy, padrão — diferente de
// manage-usuarios/appvendas-lembretes): o cliente Supabase abaixo carrega a
// proposta com o JWT de quem chamou, então a RLS de `propostas`/
// `proposta_itens` garante sozinha que só é possível enviar propostas da
// própria empresa (ou de qualquer uma, se admin global) — mesmo racional de
// create-stripe-checkout.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

// Precisa ser um endereço de um domínio verificado no SEU Resend — o
// endereço sandbox onboarding@resend.dev só entrega de fato para o e-mail
// dono da conta Resend, então enviar propostas a clientes reais com ele
// sempre falha com 403 (validation_error). Configure com
// `supabase secrets set RESEND_FROM_ADDRESS=notificacoes@seudominio.com`
// (ver scripts/README.md). Nome de exibição segue dinâmico por empresa,
// igual ao appvendas-lembretes/enviar-confirmacao-negocio.
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  const propostaId = String(body.proposta_id || "");
  if (!propostaId) return json({ error: "Informe a proposta." }, 400);

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseAsUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: proposta, error: propostaError } = await supabaseAsUser
    .from("propostas")
    .select(
      "id, numero, tipo_contato, lead_nome, contato_email, contato_telefone, data_proposta, validade_ate, condicoes_pagamento, prazo_entrega, observacoes, subtotal, desconto, total, status, " +
        "cliente:clientes(nome, email), empresa:empresas(nome_fantasia, nome_aplicacao, rodape_documentos), vendedor:usuarios(nome)",
    )
    .eq("id", propostaId)
    .maybeSingle();

  if (propostaError) return json({ error: propostaError.message }, 400);
  if (!proposta) return json({ error: "Proposta não encontrada." }, 404);

  const { data: itens, error: itensError } = await supabaseAsUser
    .from("proposta_itens")
    .select("quantidade, preco_unitario, subtotal, observacao, produto:produtos(nome)")
    .eq("proposta_id", propostaId)
    .order("created_at", { ascending: true });

  if (itensError) return json({ error: itensError.message }, 400);

  // deno-lint-ignore no-explicit-any
  const p = proposta as any;
  const destinatario = p.tipo_contato === "cliente" ? (p.cliente?.email || p.contato_email) : p.contato_email;
  if (!destinatario) {
    return json({ error: "Este contato não tem e-mail cadastrado. Preencha um e-mail na proposta antes de enviar." }, 400);
  }

  const nomeContato = p.tipo_contato === "cliente" ? (p.cliente?.nome || "Cliente") : (p.lead_nome || "Contato");
  const empresaNome = p.empresa?.nome_aplicacao || p.empresa?.nome_fantasia || "ERPConnect";
  const vendedorNome = p.vendedor?.nome || null;

  const linhasHtml = (itens ?? [])
    // deno-lint-ignore no-explicit-any
    .map((i: any) => `
      <tr>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5;">${escapeHtml(i.produto?.nome || "Produto")}${i.observacao ? `<br><span style="color:#888; font-size:12px;">${escapeHtml(i.observacao)}</span>` : ""}</td>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; text-align:center;">${i.quantidade}</td>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; text-align:right;">${formatCurrencyBRL(i.preco_unitario)}</td>
        <td style="padding:6px 8px; border-bottom:1px solid #e5e5e5; text-align:right;">${formatCurrencyBRL(i.subtotal)}</td>
      </tr>
    `)
    .join("");

  const html = `
    <div style="font-family: Arial, sans-serif; color:#222; max-width:620px; margin:0 auto;">
      <h2 style="margin-bottom:0;">${escapeHtml(empresaNome)}</h2>
      <p style="color:#666; margin-top:4px;">Proposta comercial nº ${p.numero}</p>
      <p>Olá, ${escapeHtml(nomeContato)}!</p>
      <p>Segue abaixo a proposta solicitada${vendedorNome ? `, preparada por <strong>${escapeHtml(vendedorNome)}</strong>` : ""}.</p>

      <table style="width:100%; border-collapse:collapse; margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:6px 8px; text-align:left;">Produto</th>
            <th style="padding:6px 8px; text-align:center;">Qtd.</th>
            <th style="padding:6px 8px; text-align:right;">Preço</th>
            <th style="padding:6px 8px; text-align:right;">Subtotal</th>
          </tr>
        </thead>
        <tbody>${linhasHtml}</tbody>
      </table>

      <table style="width:100%; max-width:260px; margin-left:auto; font-size:14px;">
        <tr><td style="color:#666;">Subtotal</td><td style="text-align:right;">${formatCurrencyBRL(p.subtotal)}</td></tr>
        <tr><td style="color:#666;">Desconto</td><td style="text-align:right;">${formatCurrencyBRL(p.desconto)}</td></tr>
        <tr><td style="font-weight:bold; padding-top:6px;">Total</td><td style="text-align:right; font-weight:bold; padding-top:6px;">${formatCurrencyBRL(p.total)}</td></tr>
      </table>

      <table style="width:100%; margin-top:20px; font-size:14px;">
        <tr><td style="color:#666; padding:2px 0;">Data da proposta</td><td>${formatDateBR(p.data_proposta)}</td></tr>
        ${p.validade_ate ? `<tr><td style="color:#666; padding:2px 0;">Válida até</td><td>${formatDateBR(p.validade_ate)}</td></tr>` : ""}
        ${p.condicoes_pagamento ? `<tr><td style="color:#666; padding:2px 0;">Condições de pagamento</td><td>${escapeHtml(p.condicoes_pagamento)}</td></tr>` : ""}
        ${p.prazo_entrega ? `<tr><td style="color:#666; padding:2px 0;">Prazo de entrega</td><td>${escapeHtml(p.prazo_entrega)}</td></tr>` : ""}
      </table>

      ${p.observacoes ? `<p style="margin-top:16px;"><strong>Observações:</strong><br>${escapeHtml(p.observacoes).replace(/\n/g, "<br>")}</p>` : ""}

      <p style="margin-top:24px; color:#666; font-size:13px;">Qualquer dúvida, é só responder este e-mail.</p>
      ${p.empresa?.rodape_documentos ? `<p style="margin-top:12px; padding-top:12px; border-top:1px solid #e5e5e5; color:#888; font-size:12px;">${escapeHtml(p.empresa.rodape_documentos).replace(/\n/g, "<br>")}</p>` : ""}
    </div>
  `;

  const enviado = await enviarEmail(destinatario, `Proposta #${p.numero} — ${empresaNome}`, html, empresaNome);
  if (!enviado) {
    return json({ error: "Não foi possível enviar o e-mail agora. Tente novamente em instantes." }, 502);
  }

  if (p.status === "draft") {
    const { error: statusError } = await supabaseAsUser.rpc("atualizar_status_proposta", {
      p_proposta_id: propostaId,
      p_status: "enviada",
    });
    if (statusError) console.error("Proposta enviada, mas falhou ao atualizar status:", statusError);
  }

  return json({ ok: true, destinatario });
});
