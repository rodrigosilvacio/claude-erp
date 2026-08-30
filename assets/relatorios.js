// ERPConnect — Relatórios: hub de relatórios corporativos. Antes só existia
// uma "Visão geral"; agora é um seletor entre cinco relatórios (Visão
// geral, Vendas, Financeiro, Estoque, CRM), cada um com suas próprias
// métricas — mesmo filtro de período (e de empresa, para admin global)
// compartilhado entre todos.

import { supabase } from "./supabaseClient.js";
import { formatCurrency, formatDate, escapeHtml, registerAutoRefresh, exportCsv, formatCsvNumber, createSearchSelect, showToast } from "./app.js";
import { isGlobalAdmin } from "./auth.js";
import { loadEmpresasAtivas, empresaSearchOptions } from "./catalogo.js";

const RELATORIO_DIAS_PADRAO = 90;

const TABS = [
  { key: "geral", label: "Visão geral" },
  { key: "vendas", label: "Vendas" },
  { key: "financeiro", label: "Financeiro" },
  { key: "estoque", label: "Estoque" },
  { key: "crm", label: "CRM" },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function diasAtrasStr(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function aplicaFiltros(query, state, dateCol) {
  let q = query.gte(dateCol, state.inicio).lte(dateCol, state.fim);
  if (state.empresaId) q = q.eq("empresa_id", state.empresaId);
  return q;
}

export async function render(view, actionsEl) {
  const state = { inicio: diasAtrasStr(RELATORIO_DIAS_PADRAO), fim: todayStr(), empresaId: null, tab: "geral", exportavel: null };

  const empresasOptions = isGlobalAdmin() ? await loadEmpresasAtivas() : [];

  // As abas ficam no topbar, junto do botão de ação primária — antes viviam
  // soltas no topo do conteúdo, numa segunda fileira desconectada da barra
  // de ações (mesmo ajuste em estoques.js).
  actionsEl.innerHTML = `
    <div class="topbar-tabs">
      ${TABS.map((t) => `<button type="button" class="btn btn--sm ${t.key === state.tab ? "btn--primary" : "btn--ghost"}" data-tab="${t.key}">${escapeHtml(t.label)}</button>`).join("")}
    </div>
    <button type="button" class="btn btn--ghost" id="btn-exportar-csv">Exportar CSV</button>
  `;

  actionsEl.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.tab === state.tab) return;
      state.tab = btn.dataset.tab;
      actionsEl.querySelectorAll("[data-tab]").forEach((b) => {
        b.className = `btn btn--sm ${b.dataset.tab === state.tab ? "btn--primary" : "btn--ghost"}`;
      });
      loadTab(view, state);
    });
  });

  actionsEl.querySelector("#btn-exportar-csv").addEventListener("click", () => {
    if (!state.exportavel) {
      showToast("Aguarde o relatório terminar de carregar antes de exportar.", "error");
      return;
    }
    exportCsv(state.exportavel.filename, state.exportavel.headers, state.exportavel.rows);
  });

  view.innerHTML = `
    <div class="toolbar financeiro-filtro">
      <div class="field financeiro-filtro__field--date">
        <label for="rel-inicio">De</label>
        <input class="input" type="date" id="rel-inicio" value="${state.inicio}" />
      </div>
      <div class="field financeiro-filtro__field--date">
        <label for="rel-fim">Até</label>
        <input class="input" type="date" id="rel-fim" value="${state.fim}" />
      </div>
      <div class="field financeiro-filtro__field--action">
        <label>&nbsp;</label>
        <button type="button" class="btn btn--ghost" id="rel-filtrar">Filtrar</button>
      </div>
      ${isGlobalAdmin() ? `<div class="field" style="min-width: 220px;"><label>&nbsp;</label><div data-mount="rel-empresa"></div></div>` : ""}
    </div>
    <div id="rel-content"><div class="empty-state">Carregando relatório…</div></div>
  `;

  view.querySelector("#rel-filtrar").addEventListener("click", () => {
    state.inicio = view.querySelector("#rel-inicio").value || state.inicio;
    state.fim = view.querySelector("#rel-fim").value || state.fim;
    loadTab(view, state);
  });

  if (isGlobalAdmin()) {
    createSearchSelect({
      container: view.querySelector('[data-mount="rel-empresa"]'),
      placeholder: "Todas as empresas",
      options: empresaSearchOptions(empresasOptions),
      allowClear: true,
      emptyText: "Nenhuma empresa encontrada",
      onChange: (empresaId) => {
        state.empresaId = empresaId;
        loadTab(view, state);
      },
    });
  }

  await loadTab(view, state);
  registerAutoRefresh(() => loadTab(view, state, { silent: true }), 20000);
}

