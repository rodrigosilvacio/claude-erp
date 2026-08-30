// ERPConnect — Financeiro > Contas a Receber: lista tudo que foi recebido no
// período (vendas confirmadas + lançamentos manuais + parcelas pagas de
// matrícula) e o que ainda está por vir (parcelas de matrícula pendentes,
// com vencimento no período — títulos a receber de verdade, ver
// supabase/migrations/0015). Também permite registrar um recebimento manual
// avulso (além de vendas), que exige um produto e reduz o estoque dele —
// mesmo padrão de criar_venda/cancelar_venda.

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, formatCurrency, formatDate, formatCsvNumber, escapeHtml, createSearchSelect, registerAutoRefresh, withButtonLock, friendlyPgError, exportCsv } from "./app.js";
import { isAdmin, getCurrentEmpresaId } from "./auth.js";
import { loadClientesAtivos, loadProdutosVendaveis, loadEmpresasAtivas, clienteSearchOptions, produtoSearchOptions, empresaSearchOptions, produtoMetaPrecoEstoque } from "./catalogo.js";
import { openPagamentoParcelaForm } from "./matriculas.js";
import { todayStr, firstDayOfMonthStr, statCard, periodoToolbarHtml, wirePeriodoToolbar, paginacaoHtml, wirePaginacao } from "./financeiro-ui.js";

const FORMAS_PAGAMENTO = ["Dinheiro", "Pix", "Cartão de crédito", "Cartão de débito", "Boleto"];

// O extrato mistura vendas + recebimentos manuais num período — sem uma view
// no banco que já una as duas tabelas, não dá pra paginar isso de forma
// nativa no Postgres. FETCH_CAP evita buscar um período enorme por inteiro;
// PAGE_SIZE pagina a renderização da tabela em memória (os totais do período
// continuam somando todo o conjunto buscado, não só a página em tela).
const FETCH_CAP = 2000;
const PAGE_SIZE = 50;

let clientesOptions = [];
let produtosOptions = [];
let empresasOptions = [];

// Última data do mês atual + `monthsAhead` meses à frente — usado só como
// teto padrão do filtro "Até". Sem isso, o "Até" parava em hoje e as
// parcelas de matrícula futuras (o próprio motivo de existir esta tela)
// ficavam escondidas até alguém alargar o filtro manualmente.
function lastDayOfMonthPlusStr(monthsAhead) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1 + monthsAhead, 0).toISOString().slice(0, 10);
}

export async function render(view, actionsEl) {
  // "Até" olha 1 mês à frente por padrão — cobre a próxima parcela de
  // matrícula a vencer sem inflar demais a lista com vencimentos distantes;
  // o operador pode alargar o filtro pra ver mais (ou ligar "Só pendentes"
  // pra ver todo mundo que ainda deve, de qualquer vencimento).
  const state = { inicio: firstDayOfMonthStr(), fim: lastDayOfMonthPlusStr(1), page: 0, linhas: [], somentePendentes: false };

  [clientesOptions, produtosOptions, empresasOptions] = await Promise.all([loadClientesAtivos(), loadProdutosVendaveis(), loadEmpresasAtivas()]);

  actionsEl.innerHTML = `
    <button type="button" class="btn btn--ghost" id="btn-exportar-csv">Exportar CSV</button>
    <button type="button" class="btn btn--primary" id="btn-novo-recebimento">+ Novo recebimento</button>
  `;
  actionsEl.querySelector("#btn-novo-recebimento").addEventListener("click", () => {
    openRecebimentoForm(() => load(view, state, { silent: true }));
  });
  actionsEl.querySelector("#btn-exportar-csv").addEventListener("click", () => {
    exportCsv(
      `contas-a-receber_${state.inicio}_a_${state.fim}.csv`,
      ["Data", "Origem", "Cliente", "Item(ns)", "Forma de pagamento", "Valor", "Status"],
      state.linhas.map((l) => [l.data, ORIGEM_LABEL[l.origem]?.(l) || l.origem, l.cliente, l.itens, l.formaPagamento || "", formatCsvNumber(l.valor), (STATUS_META[l.status] || { label: l.status }).label]),
    );
  });

  view.innerHTML = `
    ${periodoToolbarHtml({ prefix: "cr", inicio: state.inicio, fim: state.fim })}
    <div id="cr-content"><div class="empty-state">Carregando…</div></div>
  `;

  wirePeriodoToolbar(view, { prefix: "cr", state, onChange: () => load(view, state) });

  await load(view, state);

  registerAutoRefresh(() => load(view, state, { silent: true }), 20000);
}

