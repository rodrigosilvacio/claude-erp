// ERPConnect — Movimentações > Estoques: entrada de estoque como lançamento
// auditável (produto + quantidade + data), via RPC registrar_entrada_estoque.
// Substitui o antigo fluxo de editar "Estoque atual" à mão no cadastro do
// Produto — aqui fica um histórico de quando e quanto entrou de cada item,
// e o saldo em produtos.estoque é atualizado como efeito da própria entrada.
// Mesmo padrão de tela de Contas a Pagar (filtro de período + stat cards +
// modal de lançamento).

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, formatDate, escapeHtml, createSearchSelect, registerAutoRefresh, withButtonLock, friendlyPgError } from "./app.js";
import { isAdmin, getCurrentEmpresaId } from "./auth.js";
import { loadProdutosVendaveis, loadEmpresasAtivas, loadFornecedoresPorEmpresa, produtoSearchOptions, empresaSearchOptions, fornecedorSearchOptions, produtoMetaPrecoEstoque } from "./catalogo.js";

const PAGE_SIZE = 50;

let empresasOptions = [];
let produtosOptions = [];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function firstDayOfMonthStr() {
  return `${todayStr().slice(0, 7)}-01`;
}

function lastDayOfMonthStr() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

export async function render(view, actionsEl) {
  const state = { inicio: firstDayOfMonthStr(), fim: lastDayOfMonthStr(), page: 0, tab: "entradas", kardexProdutoId: null };

  [empresasOptions, produtosOptions] = await Promise.all([loadEmpresasAtivas(), loadProdutosVendaveis()]);

  // As abas ficam no topbar, junto dos botões de ação primária — antes
  // viviam soltas no topo do conteúdo, numa segunda fileira desconectada da
  // barra de ações (mesmo ajuste em relatorios.js).
  actionsEl.innerHTML = `
    <div class="topbar-tabs">
      <button type="button" class="btn btn--sm btn--primary" id="es-tab-entradas">Entradas</button>
      <button type="button" class="btn btn--sm btn--ghost" id="es-tab-kardex">Kardex por produto</button>
    </div>
    <button type="button" class="btn btn--ghost" id="btn-ajuste-estoque">+ Ajuste de estoque</button>
    <button type="button" class="btn btn--primary" id="btn-nova-entrada">+ Nova entrada de estoque</button>
  `;
  actionsEl.querySelector("#btn-nova-entrada").addEventListener("click", () => {
    openEntradaForm(() => reloadTabAtual(view, state));
  });
  actionsEl.querySelector("#btn-ajuste-estoque").addEventListener("click", () => {
    openAjusteForm(() => reloadTabAtual(view, state));
  });

  // Roadmap Fase 2 — "Kardex de estoque": Entradas continua sendo o
  // lançamento auditável de compra; Kardex é o extrato por produto
  // (entradas + saídas por venda + ajustes manuais) com saldo corrente.
  view.innerHTML = `<div id="es-tab-content"></div>`;

  const tabEntradas = actionsEl.querySelector("#es-tab-entradas");
  const tabKardex = actionsEl.querySelector("#es-tab-kardex");

  function activateTab(tab) {
    state.tab = tab;
    tabEntradas.className = tab === "entradas" ? "btn btn--sm btn--primary" : "btn btn--sm btn--ghost";
    tabKardex.className = tab === "kardex" ? "btn btn--sm btn--primary" : "btn btn--sm btn--ghost";
    if (tab === "entradas") renderEntradasTab(view, state);
    else renderKardexTab(view, state);
  }

  tabEntradas.addEventListener("click", () => activateTab("entradas"));
  tabKardex.addEventListener("click", () => activateTab("kardex"));

  activateTab("entradas");

  registerAutoRefresh(() => reloadTabAtual(view, state, { silent: true }), 20000);
}

function reloadTabAtual(view, state, opts) {
  if (state.tab === "entradas") load(view, state, opts);
  else if (state.kardexProdutoId) loadKardex(view, state, opts);
}

