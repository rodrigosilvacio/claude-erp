// ERPConnect — Financeiro > Contas a Pagar: lançamentos manuais de valores
// devidos a fornecedores num período, com registro de pagamento e
// cancelamento. Mesmo padrão de Contas a Receber (financeiro.js), mas sem
// baixa de estoque — pagar um fornecedor não movimenta produto.

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, formatCurrency, formatDate, formatCsvNumber, escapeHtml, createSearchSelect, registerAutoRefresh, withButtonLock, friendlyPgError, exportCsv } from "./app.js";
import { isAdmin, getCurrentEmpresaId } from "./auth.js";
import { loadEmpresasAtivas, loadFornecedoresPorEmpresa, empresaSearchOptions, fornecedorSearchOptions } from "./catalogo.js";
import { todayStr, firstDayOfMonthStr, statCard, periodoToolbarHtml, wirePeriodoToolbar, paginacaoHtml, wirePaginacao } from "./financeiro-ui.js";

const FORMAS_PAGAMENTO = ["Dinheiro", "Pix", "Cartão de crédito", "Cartão de débito", "Boleto", "Transferência"];
const PAGE_SIZE = 50;

let empresasOptions = [];

function lastDayOfMonthStr() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

export async function render(view, actionsEl) {
  const state = { inicio: firstDayOfMonthStr(), fim: lastDayOfMonthStr(), page: 0, somentePendentes: false };

  empresasOptions = await loadEmpresasAtivas();

  actionsEl.innerHTML = `
    <button type="button" class="btn btn--ghost" id="btn-exportar-csv">Exportar CSV</button>
    <button type="button" class="btn btn--primary" id="btn-nova-conta">+ Nova conta a pagar</button>
  `;
  actionsEl.querySelector("#btn-nova-conta").addEventListener("click", () => {
    openContaForm(() => load(view, state, { silent: true }));
  });
  actionsEl.querySelector("#btn-exportar-csv").addEventListener("click", () => {
    const linhas = state.linhasCompletas || [];
    const nomeArquivo = state.somentePendentes
      ? "contas-a-pagar_pendentes.csv"
      : `contas-a-pagar_${state.inicio}_a_${state.fim}.csv`;
    exportCsv(
      nomeArquivo,
      ["Vencimento", "Fornecedor", "Descrição", "Valor", "Forma de pagamento", "Status"],
      linhas.map((l) => [l.data_vencimento, l.fornecedor?.nome || "", l.descricao, formatCsvNumber(l.valor), l.forma_pagamento || "", l.vencida ? "Atrasada" : statusLabel(l.status)]),
    );
  });

  view.innerHTML = `
    ${periodoToolbarHtml({ prefix: "cp", inicioLabel: "Vencimento de", inicio: state.inicio, fim: state.fim })}
    <div id="cp-content"><div class="empty-state">Carregando…</div></div>
  `;

  wirePeriodoToolbar(view, { prefix: "cp", state, onChange: () => load(view, state) });

  await load(view, state);

  registerAutoRefresh(() => load(view, state, { silent: true }), 20000);
}

const CONTA_SELECT = "id, descricao, valor, data_vencimento, data_pagamento, forma_pagamento, status, fornecedor:fornecedores(nome)";

function withVencida(row) {
  return { ...row, vencida: row.status === "pendente" && row.data_vencimento < todayStr() };
}