const PARCELA_SELECT = "id, numero_parcela, valor, data_vencimento, data_pagamento, forma_pagamento, status, cliente:clientes(nome), matricula:matriculas(numero, numero_parcelas, produto:produtos(nome))";

function mapParcelaLinha(p) {
  const vencida = p.status === "pendente" && p.data_vencimento < todayStr();
  return {
    origem: "matricula",
    id: p.id,
    data: p.status === "pago" ? p.data_pagamento : p.data_vencimento,
    cliente: p.cliente?.nome || "Sem cliente",
    itens: `Parcela ${p.numero_parcela}/${p.matricula?.numero_parcelas ?? "?"} — ${p.matricula?.produto?.nome || "Curso"}`,
    formaPagamento: p.forma_pagamento,
    valor: Number(p.valor || 0),
    status: p.status,
    numero: p.matricula?.numero,
    vencida,
  };
}

async function load(view, state, opts = {}) {
  const { silent = false } = opts;
  const content = view.querySelector("#cr-content");
  if (!silent) content.innerHTML = `<div class="empty-state">Carregando…</div>`;

  // "Só pendentes" ignora completamente o filtro de data e as demais origens
  // (vendas/manual) — é uma lista à parte, "quem ainda me deve", ordenada
  // pelo vencimento mais próximo primeiro (não pela mais recente).
  if (state.somentePendentes) {
    const { data, error } = await supabase
      .from("matricula_parcelas")
      .select(PARCELA_SELECT)
      .eq("status", "pendente")
      .order("data_vencimento", { ascending: true })
      .limit(FETCH_CAP);

    if (error) {
      content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar as parcelas pendentes</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
      return;
    }

    state.linhas = (data || []).map(mapParcelaLinha);
    const totalPages = Math.max(1, Math.ceil(state.linhas.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages - 1);
    renderContent(view, state);
    return;
  }

  const [vendasRes, recebimentosRes, parcelasRes] = await Promise.all([
    supabase
      .from("vendas")
      .select("id, numero, data_venda, forma_pagamento, total, cliente:clientes(nome), itens:venda_itens(quantidade, produto:produtos(nome))")
      .eq("status", "confirmada")
      .gte("data_venda", state.inicio)
      .lte("data_venda", state.fim)
      .limit(FETCH_CAP),
    supabase
      .from("recebimentos")
      .select("id, data_recebimento, quantidade, valor, forma_pagamento, observacoes, status, cliente:clientes(nome), produto:produtos(nome)")
      .gte("data_recebimento", state.inicio)
      .lte("data_recebimento", state.fim)
      .limit(FETCH_CAP),
    // Parcelas de matrícula: parcela paga entra pela data em que foi
    // recebida; parcela pendente entra pela data de vencimento — é isso que
    // faz dela um título "a receber" de verdade (aparece no período em que
    // vence, não em que foi lançada).
    supabase
      .from("matricula_parcelas")
      .select(PARCELA_SELECT)
      .or(`and(status.eq.pago,data_pagamento.gte.${state.inicio},data_pagamento.lte.${state.fim}),and(status.eq.pendente,data_vencimento.gte.${state.inicio},data_vencimento.lte.${state.fim})`)
      .limit(FETCH_CAP),
  ]);

  if (vendasRes.error || recebimentosRes.error || parcelasRes.error) {
    const err = vendasRes.error || recebimentosRes.error || parcelasRes.error;
    content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar os recebimentos</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(err))}</p></div>`;
    return;
  }

  const linhasVendas = (vendasRes.data || []).map((v) => ({
    origem: "venda",
    id: v.id,
    data: v.data_venda,
    cliente: v.cliente?.nome || "Sem cliente",
    itens: (v.itens || []).map((i) => `${i.quantidade}x ${i.produto?.nome || "Produto"}`).join(", ") || "—",
    formaPagamento: v.forma_pagamento,
    valor: Number(v.total || 0),
    status: "recebido",
    numero: v.numero,
  }));

  const linhasManuais = (recebimentosRes.data || []).map((r) => ({
    origem: "manual",
    id: r.id,
    data: r.data_recebimento,
    cliente: r.cliente?.nome || "Sem cliente",
    itens: `${r.quantidade}x ${r.produto?.nome || "Produto"}`,
    formaPagamento: r.forma_pagamento,
    valor: Number(r.valor || 0),
    status: r.status,
  }));

  const linhasParcelas = (parcelasRes.data || []).map(mapParcelaLinha);

  state.linhas = [...linhasVendas, ...linhasManuais, ...linhasParcelas].sort((a, b) => new Date(b.data) - new Date(a.data));
  const totalPages = Math.max(1, Math.ceil(state.linhas.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages - 1);

  renderContent(view, state);
}

function renderContent(view, state) {
  const content = view.querySelector("#cr-content");
  const linhas = state.linhas;

  const totalPages = Math.max(1, Math.ceil(linhas.length / PAGE_SIZE));
  const from = state.page * PAGE_SIZE;
  const linhasPagina = linhas.slice(from, from + PAGE_SIZE);

  const { statsHtml, sectionTitle, emptyMessage } = state.somentePendentes
    ? statsPendentes(linhas)
    : statsPeriodo(linhas);

  content.innerHTML = `
    <div class="stat-grid">${statsHtml}</div>
    <div class="card card-section">
      <p class="section-title">${sectionTitle}</p>
      ${renderTabela(linhasPagina, emptyMessage)}
      ${paginacaoHtml("cr", state.page, totalPages)}
    </div>
  `;

  content.querySelectorAll("[data-cancelar]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Cancelar este recebimento manual? O estoque do produto será devolvido.", { confirmLabel: "Cancelar recebimento" });
      if (!ok) return;
      const { error } = await supabase.rpc("cancelar_recebimento_manual", { p_recebimento_id: btn.dataset.cancelar });
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast("Recebimento cancelado e estoque devolvido.");
      produtosOptions = await loadProdutosVendaveis();
      load(view, state);
    });
  });

  content.querySelectorAll("[data-pagar-parcela]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openPagamentoParcelaForm(btn.dataset.pagarParcela, () => load(view, state, { silent: true }));
    });
  });

  wirePaginacao(content, "cr", state, totalPages, () => renderContent(view, state));
}

// "Recebido" = já entrou (vendas, manual, parcelas pagas). Parcelas
// pendentes NÃO entram aqui — elas são o que ainda falta receber, por isso
// ganham o próprio total em vez de inflar o que já foi de fato recebido no
// período selecionado.
function statsPeriodo(linhas) {
  const linhasAtivas = linhas.filter((l) => l.status !== "cancelado");
  const linhasRecebidas = linhasAtivas.filter((l) => l.status !== "pendente");
  const linhasPendentes = linhasAtivas.filter((l) => l.status === "pendente");

  const totalRecebido = linhasRecebidas.reduce((sum, l) => sum + l.valor, 0);
  const totalVendas = linhasRecebidas.filter((l) => l.origem === "venda").reduce((sum, l) => sum + l.valor, 0);
  const totalMatriculas = linhasRecebidas.filter((l) => l.origem === "matricula").reduce((sum, l) => sum + l.valor, 0);
  const totalAReceber = linhasPendentes.reduce((sum, l) => sum + l.valor, 0);

  return {
    statsHtml: [
      statCard("Total recebido no período", formatCurrency(totalRecebido), "var(--accent-deep)"),
      statCard("Recebido em vendas", formatCurrency(totalVendas), "var(--accent)"),
      statCard("Recebido em matrículas", formatCurrency(totalMatriculas), "var(--info)"),
      statCard("A receber (parcelas pendentes)", formatCurrency(totalAReceber), "var(--amber)"),
    ].join(""),
    sectionTitle: "Recebimentos",
    emptyMessage: "Nenhum valor recebido ou a receber neste período.",
  };
}

// Modo "Só pendentes": lista fechada de parcelas de matrícula pendentes, de
// qualquer vencimento (passado ou futuro) — separa quem está em atraso
// (vencimento já passou) de quem só ainda não venceu.
function statsPendentes(linhas) {
  const vencidas = linhas.filter((l) => l.vencida);
  const totalPendente = linhas.reduce((sum, l) => sum + l.valor, 0);
  const totalVencido = vencidas.reduce((sum, l) => sum + l.valor, 0);

  return {
    statsHtml: [
      statCard("Total pendente (todos os vencimentos)", formatCurrency(totalPendente), "var(--amber)"),
      statCard("Parcelas pendentes", linhas.length, "var(--text-muted)"),
      statCard("Parcelas em atraso", vencidas.length, vencidas.length > 0 ? "var(--danger)" : "var(--text-muted)"),
      statCard("Valor em atraso", formatCurrency(totalVencido), vencidas.length > 0 ? "var(--danger)" : "var(--text-muted)"),
    ].join(""),
    sectionTitle: "Parcelas pendentes (todos os vencimentos)",
    emptyMessage: "Nenhuma parcela pendente no momento.",
  };
}

const ORIGEM_LABEL = {
  venda: (l) => `Venda #${l.numero}`,
  manual: () => "Manual",
  matricula: (l) => `Matrícula #${l.numero}`,
};