function renderEntradasTab(view, state) {
  const content = view.querySelector("#es-tab-content");
  content.innerHTML = `
    <div class="toolbar financeiro-filtro">
      <div class="field financeiro-filtro__field--date">
        <label for="es-inicio">Entrada de</label>
        <input class="input" type="date" id="es-inicio" value="${state.inicio}" />
      </div>
      <div class="field financeiro-filtro__field--date">
        <label for="es-fim">Até</label>
        <input class="input" type="date" id="es-fim" value="${state.fim}" />
      </div>
      <div class="field financeiro-filtro__field--action">
        <label>&nbsp;</label>
        <button type="button" class="btn btn--ghost" id="es-filtrar">Filtrar</button>
      </div>
    </div>
    <div id="es-content"><div class="empty-state">Carregando…</div></div>
  `;

  const inicioInput = content.querySelector("#es-inicio");
  const fimInput = content.querySelector("#es-fim");

  content.querySelector("#es-filtrar").addEventListener("click", () => {
    state.inicio = inicioInput.value || state.inicio;
    state.fim = fimInput.value || state.fim;
    state.page = 0;
    load(view, state);
  });

  load(view, state);
}

function renderKardexTab(view, state) {
  const content = view.querySelector("#es-tab-content");
  content.innerHTML = `
    <div class="toolbar financeiro-filtro">
      <div class="field field--full" style="max-width:420px;">
        <label>Produto</label>
        <div data-mount="es-kardex-produto"></div>
      </div>
    </div>
    <div id="es-kardex-content"></div>
  `;

  createSearchSelect({
    container: content.querySelector('[data-mount="es-kardex-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    value: state.kardexProdutoId,
    allowClear: false,
    onChange: (produtoId) => {
      state.kardexProdutoId = produtoId;
      loadKardex(view, state);
    },
  });

  if (state.kardexProdutoId) {
    loadKardex(view, state);
  } else {
    content.querySelector("#es-kardex-content").innerHTML = `<div class="empty-state" style="padding: 1.5rem;">Escolha um produto para ver o extrato de entradas, saídas e ajustes, com saldo corrente.</div>`;
  }
}

// Saldo corrente (produtos.estoque) é o único ponto de partida confiável —
// o app nunca guardou um saldo inicial histórico. Por isso o extrato é
// percorrido do mais recente para o mais antigo, subtraindo cada delta para
// chegar ao "saldo após" da linha anterior, em vez de tentar somar para
// frente a partir de um saldo inicial que não existe.
async function loadKardex(view, state, opts = {}) {
  const { silent = false } = opts;
  const content = view.querySelector("#es-kardex-content");
  if (!content) return;
  const produtoId = state.kardexProdutoId;
  if (!silent) content.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const [produtoRes, entradasRes, ajustesRes, vendaItensRes] = await Promise.all([
    supabase.from("produtos").select("nome, sku, estoque, estoque_minimo").eq("id", produtoId).maybeSingle(),
    supabase.from("entradas_estoque").select("id, quantidade, data_entrada, observacoes, usuario:usuarios(nome)").eq("produto_id", produtoId).order("data_entrada", { ascending: false }).limit(300),
    supabase.from("ajustes_estoque").select("id, quantidade, motivo, created_at, usuario:usuarios(nome)").eq("produto_id", produtoId).order("created_at", { ascending: false }).limit(300),
    supabase.from("venda_itens").select("id, quantidade, venda:vendas(numero, data_venda, status, usuario:usuarios(nome))").eq("produto_id", produtoId).order("created_at", { ascending: false }).limit(300),
  ]);

  const erro = produtoRes.error || entradasRes.error || ajustesRes.error || vendaItensRes.error;
  if (erro) {
    content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar o kardex</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(erro))}</p></div>`;
    return;
  }

  const produto = produtoRes.data;

  // Venda cancelada já devolveu a quantidade ao estoque no momento do
  // cancelamento (ver cancelar_venda) — incluí-la aqui duplicaria a
  // devolução sem uma data de cancelamento própria para posicioná-la no
  // extrato, então só a baixa de venda confirmada entra como saída.
  const eventos = [
    ...(entradasRes.data || []).map((e) => ({ data: e.data_entrada, tipo: "Entrada", detalhe: e.observacoes || "—", delta: Number(e.quantidade), responsavel: e.usuario?.nome || "—" })),
    ...(ajustesRes.data || []).map((a) => ({
      data: a.created_at.slice(0, 10),
      tipo: Number(a.quantidade) > 0 ? "Ajuste (sobra)" : "Ajuste (perda/quebra)",
      detalhe: a.motivo,
      delta: Number(a.quantidade),
      responsavel: a.usuario?.nome || "—",
    })),
    ...(vendaItensRes.data || [])
      .filter((it) => it.venda?.status === "confirmada")
      .map((it) => ({ data: it.venda.data_venda, tipo: "Venda", detalhe: `Venda #${it.venda.numero}`, delta: -Number(it.quantidade), responsavel: it.venda.usuario?.nome || "—" })),
  ].sort((a, b) => new Date(b.data) - new Date(a.data));

  let saldoRodando = Number(produto?.estoque || 0);
  const linhas = eventos.map((ev) => {
    const saldoApos = saldoRodando;
    saldoRodando -= ev.delta;
    return { ...ev, saldoApos };
  });

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Estoque atual", produto ? produto.estoque : "—", "var(--accent)")}
      ${statCard("Estoque mínimo", produto ? produto.estoque_minimo : "—", "var(--text-muted)")}
      ${statCard("Lançamentos no extrato", linhas.length, "var(--text-muted)")}
    </div>
    <div class="card card-section">
      <p class="section-title">${escapeHtml(produto?.nome || "Produto")}${produto?.sku ? ` · ${escapeHtml(produto.sku)}` : ""}</p>
      ${linhas.length === 0
        ? '<div class="empty-state" style="padding: 1.5rem;">Nenhuma movimentação registrada para este produto ainda.</div>'
        : `<div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Data</th><th>Tipo</th><th>Detalhe</th><th>Responsável</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Saldo após</th></tr></thead>
              <tbody>
                ${linhas.map((l) => `
                  <tr>
                    <td>${formatDate(l.data)}</td>
                    <td>${escapeHtml(l.tipo)}</td>
                    <td class="cell-muted">${escapeHtml(l.detalhe)}</td>
                    <td class="cell-muted">${escapeHtml(l.responsavel || "—")}</td>
                    <td class="cell-num" style="color: ${l.delta >= 0 ? "var(--success)" : "var(--danger)"}; font-weight:600;">${l.delta >= 0 ? "+" : ""}${l.delta}</td>
                    <td class="cell-num">${l.saldoApos}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>`
      }
    </div>
  `;
}