async function loadTab(view, state, opts = {}) {
  const { silent = false } = opts;
  const content = view.querySelector("#rel-content");
  if (!silent) content.innerHTML = `<div class="empty-state">Carregando relatório…</div>`;

  if (state.tab === "geral") await loadGeral(content, state);
  else if (state.tab === "vendas") await loadVendas(content, state);
  else if (state.tab === "financeiro") await loadFinanceiro(content, state);
  else if (state.tab === "estoque") await loadEstoque(content, state);
  else if (state.tab === "crm") await loadCrm(content, state);
}

function erroBox(error) {
  return `<div class="empty-state"><p class="empty-state__title">Erro ao carregar relatório</p><p class="empty-state__hint">${escapeHtml(error.message)}</p></div>`;
}

function emptyBox(mensagem) {
  return `<div class="empty-state" style="padding: 1.5rem;">${escapeHtml(mensagem)}</div>`;
}

function statCard(label, value, tagColor) {
  return `
    <div class="card stat-card" style="--tag-color:${tagColor}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${value}</p>
    </div>
  `;
}

// Divide o período em até `maxBuckets` segmentos iguais e soma `valueKey`
// de cada linha no segmento correspondente — mesma técnica de barras
// usada no Painel Início, generalizada para qualquer intervalo de datas
// (não só o mês corrente).
function bucketizeByRange(rows, dateKey, valueKey, inicio, fim, maxBuckets = 10) {
  const start = new Date(`${inicio}T00:00:00`);
  const end = new Date(`${fim}T00:00:00`);
  const totalDays = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  const bucketCount = Math.max(1, Math.min(maxBuckets, totalDays));
  const bucketDays = Math.ceil(totalDays / bucketCount);
  const buckets = Array.from({ length: bucketCount }, () => 0);
  const labels = Array.from({ length: bucketCount }, (_, i) => {
    const bStart = new Date(start.getTime() + i * bucketDays * 86_400_000);
    return bStart.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  });
  for (const r of rows) {
    const d = new Date(`${r[dateKey]}T00:00:00`);
    const diffDays = Math.floor((d - start) / 86_400_000);
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(diffDays / bucketDays)));
    buckets[idx] += Number(r[valueKey] || 0);
  }
  return { buckets, labels };
}