// pago/recebido são a mesma coisa em espírito (dinheiro já entrou) — status
// bruto muda por origem (vendas/manual usam "recebido", parcelas de
// matrícula usam "pago"/"pendente"), unificado aqui pro badge.
const STATUS_META = {
  recebido: { cls: "confirmada", label: "Recebido" },
  pago: { cls: "confirmada", label: "Pago" },
  pendente: { cls: "pendente", label: "Pendente" },
  cancelado: { cls: "cancelada", label: "Cancelado" },
};

function renderTabela(linhas, emptyMessage = "Nenhum valor recebido ou a receber neste período.") {
  if (linhas.length === 0) {
    return `<div class="empty-state" style="padding: 1.5rem;">${escapeHtml(emptyMessage)}</div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Data</th><th>Origem</th><th>Cliente</th><th>Item(ns)</th><th>Pagamento</th><th style="text-align:right">Valor</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          ${linhas.map((l) => {
            // Parcela pendente com vencimento já passado ganha o selo
            // "Atrasada" (vermelho) em vez do "Pendente" (amarelo) neutro —
            // vale tanto na listagem por período quanto em "Só pendentes".
            const statusMeta = l.vencida
              ? { cls: "atrasada", label: "Atrasada" }
              : (STATUS_META[l.status] || { cls: l.status, label: l.status });
            return `
            <tr>
              <td>${formatDate(l.data)}</td>
              <td><span class="status status--${l.origem}">${ORIGEM_LABEL[l.origem]?.(l) || l.origem}</span></td>
              <td>${escapeHtml(l.cliente)}</td>
              <td>${escapeHtml(l.itens)}</td>
              <td class="cell-muted">${escapeHtml(l.formaPagamento || "—")}</td>
              <td class="cell-num">${formatCurrency(l.valor)}</td>
              <td><span class="status status--${statusMeta.cls}">${statusMeta.label}</span></td>
              <td class="cell-actions">
                ${l.origem === "manual" && l.status === "recebido" ? `<button type="button" class="btn btn--danger btn--sm" data-cancelar="${l.id}">Cancelar</button>` : ""}
                ${l.origem === "matricula" && l.status === "pendente" ? `<button type="button" class="btn btn--primary btn--sm" data-pagar-parcela="${l.id}">Registrar pagamento</button>` : ""}
              </td>
            </tr>
          `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Modal de novo recebimento manual ────────────────────────────────

function openRecebimentoForm(onSaved) {
  const admin = isAdmin();
  const body = openModal("Novo recebimento");

  body.innerHTML = `
    <form id="cr-form">
      <div id="cr-form-error"></div>
      <div class="form-grid">
        ${admin ? `
        <div class="field field--full">
          <label>Empresa<span class="field-required">*</span></label>
          <div data-mount="cr-empresa"></div>
        </div>
        ` : ""}
        <div class="field field--full">
          <label>Cliente <span class="field-optional">opcional</span></label>
          <div data-mount="cr-cliente"></div>
        </div>
        <div class="field field--full">
          <label>Produto<span class="field-required">*</span></label>
          <div data-mount="cr-produto"></div>
        </div>
        <div class="field">
          <label for="cr-qtd">Quantidade<span class="field-required">*</span></label>
          <input class="input" type="number" id="cr-qtd" min="1" step="1" value="1" required />
        </div>
        <div class="field">
          <label for="cr-valor">Valor recebido<span class="field-required">*</span></label>
          <input class="input" type="number" id="cr-valor" min="0" step="0.01" value="0" required />
        </div>
        <div class="field">
          <label for="cr-forma">Forma de pagamento</label>
          <select class="input" id="cr-forma">
            ${FORMAS_PAGAMENTO.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="cr-data">Data do recebimento<span class="field-required">*</span></label>
          <input class="input" type="date" id="cr-data" value="${todayStr()}" required />
        </div>
        <div class="field field--full">
          <label for="cr-obs">Observações</label>
          <textarea class="input" id="cr-obs" rows="2"></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cr-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Registrar recebimento</button>
      </div>
    </form>
  `;

  const empresaSelect = admin
    ? createSearchSelect({
        container: body.querySelector('[data-mount="cr-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: getCurrentEmpresaId(),
        allowClear: false,
      })
    : null;

  const clienteSelect = createSearchSelect({
    container: body.querySelector('[data-mount="cr-cliente"]'),
    placeholder: "Buscar cliente por nome ou documento… (opcional)",
    options: clienteSearchOptions(clientesOptions),
    allowClear: true,
  });

  const produtoSelect = createSearchSelect({
    container: body.querySelector('[data-mount="cr-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    allowClear: true,
    onChange: () => atualizarSugestaoValor(),
  });

  const qtdInput = body.querySelector("#cr-qtd");
  const valorInput = body.querySelector("#cr-valor");

  // Sugere o valor (preço de tabela x quantidade) ao escolher o produto ou
  // mudar a quantidade — só enquanto o usuário não editar o valor manualmente.
  let valorTocado = false;
  valorInput.addEventListener("input", () => {
    valorTocado = true;
  });

  function atualizarSugestaoValor() {
    if (valorTocado) return;
    const produto = produtosOptions.find((p) => p.id === produtoSelect.getValue());
    if (!produto) return;
    const quantidade = Number(qtdInput.value || 0);
    valorInput.value = (Number(produto.preco || 0) * quantidade).toFixed(2);
  }

  qtdInput.addEventListener("input", atualizarSugestaoValor);

  body.querySelector("#cr-cancel").addEventListener("click", closeModal);

  body.querySelector("#cr-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#cr-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#cr-form-error");
      errorEl.innerHTML = "";

      const produtoId = produtoSelect.getValue();
      if (!produtoId) {
        errorEl.innerHTML = `<div class="form-error">Selecione um produto.</div>`;
        return;
      }

      if (admin && !empresaSelect.getValue()) {
        errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
        return;
      }

      const payload = {
        p_produto_id: produtoId,
        p_quantidade: Number(qtdInput.value || 0),
        p_valor: Number(valorInput.value || 0),
        p_cliente_id: clienteSelect.getValue() || null,
        p_forma_pagamento: body.querySelector("#cr-forma").value || null,
        p_data_recebimento: body.querySelector("#cr-data").value || null,
        p_observacoes: body.querySelector("#cr-obs").value || null,
      };
      if (admin) payload.p_empresa_id = empresaSelect.getValue();

      const { error } = await supabase.rpc("criar_recebimento_manual", payload);

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast("Recebimento registrado com sucesso.");
      closeModal();
      if (onSaved) onSaved();
    });
  });
}
