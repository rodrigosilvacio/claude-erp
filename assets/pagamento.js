// ERPConnect — forma de pagamento e fluxo Stripe compartilhados entre Loja
// (vendas) e Matrículas: os mesmos "tiles" com ícone (Dinheiro/Pix/Cartão.../
// Stripe) e o mesmo fluxo de Checkout Session (QR/link + polling até o
// webhook confirmar). Extraído de vendas.js pra Matrículas reusar sem
// duplicar os SVGs dos tiles nem a lógica de polling.

import QRCode from "https://esm.sh/qrcode@1.5.4";
import { supabase } from "./supabaseClient.js";
import { openModal, closeModal, escapeHtml } from "./app.js";

// Intervalo do polling que checa se o pagamento Stripe já foi confirmado
// pelo webhook (ver mostrarModalStripe) — 3s é responsivo o bastante pro
// cliente ver a tela reagir sem gerar tráfego excessivo.
const STRIPE_POLL_INTERVAL_MS = 3000;

// Cada forma de pagamento vira um "tile" com ícone — em vez de uma fileira
// de pílulas de texto (que não cabiam lado a lado e se sobrepunham), cada
// uma ganha seu próprio espaço, do jeito que um terminal de caixa de
// verdade apresenta as opções.
export const FORMAS_PAGAMENTO = [
  {
    label: "Dinheiro",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg>',
  },
  {
    label: "Pix",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  },
  {
    label: "Cartão de crédito",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  },
  {
    label: "Cartão de débito",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><rect x="5" y="9" width="4" height="3" rx="0.6"/><path d="M5 16h6"/></svg>',
  },
  {
    label: "Boleto",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="butt"><path d="M3 4v16" stroke-width="1.5"/><path d="M6.5 4v16" stroke-width="3"/><path d="M11 4v16" stroke-width="1.5"/><path d="M14 4v16" stroke-width="1.5"/><path d="M17.5 4v16" stroke-width="3"/><path d="M21.5 4v16" stroke-width="1.5"/></svg>',
  },
  {
    // Pagamento remoto: diferente das outras formas (rótulos só — o dinheiro
    // já mudou de mão fisicamente), Stripe gera um QR/link que o cliente
    // paga pelo próprio celular; a venda/matrícula só fecha quando o
    // webhook confirma.
    label: "Stripe",
    icon: '<svg aria-hidden="true" focusable="false" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/><path d="M10 6h4"/></svg>',
  },
];

// Markup dos tiles — embutir direto no template da tela (dentro de um
// `role="radiogroup"`) e depois chamar mountPaytiles() no elemento pai pra
// ligar o clique.
export function paytilesHtml() {
  return FORMAS_PAGAMENTO.map((forma, idx) => `
    <button type="button" class="paytile ${idx === 0 ? "is-active" : ""}" data-value="${escapeHtml(forma.label)}" role="radio" aria-checked="${idx === 0}">
      <span class="paytile__icon">${forma.icon}</span>
      <span class="paytile__label">${escapeHtml(forma.label)}</span>
    </button>
  `).join("");
}

// `initialValue` permite pré-selecionar um tile diferente do padrão
// ("Dinheiro") — usado por "Renovar matrícula" pra sugerir a mesma forma de
// pagamento da matrícula original.
export function mountPaytiles(groupEl, initialValue) {
  let value = FORMAS_PAGAMENTO.some((f) => f.label === initialValue) ? initialValue : FORMAS_PAGAMENTO[0].label;

  function applyActive() {
    groupEl.querySelectorAll(".paytile").forEach((b) => {
      const active = b.dataset.value === value;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
  }
  applyActive();

  groupEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    value = btn.dataset.value;
    applyActive();
  });
  return { getValue: () => value };
}

// Mesmo padrão de erro de callManageUsuarios (auth.js): a edge function
// devolve `{ error }` em JSON tanto em falhas de validação (400/502) quanto
// o supabase-js embrulha isso como FunctionsHttpError — o corpo de verdade
// só é acessível via error.context.
export async function chamarCriarCheckoutStripe(payload) {
  const { data, error } = await supabase.functions.invoke("create-stripe-checkout", { body: payload });

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

// Roadmap Fase 3 — confirmação automática pós-venda/matrícula: dispara
// best-effort (nunca aguardada pelo caminho principal, nunca mostra erro ao
// operador) o recibo/confirmação por e-mail ao cliente. Chamada uma única
// vez, no topo de finalizarComSucesso de vendas.js/matriculas.js — cobre
// tanto o fechamento em dinheiro/cartão quanto a confirmação via webhook do
// Stripe, já que os dois caminhos convergem para essa mesma função.
export function dispararConfirmacaoNegocio(tipo, id) {
  supabase.functions.invoke("enviar-confirmacao-negocio", { body: { tipo, id } })
    .catch((err) => console.error("Falha ao disparar confirmação por e-mail:", err));
}

// Mostra o QR/link da Checkout Session e faz polling do status até o
// webhook do Stripe confirmar (ou o operador fechar o modal — nesse caso o
// registro segue 'aguardando_pagamento' e expira sozinho em 30min, ver
// create-stripe-checkout). `table`/`id` dizem onde checar o status;
// `successStatus` é o valor que indica pagamento confirmado ('confirmada'
// para vendas, 'ativa' para matrículas) — qualquer outro status diferente
// de 'aguardando_pagamento' é tratado como cancelado/expirado.
export async function mostrarModalStripe({ title, id, table, successStatus, checkoutUrl, onConfirmada }) {
  let stopped = false;
  const body = openModal(title, {
    onClose: () => { stopped = true; },
  });

  body.innerHTML = `
    <div style="text-align:center;">
      <p class="field-hint" style="margin-top:0;">Peça para o cliente escanear o QR code com a câmera do celular, ou envie o link de pagamento.</p>
      <img id="stripe-qr" alt="QR code de pagamento" width="220" height="220" style="margin: 1rem auto; display:block; border-radius: 8px;" />
      <a class="btn btn--ghost" href="${escapeHtml(checkoutUrl)}" target="_blank" rel="noopener">Abrir link de pagamento</a>
      <p class="cell-muted" id="stripe-status" style="margin-top: 1rem;">Aguardando pagamento…</p>
    </div>
  `;

  try {
    const dataUrl = await QRCode.toDataURL(checkoutUrl, { width: 220, margin: 1 });
    const img = body.querySelector("#stripe-qr");
    if (img) img.src = dataUrl;
  } catch (err) {
    console.error("Falha ao gerar QR code do pagamento:", err);
    const img = body.querySelector("#stripe-qr");
    if (img) img.hidden = true;
  }

  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, STRIPE_POLL_INTERVAL_MS));
    if (stopped) break;

    const { data: row } = await supabase.from(table).select("status").eq("id", id).maybeSingle();
    if (!row) continue;

    if (row.status === successStatus) {
      stopped = true;
      closeModal();
      await onConfirmada();
      return;
    }
    if (row.status !== "aguardando_pagamento") {
      stopped = true;
      const statusEl = body.querySelector("#stripe-status");
      if (statusEl) statusEl.innerHTML = '<span class="form-error">Pagamento não concluído (QR expirado ou cancelado).</span>';
      return;
    }
  }
}