async function load(view, state, opts = {}) {
  const { silent = false } = opts;
  const content = view.querySelector("#cp-content");
  if (!silent) content.innerHTML = `<div class="empty-state">Carregando…</div>`;

  // "Só pendentes" ignora o filtro de vencimento inteiro — lista fechada de
  // "quem eu ainda devo", de qualquer data, mais próxima do vencimento primeiro.
  if (state.somentePendentes) {
    const { data, error } = await supabase
      .from("contas_pagar")
      .select(CONTA_SELECT)
      .eq("status", "pendente")
      .order("data_vencimento", { ascending: true })
      .limit(2000);

    if (error) {
      content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar as contas pendentes</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
      return;
    }

    const linhas = (data || []).map(withVencida);
    state.linhasCompletas = linhas;
    const totalPages = Math.max(1, Math.ceil(linhas.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages - 1);
    const from = state.page * PAGE_SIZE;
    renderContentPendentes(view, state, linhas.slice(from, from + PAGE_SIZE), linhas);
    return;
  }

  const from = state.page * PAGE_SIZE;
  const { data, error, count } = await supabase
    .from("contas_pagar")
    .select(CONTA_SELECT, { count: "exact" })
    .gte("data_vencimento", state.inicio)
    .lte("data_vencimento", state.fim)
    .order("data_vencimento", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (error) {
    content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar as contas a pagar</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  // Totais (e a exportação CSV) somam todas as contas que casam com o
  // filtro, não só a página em tela — por isso uma segunda consulta sem
  // range().
  const { data: todasDoPeriodo } = await supabase
    .from("contas_pagar")
    .select(CONTA_SELECT)
    .gte("data_vencimento", state.inicio)
    .lte("data_vencimento", state.fim)
    .limit(5000);

  state.linhasCompletas = (todasDoPeriodo || []).map(withVencida);
  renderContent(view, state, (data || []).map(withVencida), count || 0, state.linhasCompletas);
}

function renderContent(view, state, linhas, count, todasDoPeriodo) {
  const content = view.querySelector("#cp-content");
  const ativas = todasDoPeriodo.filter((l) => l.status !== "cancelado");
  const pendentes = ativas.filter((l) => l.status === "pendente");
  const totalPendente = pendentes.reduce((sum, l) => sum + Number(l.valor || 0), 0);
  const totalPago = ativas.filter((l) => l.status === "pago").reduce((sum, l) => sum + Number(l.valor || 0), 0);

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("A pagar no período", formatCurrency(totalPendente), "var(--danger)")}
      ${statCard("Já pago no período", formatCurrency(totalPago), "var(--accent)")}
      ${statCard("Contas pendentes", pendentes.length, "var(--amber)")}
      ${statCard("Lançamentos no período", ativas.length, "var(--text-muted)")}
    </div>
    <div class="card card-section">
      <p class="section-title">Contas a pagar</p>
      ${renderTabela(linhas)}
      ${paginacaoHtml("cp", state.page, totalPages)}
    </div>
  `;

  wireAcoes(view, state, content);
  wirePaginacao(content, "cp", state, totalPages, () => load(view, state));
}

function renderContentPendentes(view, state, linhasPagina, linhasTodas) {
  const content = view.querySelector("#cp-content");
  const vencidas = linhasTodas.filter((l) => l.vencida);
  const totalPendente = linhasTodas.reduce((sum, l) => sum + Number(l.valor || 0), 0);
  const totalVencido = vencidas.reduce((sum, l) => sum + Number(l.valor || 0), 0);
  const totalPages = Math.max(1, Math.ceil(linhasTodas.length / PAGE_SIZE));

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Total a pagar (todos os vencimentos)", formatCurrency(totalPendente), "var(--danger)")}
      ${statCard("Contas pendentes", linhasTodas.length, "var(--text-muted)")}
      ${statCard("Contas em atraso", vencidas.length, vencidas.length > 0 ? "var(--danger)" : "var(--text-muted)")}
      ${statCard("Valor em atraso", formatCurrency(totalVencido), vencidas.length > 0 ? "var(--danger)" : "var(--text-muted)")}
    </div>
    <div class="card card-section">
      <p class="section-title">Contas pendentes (todos os vencimentos)</p>
      ${renderTabela(linhasPagina, "Nenhuma conta pendente no momento.")}
      ${paginacaoHtml("cp", state.page, totalPages)}
    </div>
  `;

  wireAcoes(view, state, content);
  wirePaginacao(content, "cp", state, totalPages, () => load(view, state));
}

function wireAcoes(view, state, content) {
  content.querySelectorAll("[data-pagar]").forEach((btn) => {
    btn.addEventListener("click", () => openPagamentoForm(btn.dataset.pagar, () => load(view, state, { silent: true })));
  });

  content.querySelectorAll("[data-cancelar]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Cancelar esta conta a pagar?", { confirmLabel: "Cancelar conta" });
      if (!ok) return;
      const { error } = await supabase.rpc("cancelar_conta_pagar", { p_conta_id: btn.dataset.cancelar });
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast("Conta a pagar cancelada.");
      load(view, state, { silent: true });
    });
  });
}

function statusLabel(status) {
  return { pendente: "Pendente", pago: "Pago", cancelado: "Cancelado" }[status] || status;
}