async function load(view, state, opts = {}) {
  const { silent = false } = opts;
  const content = view.querySelector("#es-content");
  if (!silent) content.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const from = state.page * PAGE_SIZE;
  const { data, error, count } = await supabase
    .from("entradas_estoque")
    .select("id, quantidade, data_entrada, observacoes, conta_pagar_id, conta_pagar:contas_pagar(descricao), produto:produtos(nome, sku, estoque, estoque_minimo)", { count: "exact" })
    .gte("data_entrada", state.inicio)
    .lte("data_entrada", state.fim)
    .order("data_entrada", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (error) {
    content.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar as entradas de estoque</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  // Totais do período (todas as linhas, não só a página) + contagem de
  // produtos com estoque baixo — mesmo truque de segunda consulta enxuta
  // usado em Contas a Pagar/Receber para não recalcular sobre a página.
  const [{ data: todasDoPeriodo }, { data: produtosBaixos }] = await Promise.all([
    supabase.from("entradas_estoque").select("quantidade").gte("data_entrada", state.inicio).lte("data_entrada", state.fim).limit(5000),
    supabase.from("produtos").select("estoque, estoque_minimo, tipo").eq("ativo", true).limit(5000),
  ]);

  renderContent(view, state, data || [], count || 0, todasDoPeriodo || [], produtosBaixos || []);
}

function renderContent(view, state, linhas, count, todasDoPeriodo, produtos) {
  const content = view.querySelector("#es-content");
  const totalUnidades = todasDoPeriodo.reduce((sum, l) => sum + Number(l.quantidade || 0), 0);
  // Serviço nunca recebe entrada de estoque — excluído do cálculo pelo
  // mesmo motivo de home.js (senão fica "baixo" pra sempre).
  const estoqueBaixo = produtos.filter((p) => p.tipo === "produto" && Number(p.estoque) <= Number(p.estoque_minimo)).length;
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Entradas no período", todasDoPeriodo.length, "var(--accent)")}
      ${statCard("Unidades recebidas no período", totalUnidades, "var(--success)")}
      ${statCard("Produtos com estoque baixo", estoqueBaixo, estoqueBaixo > 0 ? "var(--danger)" : "var(--text-muted)")}
    </div>
    <div class="card card-section">
      <p class="section-title">Entradas de estoque</p>
      ${renderTabela(linhas)}
      ${totalPages > 1 ? `
        <div class="pagination">
          <button type="button" class="btn btn--ghost btn--sm" id="es-page-prev" ${state.page === 0 ? "disabled" : ""}>‹ Anterior</button>
          <span class="pagination__label">Página ${state.page + 1} de ${totalPages}</span>
          <button type="button" class="btn btn--ghost btn--sm" id="es-page-next" ${state.page >= totalPages - 1 ? "disabled" : ""}>Próxima ›</button>
        </div>
      ` : ""}
    </div>
  `;

  content.querySelectorAll("[data-excluir]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Excluir esta entrada de estoque? A quantidade será removida do saldo do produto.", { confirmLabel: "Excluir" });
      if (!ok) return;
      const { error } = await supabase.rpc("excluir_entrada_estoque", { p_entrada_id: btn.dataset.excluir });
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast("Entrada de estoque excluída.");
      load(view, state, { silent: true });
    });
  });

  if (totalPages > 1) {
    content.querySelector("#es-page-prev").addEventListener("click", () => {
      state.page = Math.max(0, state.page - 1);
      load(view, state);
    });
    content.querySelector("#es-page-next").addEventListener("click", () => {
      state.page += 1;
      load(view, state);
    });
  }
}

function statCard(label, value, tagColor) {
  return `
    <div class="card stat-card" style="--tag-color:${tagColor}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${value}</p>
    </div>
  `;
}

function renderTabela(linhas) {
  if (linhas.length === 0) {
    return '<div class="empty-state" style="padding: 1.5rem;">Nenhuma entrada de estoque neste período. Use "+ Nova entrada de estoque" para registrar a primeira.</div>';
  }
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Data</th><th>Produto</th><th style="text-align:right">Quantidade</th><th>Observações</th><th></th></tr>
        </thead>
        <tbody>
          ${linhas.map((l) => `
            <tr>
              <td>${formatDate(l.data_entrada)}</td>
              <td>
                ${escapeHtml(l.produto?.nome || "—")}
                ${l.produto?.sku ? `<span class="cell-muted"> · ${escapeHtml(l.produto.sku)}</span>` : ""}
              </td>
              <td class="cell-num">+${Number(l.quantidade)}</td>
              <td class="cell-muted">
                ${escapeHtml(l.observacoes || "—")}
                ${l.conta_pagar_id ? `<div class="cell-muted" style="font-size:0.72rem; margin-top:0.2rem;">Conta a pagar gerada</div>` : ""}
              </td>
              <td class="cell-actions">
                <button type="button" class="btn btn--danger btn--sm" data-excluir="${l.id}">Excluir</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Modal de nova entrada ─────────────────────────────────────────────────

function openEntradaForm(onSaved) {
  const admin = isAdmin();
  const body = openModal("Nova entrada de estoque");

  body.innerHTML = `
    <form id="es-form">
      <div id="es-form-error"></div>
      <div class="form-grid">
        ${admin ? `
        <div class="field field--full">
          <label>Empresa<span class="field-required">*</span></label>
          <div data-mount="es-empresa"></div>
        </div>
        ` : ""}
        <div class="field field--full">
          <label>Produto<span class="field-required">*</span></label>
          <div data-mount="es-produto"></div>
        </div>
        <div class="field">
          <label for="es-quantidade">Quantidade<span class="field-required">*</span></label>
          <input class="input" type="number" id="es-quantidade" min="1" step="1" required autofocus />
        </div>
        <div class="field">
          <label for="es-data">Data da entrada<span class="field-required">*</span></label>
          <input class="input" type="date" id="es-data" value="${todayStr()}" required />
        </div>
        <div class="field field--full">
          <label for="es-obs">Observações</label>
          <textarea class="input" id="es-obs" rows="2" placeholder="Ex.: nota fiscal, fornecedor, lote…"></textarea>
        </div>
      </div>

      <label class="cell-muted" style="display:flex; align-items:center; gap:0.5rem; margin-top:0.4rem; font-weight:600;">
        <input type="checkbox" id="es-gerar-conta" /> Gerar conta a pagar para esta entrada
      </label>
      <div class="form-grid" id="es-conta-fields" hidden style="margin-top:0.8rem;">
        <div class="field field--full">
          <label>Fornecedor<span class="field-required">*</span></label>
          <div data-mount="es-fornecedor"></div>
        </div>
        <div class="field">
          <label for="es-conta-valor">Valor da conta<span class="field-required">*</span></label>
          <input class="input" type="number" id="es-conta-valor" min="0.01" step="0.01" />
        </div>
        <div class="field">
          <label for="es-conta-vencimento">Vencimento<span class="field-required">*</span></label>
          <input class="input" type="date" id="es-conta-vencimento" value="${todayStr()}" />
        </div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="es-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Registrar entrada</button>
      </div>
    </form>
  `;

  const produtoSelect = createSearchSelect({
    container: body.querySelector('[data-mount="es-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    allowClear: false,
  });

  const empresaInicial = getCurrentEmpresaId();

  const fornecedorSelect = createSearchSelect({
    container: body.querySelector('[data-mount="es-fornecedor"]'),
    placeholder: "Buscar fornecedor…",
    options: [],
    allowClear: false,
    emptyText: admin ? "Escolha a empresa primeiro" : "Nenhum fornecedor cadastrado",
  });

  async function recarregarFornecedores(empresaId) {
    const fornecedores = await loadFornecedoresPorEmpresa(empresaId);
    fornecedorSelect.setOptions(fornecedorSearchOptions(fornecedores));
  }
  recarregarFornecedores(empresaInicial);

  const empresaSelect = admin
    ? createSearchSelect({
        container: body.querySelector('[data-mount="es-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: empresaInicial,
        allowClear: false,
        onChange: (empresaId) => recarregarFornecedores(empresaId),
      })
    : null;

  const gerarContaCheckbox = body.querySelector("#es-gerar-conta");
  const contaFields = body.querySelector("#es-conta-fields");
  gerarContaCheckbox.addEventListener("change", () => {
    contaFields.hidden = !gerarContaCheckbox.checked;
  });

  body.querySelector("#es-cancel").addEventListener("click", closeModal);

  body.querySelector("#es-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#es-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#es-form-error");
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

      const gerarConta = gerarContaCheckbox.checked;
      if (gerarConta && !fornecedorSelect.getValue()) {
        errorEl.innerHTML = `<div class="form-error">Selecione o fornecedor da conta a pagar.</div>`;
        return;
      }
      const valorConta = Number(body.querySelector("#es-conta-valor").value || 0);
      if (gerarConta && valorConta <= 0) {
        errorEl.innerHTML = `<div class="form-error">Informe o valor da conta a pagar.</div>`;
        return;
      }

      const payload = {
        p_produto_id: produtoId,
        p_quantidade: Number(body.querySelector("#es-quantidade").value || 0),
        p_data_entrada: body.querySelector("#es-data").value,
        p_observacoes: body.querySelector("#es-obs").value || null,
        p_gerar_conta_pagar: gerarConta,
        p_fornecedor_id: gerarConta ? fornecedorSelect.getValue() : null,
        p_valor_conta: gerarConta ? valorConta : null,
        p_vencimento_conta: gerarConta ? (body.querySelector("#es-conta-vencimento").value || null) : null,
      };
      if (admin) payload.p_empresa_id = empresaSelect.getValue();

      const { error } = await supabase.rpc("registrar_entrada_estoque", payload);

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast(gerarConta ? "Entrada de estoque registrada e conta a pagar gerada." : "Entrada de estoque registrada.");
      closeModal();
      produtosOptions = await loadProdutosVendaveis();
      if (onSaved) onSaved();
    });
  });
}

// ── Modal de ajuste manual de estoque (Roadmap Fase 2 — Kardex) ─────────
// Corrige uma contagem física divergente (perda, quebra, extravio, achado)
// sem editar o número de "Estoque atual" direto no cadastro do produto —
// mesmo racional de registrar_entrada_estoque, com o lançamento indo para
// ajustes_estoque em vez de entradas_estoque.
function openAjusteForm(onSaved) {
  const admin = isAdmin();
  const body = openModal("Ajuste de estoque");

  body.innerHTML = `
    <form id="aj-form">
      <div id="aj-form-error"></div>
      <div class="form-grid">
        ${admin ? `
        <div class="field field--full">
          <label>Empresa<span class="field-required">*</span></label>
          <div data-mount="aj-empresa"></div>
        </div>
        ` : ""}
        <div class="field field--full">
          <label>Produto<span class="field-required">*</span></label>
          <div data-mount="aj-produto"></div>
        </div>
        <div class="field">
          <label for="aj-tipo">Tipo de ajuste<span class="field-required">*</span></label>
          <select class="input" id="aj-tipo" required>
            <option value="perda">Perda/quebra (retira do estoque)</option>
            <option value="sobra">Sobra/achado (adiciona ao estoque)</option>
          </select>
        </div>
        <div class="field">
          <label for="aj-quantidade">Quantidade<span class="field-required">*</span></label>
          <input class="input" type="number" id="aj-quantidade" min="1" step="1" required autofocus />
        </div>
        <div class="field field--full">
          <label for="aj-motivo">Motivo<span class="field-required">*</span></label>
          <textarea class="input" id="aj-motivo" rows="2" placeholder="Ex.: contagem física, produto danificado, extravio…" required></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="aj-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Registrar ajuste</button>
      </div>
    </form>
  `;

  const produtoSelect = createSearchSelect({
    container: body.querySelector('[data-mount="aj-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    allowClear: false,
  });

  const empresaInicial = getCurrentEmpresaId();

  const empresaSelect = admin
    ? createSearchSelect({
        container: body.querySelector('[data-mount="aj-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: empresaInicial,
        allowClear: false,
      })
    : null;

  body.querySelector("#aj-cancel").addEventListener("click", closeModal);

  body.querySelector("#aj-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#aj-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#aj-form-error");
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

      const quantidadeAbs = Number(body.querySelector("#aj-quantidade").value || 0);
      if (quantidadeAbs <= 0) {
        errorEl.innerHTML = `<div class="form-error">Informe uma quantidade maior que zero.</div>`;
        return;
      }

      const motivo = body.querySelector("#aj-motivo").value.trim();
      if (!motivo) {
        errorEl.innerHTML = `<div class="form-error">Informe o motivo do ajuste.</div>`;
        return;
      }

      const tipo = body.querySelector("#aj-tipo").value;
      const payload = {
        p_produto_id: produtoId,
        p_quantidade: tipo === "perda" ? -quantidadeAbs : quantidadeAbs,
        p_motivo: motivo,
      };
      if (admin) payload.p_empresa_id = empresaSelect.getValue();

      const { error } = await supabase.rpc("registrar_ajuste_estoque", payload);

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast("Ajuste de estoque registrado.");
      closeModal();
      produtosOptions = await loadProdutosVendaveis();
      if (onSaved) onSaved();
    });
  });
}