function renderMiniBars(valores, labels) {
  if (valores.every((v) => v === 0)) {
    return emptyBox("Sem dados no período.");
  }
  const max = Math.max(1, ...valores);
  return `
    <div class="mini-bars">
      ${valores.map((v, i) => `
        <div class="mini-bars__col">
          <div class="mini-bars__track"><div class="mini-bars__bar" style="height:${Math.max(4, Math.round((v / max) * 100))}%" title="${formatCurrency(v)}"></div></div>
          <span class="mini-bars__label">${escapeHtml(labels[i])}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHbarList(rows, formatter = formatCurrency) {
  const max = Math.max(...rows.map((r) => r.total), 1);
  return `
    <div class="hbar-list">
      ${rows.map((r) => `
        <div class="hbar-row">
          <span class="hbar-row__label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
          <div class="hbar-row__track"><div class="hbar-row__fill" style="width:${Math.max(4, Math.round((r.total / max) * 100))}%"></div></div>
          <span class="hbar-row__value">${formatter(r.total)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

// ── Visão geral ───────────────────────────────────────────────────────

async function loadGeral(content, state) {
  const [vendasRes, parcelasRes, recebimentosRes] = await Promise.all([
    aplicaFiltros(
      supabase.from("vendas").select("id, numero, total, status, data_venda, cliente_id, cliente:clientes(nome), usuario:usuarios(id, nome), itens:venda_itens(produto_id, quantidade, subtotal, produto:produtos(nome, custo))"),
      state, "data_venda",
    ),
    aplicaFiltros(
      supabase.from("matricula_parcelas").select("id, numero_parcela, valor, data_pagamento, cliente_id, cliente:clientes(nome), matricula:matriculas(numero, usuario:usuarios(id, nome), produto:produtos(id, nome, custo))").eq("status", "pago"),
      state, "data_pagamento",
    ),
    aplicaFiltros(
      supabase.from("recebimentos").select("id, quantidade, valor, status, data_recebimento, cliente_id, cliente:clientes(nome), produto:produtos(id, nome, custo)"),
      state, "data_recebimento",
    ),
  ]);

  const firstError = vendasRes.error || parcelasRes.error || recebimentosRes.error;
  if (firstError) { content.innerHTML = erroBox(firstError); return; }

  const vendasConfirmadas = (vendasRes.data || []).filter((v) => v.status === "confirmada");
  const parcelasPagas = parcelasRes.data || [];
  const recebimentosOk = (recebimentosRes.data || []).filter((r) => r.status !== "cancelado");

  const transacoes = vendasConfirmadas.length + parcelasPagas.length + recebimentosOk.length;
  const faturamento = sum(vendasConfirmadas, "total") + sum(parcelasPagas, "valor") + sum(recebimentosOk, "valor");
  const ticketMedio = transacoes ? faturamento / transacoes : 0;

  const linhasProdutos = [
    ...vendaItemLinhas(vendasConfirmadas),
    ...parcelaProdutoLinhas(parcelasPagas),
    ...recebimentoProdutoLinhas(recebimentosOk),
  ];
  const topProdutos = aggregateProdutos(linhasProdutos);
  const custoTotal = linhasProdutos.reduce((s, l) => s + l.custo, 0);
  const margemBruta = faturamento - custoTotal;
  const margemPct = faturamento > 0 ? (margemBruta / faturamento) * 100 : 0;

  const topClientes = aggregateClientes([
    ...vendasConfirmadas.map((v) => ({ clienteId: v.cliente_id || "sem-cliente", clienteNome: v.cliente?.nome || "Sem cliente identificado", valor: Number(v.total || 0) })),
    ...parcelasPagas.map((p) => ({ clienteId: p.cliente_id || "sem-cliente", clienteNome: p.cliente?.nome || "Sem cliente identificado", valor: Number(p.valor || 0) })),
    ...recebimentosOk.map((r) => ({ clienteId: r.cliente_id || "sem-cliente", clienteNome: r.cliente?.nome || "Sem cliente identificado", valor: Number(r.valor || 0) })),
  ]);

  // Roadmap conectividade — vendas/matriculas.usuario_id (quem registrou)
  // não existia até aqui, então "ranking de vendedores" era literalmente
  // impossível de calcular. aggregateClientes é genérico o bastante (só
  // agrupa por id/nome/valor) pra reaproveitar sem duplicar lógica.
  const topVendedores = aggregateClientes([
    ...vendasConfirmadas.filter((v) => v.usuario).map((v) => ({ clienteId: v.usuario.id, clienteNome: v.usuario.nome, valor: Number(v.total || 0) })),
    ...parcelasPagas.filter((p) => p.matricula?.usuario).map((p) => ({ clienteId: p.matricula.usuario.id, clienteNome: p.matricula.usuario.nome, valor: Number(p.valor || 0) })),
  ]);

  const movimentacoesTodas = [
    ...vendasConfirmadas.map((v) => ({ data: v.data_venda, origem: `Venda #${v.numero}`, cliente: v.cliente?.nome || "Sem cliente", valor: Number(v.total || 0) })),
    ...parcelasPagas.map((p) => ({ data: p.data_pagamento, origem: `Matrícula #${p.matricula?.numero ?? "?"} · parcela ${p.numero_parcela}`, cliente: p.cliente?.nome || "Sem cliente", valor: Number(p.valor || 0) })),
    ...recebimentosOk.map((r) => ({ data: r.data_recebimento, origem: "Recebimento manual", cliente: r.cliente?.nome || "Sem cliente", valor: Number(r.valor || 0) })),
  ].sort((a, b) => new Date(b.data) - new Date(a.data));

  state.exportavel = {
    filename: `relatorio_geral_${state.inicio}_a_${state.fim}.csv`,
    headers: ["Data", "Origem", "Cliente", "Valor"],
    rows: movimentacoesTodas.map((l) => [l.data, l.origem, l.cliente, formatCsvNumber(l.valor)]),
  };

  content.innerHTML = `
    <p class="record-count" style="margin: 0 0 1rem;">Vendas, matrículas e recebimentos manuais entre ${formatDate(state.inicio)} e ${formatDate(state.fim)}.</p>
    <div class="stat-grid">
      ${statCard("Transações no período", transacoes, "var(--accent)")}
      ${statCard("Faturamento no período", formatCurrency(faturamento), "var(--accent-deep)")}
      ${statCard("Ticket médio", formatCurrency(ticketMedio), "var(--amber)")}
      ${statCard("Margem bruta", formatCurrency(margemBruta), "var(--success)")}
      ${statCard("Margem", `${margemPct.toFixed(1)}%`, "var(--success)")}
    </div>
    <p class="record-count" style="margin: -0.6rem 0 1rem; font-size: 0.78rem;">Margem = receita menos o custo de catálogo (Cadastros → Produtos) do item vendido — produto sem custo cadastrado entra com margem de 100%.</p>

    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Produtos e serviços mais vendidos</p>
        ${renderProdutosTable(topProdutos)}
      </div>
      <div class="card card-section">
        <p class="section-title">Melhores clientes</p>
        ${renderRankTable(topClientes, "Cliente", "Transações")}
      </div>
    </div>

    <div class="card card-section">
      <p class="section-title">Ranking de vendedores</p>
      ${topVendedores.length === 0 ? emptyBox("Sem vendas/matrículas atribuídas a um vendedor neste período.") : renderRankTable(topVendedores, "Vendedor", "Transações")}
    </div>

    <div class="card card-section">
      <p class="section-title">Últimas movimentações</p>
      ${renderMovimentacoes(movimentacoesTodas.slice(0, 10))}
    </div>
  `;
}

function vendaItemLinhas(vendas) {
  const linhas = [];
  for (const v of vendas) {
    for (const it of v.itens || []) {
      const quantidade = Number(it.quantidade || 0);
      linhas.push({
        produtoId: it.produto_id,
        produtoNome: it.produto?.nome || "Produto removido",
        quantidade,
        valor: Number(it.subtotal || 0),
        custo: Number(it.produto?.custo || 0) * quantidade,
      });
    }
  }
  return linhas;
}

function parcelaProdutoLinhas(parcelas) {
  return parcelas.map((p) => ({
    produtoId: p.matricula?.produto?.id || `matricula-${p.matricula?.numero ?? "sem-produto"}`,
    produtoNome: p.matricula?.produto?.nome || "Serviço (matrícula)",
    quantidade: 1,
    valor: Number(p.valor || 0),
    custo: Number(p.matricula?.produto?.custo || 0),
  }));
}

function recebimentoProdutoLinhas(recebimentos) {
  return recebimentos.map((r) => {
    const quantidade = Number(r.quantidade || 0);
    return {
      produtoId: r.produto?.id || "recebimento-sem-produto",
      produtoNome: r.produto?.nome || "Produto",
      quantidade,
      valor: Number(r.valor || 0),
      custo: Number(r.produto?.custo || 0) * quantidade,
    };
  });
}

function aggregateProdutos(linhas) {
  const map = new Map();
  for (const l of linhas) {
    if (!map.has(l.produtoId)) map.set(l.produtoId, { label: l.produtoNome, quantidade: 0, total: 0, custo: 0 });
    const entry = map.get(l.produtoId);
    entry.quantidade += l.quantidade;
    entry.total += l.valor;
    entry.custo += l.custo;
  }
  return Array.from(map.values())
    .map((entry) => ({ ...entry, margem: entry.total - entry.custo, margemPct: entry.total > 0 ? ((entry.total - entry.custo) / entry.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
}

function aggregateClientes(linhas) {
  const map = new Map();
  for (const l of linhas) {
    if (!map.has(l.clienteId)) map.set(l.clienteId, { label: l.clienteNome, quantidade: 0, total: 0 });
    const entry = map.get(l.clienteId);
    entry.quantidade += 1;
    entry.total += l.valor;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 6);
}

function renderRankTable(rows, labelHeader, qtyHeader) {
  if (rows.length === 0) return emptyBox("Sem dados suficientes ainda.");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>${escapeHtml(labelHeader)}</th><th style="text-align:right">${escapeHtml(qtyHeader)}</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="cell-num">${r.quantidade}</td><td class="cell-num">${formatCurrency(r.total)}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProdutosTable(rows) {
  if (rows.length === 0) return emptyBox("Sem dados suficientes ainda.");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>Produto / serviço</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Receita</th><th style="text-align:right">Margem</th><th style="text-align:right">Margem %</th></tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${escapeHtml(r.label)}</td>
              <td class="cell-num">${r.quantidade}</td>
              <td class="cell-num">${formatCurrency(r.total)}</td>
              <td class="cell-num">${formatCurrency(r.margem)}</td>
              <td class="cell-num" style="color: ${r.margemPct < 0 ? "var(--danger)" : "var(--success)"};">${r.margemPct.toFixed(0)}%</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderMovimentacoes(linhas) {
  if (linhas.length === 0) return emptyBox("Nenhuma movimentação neste período.");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Data</th><th>Origem</th><th>Cliente</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>
          ${linhas.map((l) => `
            <tr>
              <td>${formatDate(l.data)}</td>
              <td>${escapeHtml(l.origem)}</td>
              <td>${escapeHtml(l.cliente)}</td>
              <td class="cell-num">${formatCurrency(l.valor)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Vendas ────────────────────────────────────────────────────────────

const VENDA_STATUS_LABEL = { orcamento: "Orçamento", confirmada: "Confirmada", cancelada: "Cancelada" };

async function loadVendas(content, state) {
  const { data, error } = await aplicaFiltros(
    supabase.from("vendas").select("id, numero, data_venda, status, forma_pagamento, total, cliente:clientes(nome)"),
    state, "data_venda",
  ).order("data_venda", { ascending: false }).limit(2000);

  if (error) { content.innerHTML = erroBox(error); return; }

  const vendas = data || [];
  const confirmadas = vendas.filter((v) => v.status === "confirmada");
  const canceladas = vendas.filter((v) => v.status === "cancelada");
  const totalConfirmadas = sum(confirmadas, "total");
  const ticketMedio = confirmadas.length ? totalConfirmadas / confirmadas.length : 0;
  const taxaCancelamento = (confirmadas.length + canceladas.length) > 0 ? (canceladas.length / (confirmadas.length + canceladas.length)) * 100 : 0;

  const porForma = new Map();
  confirmadas.forEach((v) => {
    const forma = v.forma_pagamento || "Não informado";
    porForma.set(forma, (porForma.get(forma) || 0) + Number(v.total || 0));
  });
  const formasRows = Array.from(porForma, ([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total);

  const { buckets, labels } = bucketizeByRange(confirmadas, "data_venda", "total", state.inicio, state.fim);

  state.exportavel = {
    filename: `vendas_${state.inicio}_a_${state.fim}.csv`,
    headers: ["Nº", "Data", "Cliente", "Status", "Forma de pagamento", "Total"],
    rows: vendas.map((v) => [v.numero, v.data_venda, v.cliente?.nome || "", VENDA_STATUS_LABEL[v.status] || v.status, v.forma_pagamento || "", formatCsvNumber(v.total)]),
  };

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Vendas confirmadas", confirmadas.length, "var(--accent)")}
      ${statCard("Faturamento", formatCurrency(totalConfirmadas), "var(--accent-deep)")}
      ${statCard("Ticket médio", formatCurrency(ticketMedio), "var(--amber)")}
      ${statCard("Taxa de cancelamento", `${taxaCancelamento.toFixed(1)}%`, canceladas.length > 0 ? "var(--danger)" : "var(--text-muted)")}
    </div>
    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Vendas confirmadas no período</p>
        ${renderMiniBars(buckets, labels)}
      </div>
      <div class="card card-section">
        <p class="section-title">Por forma de pagamento</p>
        ${formasRows.length ? renderHbarList(formasRows) : emptyBox("Sem vendas confirmadas no período.")}
      </div>
    </div>
    <div class="card card-section">
      <p class="section-title">Vendas no período</p>
      ${renderVendasTable(vendas.slice(0, 200))}
      ${vendas.length > 200 ? `<p class="cell-muted" style="margin-top: 0.6rem;">Mostrando as 200 mais recentes de ${vendas.length}. Exporte o CSV para ver todas.</p>` : ""}
    </div>
  `;
}

function renderVendasTable(vendas) {
  if (vendas.length === 0) return emptyBox("Nenhuma venda neste período.");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Status</th><th>Forma</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${vendas.map((v) => `
            <tr>
              <td class="cell-num">#${v.numero}</td>
              <td>${formatDate(v.data_venda)}</td>
              <td>${escapeHtml(v.cliente?.nome || "—")}</td>
              <td><span class="status status--${v.status}">${escapeHtml(VENDA_STATUS_LABEL[v.status] || v.status)}</span></td>
              <td class="cell-muted">${escapeHtml(v.forma_pagamento || "—")}</td>
              <td class="cell-num">${formatCurrency(v.total)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ── Financeiro ────────────────────────────────────────────────────────

async function loadFinanceiro(content, state) {
  const [vendasRes, parcelasRes, recebimentosRes, contasRes] = await Promise.all([
    aplicaFiltros(supabase.from("vendas").select("id, total, status, data_venda"), state, "data_venda"),
    aplicaFiltros(supabase.from("matricula_parcelas").select("id, valor, status, data_pagamento").eq("status", "pago"), state, "data_pagamento"),
    aplicaFiltros(supabase.from("recebimentos").select("id, valor, status, data_recebimento"), state, "data_recebimento"),
    aplicaFiltros(supabase.from("contas_pagar").select("id, valor, status, data_pagamento, fornecedor:fornecedores(nome)").eq("status", "pago"), state, "data_pagamento"),
  ]);

  const firstError = vendasRes.error || parcelasRes.error || recebimentosRes.error || contasRes.error;
  if (firstError) { content.innerHTML = erroBox(firstError); return; }

  const vendasConfirmadas = (vendasRes.data || []).filter((v) => v.status === "confirmada");
  const parcelasPagas = parcelasRes.data || [];
  const recebimentosOk = (recebimentosRes.data || []).filter((r) => r.status !== "cancelado");
  const contasPagas = contasRes.data || [];

  const totalVendas = sum(vendasConfirmadas, "total");
  const totalParcelas = sum(parcelasPagas, "valor");
  const totalRecebimentos = sum(recebimentosOk, "valor");
  const entradas = totalVendas + totalParcelas + totalRecebimentos;
  const saidas = sum(contasPagas, "valor");
  const saldo = entradas - saidas;

  const origemEntradas = [
    { label: "Vendas", total: totalVendas },
    { label: "Matrículas", total: totalParcelas },
    { label: "Recebimentos manuais", total: totalRecebimentos },
  ].filter((r) => r.total > 0);

  const porFornecedor = new Map();
  contasPagas.forEach((c) => {
    const nome = c.fornecedor?.nome || "Não informado";
    porFornecedor.set(nome, (porFornecedor.get(nome) || 0) + Number(c.valor || 0));
  });
  const fornecedorRows = Array.from(porFornecedor, ([label, total]) => ({ label, total })).sort((a, b) => b.total - a.total).slice(0, 8);

  const entradasBuckets = bucketizeByRange(
    [
      ...vendasConfirmadas.map((v) => ({ data: v.data_venda, valor: v.total })),
      ...parcelasPagas.map((p) => ({ data: p.data_pagamento, valor: p.valor })),
      ...recebimentosOk.map((r) => ({ data: r.data_recebimento, valor: r.valor })),
    ],
    "data", "valor", state.inicio, state.fim,
  );
  const saidasBuckets = bucketizeByRange(contasPagas.map((c) => ({ data: c.data_pagamento, valor: c.valor })), "data", "valor", state.inicio, state.fim);

  state.exportavel = {
    filename: `financeiro_${state.inicio}_a_${state.fim}.csv`,
    headers: ["Categoria", "Total"],
    rows: [
      ...origemEntradas.map((r) => [`Entrada — ${r.label}`, formatCsvNumber(r.total)]),
      ...fornecedorRows.map((r) => [`Saída — ${r.label}`, formatCsvNumber(r.total)]),
    ],
  };

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Entradas", formatCurrency(entradas), "var(--accent-deep)")}
      ${statCard("Saídas", formatCurrency(saidas), "var(--danger)")}
      ${statCard("Saldo", formatCurrency(saldo), saldo >= 0 ? "var(--accent)" : "var(--danger)")}
    </div>
    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Entradas por origem</p>
        ${origemEntradas.length ? renderHbarList(origemEntradas) : emptyBox("Sem entradas no período.")}
      </div>
      <div class="card card-section">
        <p class="section-title">Maiores saídas por fornecedor</p>
        ${fornecedorRows.length ? renderHbarList(fornecedorRows) : emptyBox("Sem saídas no período.")}
      </div>
    </div>
    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Entradas no período</p>
        ${renderMiniBars(entradasBuckets.buckets, entradasBuckets.labels)}
      </div>
      <div class="card card-section">
        <p class="section-title">Saídas no período</p>
        ${renderMiniBars(saidasBuckets.buckets, saidasBuckets.labels)}
      </div>
    </div>
  `;
}

// ── Estoque ───────────────────────────────────────────────────────────

async function loadEstoque(content, state) {
  let query = supabase.from("produtos").select("id, nome, sku, estoque, estoque_minimo, custo, tipo").eq("ativo", true).eq("tipo", "produto");
  if (state.empresaId) query = query.eq("empresa_id", state.empresaId);
  const { data, error } = await query;
  if (error) { content.innerHTML = erroBox(error); return; }

  const produtos = data || [];
  const estoqueBaixo = produtos.filter((p) => p.estoque <= p.estoque_minimo).sort((a, b) => a.estoque - b.estoque);
  const valorImobilizado = produtos.reduce((s, p) => s + Number(p.estoque || 0) * Number(p.custo || 0), 0);
  const topValor = produtos
    .map((p) => ({ label: p.nome, total: Number(p.estoque || 0) * Number(p.custo || 0) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  state.exportavel = {
    filename: `estoque_${todayStr()}.csv`,
    headers: ["Produto", "SKU", "Estoque", "Mínimo", "Custo unit.", "Valor imobilizado"],
    rows: produtos.map((p) => [p.nome, p.sku || "", p.estoque, p.estoque_minimo, formatCsvNumber(p.custo), formatCsvNumber(Number(p.estoque || 0) * Number(p.custo || 0))]),
  };

  content.innerHTML = `
    <p class="record-count" style="margin: 0 0 1rem;">Situação atual do estoque — não depende do período selecionado acima.</p>
    <div class="stat-grid">
      ${statCard("Produtos ativos", produtos.length, "var(--text-muted)")}
      ${statCard("Estoque baixo", estoqueBaixo.length, estoqueBaixo.length > 0 ? "var(--danger)" : "var(--text-muted)")}
      ${statCard("Valor imobilizado em estoque", formatCurrency(valorImobilizado), "var(--accent-deep)")}
    </div>
    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Estoque baixo</p>
        ${estoqueBaixo.length === 0 ? emptyBox("Nenhum produto abaixo do estoque mínimo.") : renderEstoqueBaixoTable(estoqueBaixo)}
      </div>
      <div class="card card-section">
        <p class="section-title">Maior valor imobilizado</p>
        ${topValor.length === 0 ? emptyBox("Nenhum produto com custo cadastrado.") : renderHbarList(topValor)}
      </div>
    </div>
  `;
}

function renderEstoqueBaixoTable(estoqueBaixo) {
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Produto</th><th style="text-align:right">Estoque</th><th style="text-align:right">Mínimo</th></tr></thead>
        <tbody>
          ${estoqueBaixo.slice(0, 10).map((p) => `
            <tr>
              <td>${escapeHtml(p.nome)}</td>
              <td class="cell-num" style="color: var(--danger); font-weight:700;">${p.estoque}</td>
              <td class="cell-num">${p.estoque_minimo}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    ${estoqueBaixo.length > 10 ? `<p class="cell-muted" style="margin-top: 0.5rem;">+${estoqueBaixo.length - 10} produto(s) — exporte o CSV para ver todos.</p>` : ""}
  `;
}

// ── CRM ───────────────────────────────────────────────────────────────

const PROPOSTA_STATUS_LABEL = { draft: "Rascunho", enviada: "Enviada", aprovada: "Aprovada", reprovada: "Reprovada" };
const CRM_STAGE_DEFS = [
  { key: "draft", label: "Rascunho", color: "var(--text-muted)" },
  { key: "enviada", label: "Enviada", color: "var(--info)" },
  { key: "aprovada", label: "Aprovada", color: "var(--accent)" },
  { key: "reprovada", label: "Reprovada", color: "var(--danger)" },
];

async function loadCrm(content, state) {
  let query = supabase
    .from("propostas")
    .select("id, numero, status, total, data_proposta, motivo, origem, enviada_em, respondida_em, tipo_contato, lead_nome, cliente:clientes(nome)")
    .gte("data_proposta", state.inicio)
    .lte("data_proposta", state.fim);
  if (state.empresaId) query = query.eq("empresa_id", state.empresaId);
  const { data, error } = await query.order("data_proposta", { ascending: false }).limit(2000);
  if (error) { content.innerHTML = erroBox(error); return; }

  const propostas = data || [];
  const counts = { draft: 0, enviada: 0, aprovada: 0, reprovada: 0 };
  propostas.forEach((p) => { if (counts[p.status] !== undefined) counts[p.status]++; });
  const fechadas = counts.aprovada + counts.reprovada;
  const taxaConversao = fechadas > 0 ? (counts.aprovada / fechadas) * 100 : 0;
  const aprovadas = propostas.filter((p) => p.status === "aprovada");
  const ticketMedioAprovado = aprovadas.length ? sum(aprovadas, "total") / aprovadas.length : 0;
  const valorTotalPropostas = sum(propostas, "total");

  const motivos = new Map();
  propostas.filter((p) => p.status === "reprovada" && p.motivo).forEach((p) => {
    const chave = p.motivo.trim();
    motivos.set(chave, (motivos.get(chave) || 0) + 1);
  });
  const motivosRows = Array.from(motivos, ([label, qtd]) => ({ label, total: qtd })).sort((a, b) => b.total - a.total).slice(0, 8);

  // Roadmap conectividade — enviada_em/respondida_em já eram gravados por
  // atualizar_status_proposta, mas nenhuma tela usava: dado pronto pra
  // medir ciclo de venda (tempo até o cliente responder) que só faltava
  // aparecer em algum lugar.
  const respondidas = propostas.filter((p) => p.enviada_em && p.respondida_em);
  const tempoMedioRespostaHoras = respondidas.length
    ? respondidas.reduce((soma, p) => soma + (new Date(p.respondida_em) - new Date(p.enviada_em)), 0) / respondidas.length / 3_600_000
    : null;

  const origens = new Map();
  propostas.forEach((p) => {
    const chave = (p.origem || "").trim() || "Não informada";
    origens.set(chave, (origens.get(chave) || 0) + 1);
  });
  const origemRows = Array.from(origens, ([label, qtd]) => ({ label, total: qtd })).sort((a, b) => b.total - a.total).slice(0, 8);

  state.exportavel = {
    filename: `crm_propostas_${state.inicio}_a_${state.fim}.csv`,
    headers: ["Nº", "Data", "Contato", "Status", "Total", "Motivo (se reprovada)"],
    rows: propostas.map((p) => [
      p.numero,
      p.data_proposta,
      p.tipo_contato === "cliente" ? (p.cliente?.nome || "") : (p.lead_nome || ""),
      PROPOSTA_STATUS_LABEL[p.status] || p.status,
      formatCsvNumber(p.total),
      p.motivo || "",
    ]),
  };

  content.innerHTML = `
    <div class="stat-grid">
      ${statCard("Propostas no período", propostas.length, "var(--info)")}
      ${statCard("Valor total propostas", formatCurrency(valorTotalPropostas), "var(--accent)")}
      ${statCard("Taxa de conversão", `${taxaConversao.toFixed(0)}%`, "var(--success)")}
      ${statCard("Ticket médio aprovado", formatCurrency(ticketMedioAprovado), "var(--amber)")}
      ${statCard("Tempo médio de resposta", formatDuracaoHoras(tempoMedioRespostaHoras), "var(--info)")}
    </div>
    <div class="card card-section">
      <p class="section-title">Propostas por estágio</p>
      ${propostas.length === 0 ? emptyBox("Nenhuma proposta neste período.") : `
        <div class="stage-bar">
          ${CRM_STAGE_DEFS.map((s) => counts[s.key] > 0 ? `<div class="stage-bar__seg" style="flex:${counts[s.key]}; background:${s.color};" title="${s.label}: ${counts[s.key]}"></div>` : "").join("")}
        </div>
        <div class="stage-bar__legend">
          ${CRM_STAGE_DEFS.map((s) => `<span class="stage-bar__legend-item"><span class="stage-bar__dot" style="background:${s.color}"></span>${escapeHtml(s.label)} (${counts[s.key]})</span>`).join("")}
        </div>
      `}
    </div>
    <div class="report-grid">
      <div class="card card-section">
        <p class="section-title">Principais motivos de reprovação</p>
        ${motivosRows.length === 0 ? emptyBox("Nenhuma proposta reprovada com motivo registrado neste período.") : renderHbarList(motivosRows, (v) => `${v}×`)}
      </div>
      <div class="card card-section">
        <p class="section-title">Propostas por origem</p>
        ${origemRows.length === 0 ? emptyBox("Nenhuma proposta neste período.") : renderHbarList(origemRows, (v) => `${v}×`)}
      </div>
    </div>
    <div class="card card-section">
      <p class="section-title">Propostas recentes</p>
      ${renderPropostasTable(propostas.slice(0, 10))}
    </div>
  `;
}

function formatDuracaoHoras(horas) {
  if (horas == null) return "—";
  if (horas < 24) return `${horas.toFixed(1)}h`;
  return `${(horas / 24).toFixed(1)}d`;
}

function renderPropostasTable(propostas) {
  if (propostas.length === 0) return emptyBox("Nenhuma proposta neste período.");
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Nº</th><th>Contato</th><th>Status</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${propostas.map((p) => `
            <tr>
              <td class="cell-num">#${p.numero}</td>
              <td>${escapeHtml(p.tipo_contato === "cliente" ? (p.cliente?.nome || "—") : (p.lead_nome || "—"))}</td>
              <td><span class="status status--${p.status}">${escapeHtml(PROPOSTA_STATUS_LABEL[p.status] || p.status)}</span></td>
              <td class="cell-num">${formatCurrency(p.total)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}