function renderTabela(linhas, emptyMessage = "Nenhuma conta a pagar neste período.") {
  if (linhas.length === 0) {
    return `<div class="empty-state" style="padding: 1.5rem;">${escapeHtml(emptyMessage)}</div>`;
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Vencimento</th><th>Fornecedor</th><th>Descrição</th><th style="text-align:right">Valor</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          ${linhas.map((l) => {
            // Conta pendente com vencimento já passado ganha o selo
            // "Atrasada" (vermelho) em vez do "Pendente" (amarelo) neutro.
            const statusCls = l.vencida ? "atrasada" : l.status === "pago" ? "confirmada" : l.status === "cancelado" ? "cancelada" : "pendente";
            const statusText = l.vencida ? "Atrasada" : statusLabel(l.status);
            return `
            <tr>
              <td>${formatDate(l.data_vencimento)}</td>
              <td>${escapeHtml(l.fornecedor?.nome || "—")}</td>
              <td>${escapeHtml(l.descricao)}</td>
              <td class="cell-num">${formatCurrency(l.valor)}</td>
              <td><span class="status status--${statusCls}">${statusText}</span></td>
              <td class="cell-actions">
                ${l.status === "pendente" ? `
                  <button type="button" class="btn btn--primary btn--sm" data-pagar="${l.id}">Registrar pagamento</button>
                  <button type="button" class="btn btn--danger btn--sm" data-cancelar="${l.id}">Cancelar</button>
                ` : ""}
              </td>
            </tr>
          `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Modal de nova conta a pagar ──────────────────────────────────────────

function openContaForm(onSaved) {
  const admin = isAdmin();
  const body = openModal("Nova conta a pagar");

  body.innerHTML = `
    <form id="cp-form">
      <div id="cp-form-error"></div>
      <div class="form-grid">
        ${admin ? `
        <div class="field field--full">
          <label>Empresa<span class="field-required">*</span></label>
          <div data-mount="cp-empresa"></div>
        </div>
        ` : ""}
        <div class="field field--full">
          <label>Fornecedor<span class="field-required">*</span></label>
          <div data-mount="cp-fornecedor"></div>
        </div>
        <div class="field field--full">
          <label for="cp-descricao">Descrição<span class="field-required">*</span></label>
          <input class="input" type="text" id="cp-descricao" placeholder="Ex.: Compra de mercadorias, aluguel, energia…" required />
        </div>
        <div class="field">
          <label for="cp-valor">Valor<span class="field-required">*</span></label>
          <input class="input" type="number" id="cp-valor" min="0.01" step="0.01" required />
        </div>
        <div class="field">
          <label for="cp-vencimento">Vencimento<span class="field-required">*</span></label>
          <input class="input" type="date" id="cp-vencimento" value="${todayStr()}" required />
        </div>
        <div class="field field--full">
          <label for="cp-obs">Observações</label>
          <textarea class="input" id="cp-obs" rows="2"></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cp-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Salvar conta a pagar</button>
      </div>
    </form>
  `;

  const empresaInicial = getCurrentEmpresaId();

  const fornecedorMount = body.querySelector('[data-mount="cp-fornecedor"]');
  let fornecedorSelect = createSearchSelect({
    container: fornecedorMount,
    placeholder: "Buscar fornecedor…",
    options: [],
    allowClear: false,
    emptyText: admin ? "Escolha a empresa primeiro" : "Nenhum fornecedor cadastrado",
  });

  async function recarregarFornecedores(empresaId) {
    const fornecedores = await loadFornecedoresPorEmpresa(empresaId);
    fornecedorSelect.setOptions(fornecedorSearchOptions(fornecedores));
  }

  const empresaSelect = admin
    ? createSearchSelect({
        container: body.querySelector('[data-mount="cp-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: empresaInicial,
        allowClear: false,
        onChange: (empresaId) => recarregarFornecedores(empresaId),
      })
    : null;

  recarregarFornecedores(admin ? empresaInicial : empresaInicial);

  body.querySelector("#cp-cancel").addEventListener("click", closeModal);

  body.querySelector("#cp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#cp-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#cp-form-error");
      errorEl.innerHTML = "";

      const fornecedorId = fornecedorSelect.getValue();
      if (!fornecedorId) {
        errorEl.innerHTML = `<div class="form-error">Selecione um fornecedor.</div>`;
        return;
      }

      if (admin && !empresaSelect.getValue()) {
        errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
        return;
      }

      const payload = {
        p_fornecedor_id: fornecedorId,
        p_descricao: body.querySelector("#cp-descricao").value,
        p_valor: Number(body.querySelector("#cp-valor").value || 0),
        p_data_vencimento: body.querySelector("#cp-vencimento").value,
        p_observacoes: body.querySelector("#cp-obs").value || null,
      };
      if (admin) payload.p_empresa_id = empresaSelect.getValue();

      const { error } = await supabase.rpc("criar_conta_pagar", payload);

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast("Conta a pagar registrada.");
      closeModal();
      if (onSaved) onSaved();
    });
  });
}

// ── Modal de registrar pagamento ─────────────────────────────────────────

function openPagamentoForm(contaId, onSaved) {
  const body = openModal("Registrar pagamento");

  body.innerHTML = `
    <form id="cp-pag-form">
      <div id="cp-pag-form-error"></div>
      <div class="form-grid">
        <div class="field">
          <label for="cp-pag-data">Data do pagamento<span class="field-required">*</span></label>
          <input class="input" type="date" id="cp-pag-data" value="${todayStr()}" required />
        </div>
        <div class="field">
          <label for="cp-pag-forma">Forma de pagamento</label>
          <select class="input" id="cp-pag-forma">
            <option value="">—</option>
            ${FORMAS_PAGAMENTO.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="cp-pag-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Confirmar pagamento</button>
      </div>
    </form>
  `;

  body.querySelector("#cp-pag-cancel").addEventListener("click", closeModal);

  body.querySelector("#cp-pag-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#cp-pag-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#cp-pag-form-error");
      errorEl.innerHTML = "";

      const { error } = await supabase.rpc("registrar_pagamento_conta_pagar", {
        p_conta_id: contaId,
        p_data_pagamento: body.querySelector("#cp-pag-data").value || null,
        p_forma_pagamento: body.querySelector("#cp-pag-forma").value || null,
      });

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast("Pagamento registrado.");
      closeModal();
      if (onSaved) onSaved();
    });
  });
}
