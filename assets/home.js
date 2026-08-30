// ERPConnect — Início > Painel executivo: visão gerencial consolidada, não
// mais uma pilha de tabelas de números crus. Cada seção segue um módulo do
// app (CRM, Vendas, Financeiro, Estoques) e responde à mesma pergunta que
// um gestor faria: "como estamos indo, e comparado a antes?" — por isso os
// indicadores financeiros trazem a variação vs. o mesmo período do mês
// anterior, não só o valor absoluto do mês corrente.

import { supabase } from "./supabaseClient.js";
import { formatCurrency, formatDate, escapeHtml, registerAutoRefresh, createSearchSelect } from "./app.js";
import { getCurrentEmpresaId, isGlobalAdmin } from "./auth.js";
import { loadEmpresasAtivas, empresaSearchOptions } from "./catalogo.js";

function toKey(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysStr(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return toKey(d);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function formatFullDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const text = d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export async function render(view, actionsEl) {
  const state = { empresaId: null };

  // Roadmap Fase 2 — "Painel e Relatórios por empresa": um admin global via
  // Início somando TODAS as empresas sem quebra nem filtro. Quem não é
  // admin global nem precisa do seletor: já está implicitamente restrito à
  // própria empresa pela RLS.
  if (isGlobalAdmin()) {
    const empresas = await loadEmpresasAtivas();
    actionsEl.innerHTML = `<div style="min-width:240px;" data-mount="home-empresa"></div>`;
    createSearchSelect({
      container: actionsEl.querySelector('[data-mount="home-empresa"]'),
      placeholder: "Todas as empresas",
      options: empresaSearchOptions(empresas),
      allowClear: true,
      emptyText: "Nenhuma empresa encontrada",
      onChange: (empresaId) => {
        state.empresaId = empresaId;
        load(view, state);
      },
    });
  } else {
    actionsEl.innerHTML = "";
  }

  await load(view, state);
  registerAutoRefresh(() => load(view, state, { silent: true }), 20000);
}

async function load(view, state, opts = {}) {
  const { silent = false } = opts;
  if (!silent) view.innerHTML = `<div class="empty-state">Carregando painel…</div>`;

  const hoje = new Date();
  const hojeKey = toKey(hoje);
  const inicioMesAtual = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const fimMesAnteriorEquivalente = new Date(hoje.getFullYear(), hoje.getMonth() - 1, hoje.getDate());

  const empresaId = state.empresaId || getCurrentEmpresaId();
  const aplicaEmpresa = (query) => (empresaId ? query.eq("empresa_id", empresaId) : query);

  // Uma única consulta por origem cobre os dois períodos (mês atual +
  // equivalente do mês anterior) — a partir do início do mês anterior até
  // hoje — e o front separa os dois intervalos depois. Mesmo espírito de
  // "busca ampla, filtra na memória" já usado no kardex de estoque e no
  // board do CRM.
  const [vendasRes, parcelasRes, recebimentosRes, contasPagarRes, produtosRes, propostasRes, contasFuturasRes, parcelasFuturasRes, vendaParcelasFuturasRes, empresaRes] = await Promise.all([
    aplicaEmpresa(supabase
      .from("vendas")
      .select("id, numero, total, status, data_venda, cliente:clientes(nome), itens:venda_itens(produto_id, quantidade, subtotal, produto:produtos(nome))")
      .gte("data_venda", toKey(inicioMesAnterior))),
    // Entrada de matrícula é o pagamento de cada parcela, não a data da
    // matrícula em si — uma parcela paga este mês pode ser de uma matrícula
    // feita há vários meses (ver financeiro.js, mesmo racional).
    aplicaEmpresa(supabase
      .from("matricula_parcelas")
      .select("id, numero_parcela, valor, data_pagamento, cliente:clientes(nome), matricula:matriculas(numero, produto:produtos(id, nome))")
      .eq("status", "pago")
      .gte("data_pagamento", toKey(inicioMesAnterior))),
    aplicaEmpresa(supabase
      .from("recebimentos")
      .select("id, quantidade, valor, status, data_recebimento, cliente:clientes(nome), produto:produtos(id, nome)")
      .gte("data_recebimento", toKey(inicioMesAnterior))),
    aplicaEmpresa(supabase
      .from("contas_pagar")
      .select("id, descricao, valor, data_pagamento, fornecedor:fornecedores(nome)")
      .eq("status", "pago")
      .gte("data_pagamento", toKey(inicioMesAnterior))),
    aplicaEmpresa(supabase.from("produtos").select("id, nome, estoque, estoque_minimo, tipo").eq("ativo", true)),
    // CRM — pipeline inteiro (sem filtro de data: "em aberto" é sempre o
    // estado atual) + o suficiente pra medir taxa de conversão do mês.
    aplicaEmpresa(supabase.from("propostas").select("id, numero, status, total, data_proposta, validade_ate").limit(1000)),
    aplicaEmpresa(supabase.from("contas_pagar").select("valor, data_vencimento").eq("status", "pendente").lte("data_vencimento", addDaysStr(90))),
    aplicaEmpresa(supabase.from("matricula_parcelas").select("valor, data_vencimento").eq("status", "pendente").lte("data_vencimento", addDaysStr(90))),
    aplicaEmpresa(supabase.from("venda_parcelas").select("valor, data_vencimento").eq("status", "pendente").lte("data_vencimento", addDaysStr(90))),
    empresaId
      ? supabase.from("empresas").select("nome_fantasia").eq("id", empresaId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const firstError = vendasRes.error || parcelasRes.error || recebimentosRes.error || contasPagarRes.error || produtosRes.error || propostasRes.error || contasFuturasRes.error || parcelasFuturasRes.error || vendaParcelasFuturasRes.error;
  if (firstError) {
    view.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar o painel</p><p class="empty-state__hint">${escapeHtml(firstError.message)}</p></div>`;
    return;
  }

  const inicioMesAtualKey = toKey(inicioMesAtual);
  const inicioMesAnteriorKey = toKey(inicioMesAnterior);
  const fimMesAnteriorKey = toKey(fimMesAnteriorEquivalente);
  const noPeriodo = (data, inicio, fim) => data >= inicio && data <= fim;

  const vendasConfirmadas = (vendasRes.data || []).filter((v) => v.status === "confirmada");
  const vendasMes = vendasConfirmadas.filter((v) => noPeriodo(v.data_venda, inicioMesAtualKey, hojeKey));
  const vendasMesAnterior = vendasConfirmadas.filter((v) => noPeriodo(v.data_venda, inicioMesAnteriorKey, fimMesAnteriorKey));

  const parcelasPagas = parcelasRes.data || [];
  const parcelasMes = parcelasPagas.filter((p) => noPeriodo(p.data_pagamento, inicioMesAtualKey, hojeKey));
  const parcelasMesAnterior = parcelasPagas.filter((p) => noPeriodo(p.data_pagamento, inicioMesAnteriorKey, fimMesAnteriorKey));

  const recebimentosOk = (recebimentosRes.data || []).filter((r) => r.status !== "cancelado");
  const recebimentosMes = recebimentosOk.filter((r) => noPeriodo(r.data_recebimento, inicioMesAtualKey, hojeKey));
  const recebimentosMesAnterior = recebimentosOk.filter((r) => noPeriodo(r.data_recebimento, inicioMesAnteriorKey, fimMesAnteriorKey));

  const contasPagas = contasPagarRes.data || [];
  const contasPagasMes = contasPagas.filter((c) => noPeriodo(c.data_pagamento, inicioMesAtualKey, hojeKey));
  const contasPagasMesAnterior = contasPagas.filter((c) => noPeriodo(c.data_pagamento, inicioMesAnteriorKey, fimMesAnteriorKey));

  const entradasMes = sum(vendasMes, "total") + sum(parcelasMes, "valor") + sum(recebimentosMes, "valor");
  const entradasMesAnterior = sum(vendasMesAnterior, "total") + sum(parcelasMesAnterior, "valor") + sum(recebimentosMesAnterior, "valor");
  const saidasMes = sum(contasPagasMes, "valor");
  const saidasMesAnterior = sum(contasPagasMesAnterior, "valor");
  const saldoMes = entradasMes - saidasMes;
  const saldoMesAnterior = entradasMesAnterior - saidasMesAnterior;

  const totalVendasMes = sum(vendasMes, "total");
  const totalVendasMesAnterior = sum(vendasMesAnterior, "total");
  const ticketMedioVendas = vendasMes.length > 0 ? totalVendasMes / vendasMes.length : 0;

  // Serviço (tipo="servico") nunca recebe entrada de estoque — comparar
  // estoque/estoque_minimo pra ele só gera falso positivo permanente (ver
  // migration 0017: estoque só existe de verdade pra tipo="produto").
  const produtosFisicos = (produtosRes.data || []).filter((p) => p.tipo === "produto");
  const estoqueBaixo = produtosFisicos.filter((p) => p.estoque <= p.estoque_minimo).sort((a, b) => a.estoque - b.estoque);
  const pctEstoqueSaudavel = produtosFisicos.length > 0 ? ((produtosFisicos.length - estoqueBaixo.length) / produtosFisicos.length) * 100 : 100;

  const nomeFantasia = empresaRes?.data?.nome_fantasia || "";

  const topProdutosServicos = aggregateProdutos([
    ...vendaItemLinhas(vendasMes),
    ...parcelaLinhas(parcelasMes),
    ...recebimentoLinhas(recebimentosMes),
  ]);

  const linhasMovimentacoes = movimentacoes(vendasMes, parcelasMes, recebimentosMes, contasPagasMes).slice(0, 8);

  const contasFuturas = contasFuturasRes.data || [];
  const parcelasFuturas = [...(parcelasFuturasRes.data || []), ...(vendaParcelasFuturasRes.data || [])];
  const projecao30 = projecaoCaixa(contasFuturas, parcelasFuturas, 30);
  const projecao60 = projecaoCaixa(contasFuturas, parcelasFuturas, 60);
  const projecao90 = projecaoCaixa(contasFuturas, parcelasFuturas, 90);

  const propostasAll = propostasRes.data || [];
  const statusCounts = { draft: 0, enviada: 0, aprovada: 0, reprovada: 0 };
  propostasAll.forEach((p) => { if (statusCounts[p.status] !== undefined) statusCounts[p.status]++; });
  const emAberto = propostasAll.filter((p) => p.status === "draft" || p.status === "enviada");
  const valorEmAberto = sum(emAberto, "total");
  const propostasFechadasMes = propostasAll.filter((p) => (p.status === "aprovada" || p.status === "reprovada") && noPeriodo(p.data_proposta, inicioMesAtualKey, hojeKey));
  const aprovadasMes = propostasFechadasMes.filter((p) => p.status === "aprovada").length;
  const taxaConversaoMes = propostasFechadasMes.length > 0 ? (aprovadasMes / propostasFechadasMes.length) * 100 : null;

  view.innerHTML = `
    <div class="home-hero">
      <p class="home-hero__eyebrow">${greeting()}, equipe comercial</p>
      <h2 class="home-hero__title">${formatFullDate(hojeKey)}</h2>
      ${nomeFantasia ? `<p class="home-hero__empresa">${escapeHtml(nomeFantasia)}</p>` : ""}
    </div>

    <div class="quick-actions">
      <a class="quick-action" href="#/vendas">
        <span class="quick-action__title">+ Nova venda</span>
        <span class="quick-action__hint">Registrar uma venda no caixa</span>
      </a>
      <a class="quick-action" href="#/matriculas">
        <span class="quick-action__title">+ Nova matrícula</span>
        <span class="quick-action__hint">Contratar um curso ou serviço</span>
      </a>
      <a class="quick-action" href="#/crm">
        <span class="quick-action__title">CRM</span>
        <span class="quick-action__hint">Ver o funil de propostas</span>
      </a>
      <a class="quick-action" href="#/relatorios">
        <span class="quick-action__title">Relatórios</span>
        <span class="quick-action__hint">Visões corporativas completas</span>
      </a>
    </div>

    <div class="dash-grid-2 dash-section">
      <div class="card card-section">
        <div class="dash-section__head">
          <p class="section-title" style="margin:0;">CRM — Propostas</p>
          <span class="dash-section__kicker">Pipeline atual</span>
        </div>
        ${propostasAll.length === 0
          ? `<div class="empty-state" style="padding: 1.5rem;">Nenhuma proposta cadastrada ainda.</div>`
          : `
            ${renderStageBar(statusCounts)}
            <div class="stat-grid" style="margin-top: 1rem; grid-template-columns: repeat(2, 1fr);">
              ${statCard("Em aberto", `${emAberto.length} · ${formatCurrency(valorEmAberto)}`, "var(--info)")}
              ${statCard("Taxa de conversão (mês)", taxaConversaoMes === null ? "—" : `${taxaConversaoMes.toFixed(0)}%`, "var(--success)")}
            </div>
          `}
      </div>

      <div class="card card-section">
        <div class="dash-section__head">
          <p class="section-title" style="margin:0;">Vendas</p>
          <span class="dash-section__kicker">Mês atual</span>
        </div>
        <p class="stat-card__value" style="margin: 0.4rem 0 0;">${formatCurrency(totalVendasMes)}</p>
        ${renderTrend(totalVendasMes, totalVendasMesAnterior)}
        <p class="cell-muted" style="margin: 0.3rem 0 0;">${vendasMes.length} venda${vendasMes.length === 1 ? "" : "s"} · ticket médio ${formatCurrency(ticketMedioVendas)}</p>
        ${renderMiniBars(weekBuckets(vendasMes, hoje), "Sem.")}
      </div>
    </div>

    <div class="dash-section stat-grid">
      ${kpiCard("Entradas do mês", formatCurrency(entradasMes), entradasMes, entradasMesAnterior, "var(--accent-deep)")}
      ${kpiCard("Saídas do mês", formatCurrency(saidasMes), saidasMes, saidasMesAnterior, "var(--danger)", true)}
      ${kpiCard("Saldo do mês", formatCurrency(saldoMes), saldoMes, saldoMesAnterior, saldoMes >= 0 ? "var(--accent)" : "var(--danger)")}
    </div>

    <div class="card card-section dash-section">
      <div class="dash-section__head">
        <p class="section-title" style="margin:0;">Fluxo de caixa projetado</p>
        <span class="dash-section__kicker">Pendências futuras</span>
      </div>
      <p class="cell-muted" style="margin: 0.3rem 0 0.9rem;">Contas a pagar e parcelas de matrícula pendentes (incluindo as já atrasadas) com vencimento dentro de cada horizonte.</p>
      <div class="stat-grid">
        ${projecaoCard("Em 30 dias", projecao30)}
        ${projecaoCard("Em 60 dias", projecao60)}
        ${projecaoCard("Em 90 dias", projecao90)}
      </div>
    </div>

    <div class="dash-grid-2 dash-section">
      <div class="card card-section">
        <div class="dash-section__head">
          <p class="section-title" style="margin:0;">Estoques</p>
          <span class="dash-section__kicker">Saúde do estoque</span>
        </div>
        <div class="gauge-row">
          ${renderGauge(pctEstoqueSaudavel)}
          <p class="gauge-caption">${produtosFisicos.length - estoqueBaixo.length} de ${produtosFisicos.length} produtos dentro do estoque mínimo.</p>
        </div>
        ${estoqueBaixo.length > 0 ? `<p class="cell-muted" style="margin: 0.9rem 0 0;">Mais críticos:</p>` : ""}
        ${renderChips(estoqueBaixo)}
        ${topProdutosServicos.length > 0 ? `<p class="cell-muted" style="margin: 1rem 0 0;">Mais vendidos no mês:</p>${renderTopProdutosBars(topProdutosServicos)}` : ""}
      </div>

      <div class="card card-section">
        <div class="dash-section__head">
          <p class="section-title" style="margin:0;">Últimas movimentações</p>
          <span class="dash-section__kicker">Mês atual</span>
        </div>
        ${renderTimeline(linhasMovimentacoes)}
      </div>
    </div>
  `;
}

// ── Comparação de período (mês atual vs. mesmo intervalo do mês anterior) ─

function renderTrend(atual, anterior) {
  const html = trendHtml(atual, anterior, false);
  return html ? `<p style="margin:0;">${html}</p>` : "";
}

function trendHtml(atual, anterior, invert) {
  if (anterior === 0 && atual === 0) return "";
  const pct = anterior === 0 ? 100 : ((atual - anterior) / Math.abs(anterior)) * 100;
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const good = flat ? null : (invert ? !up : up);
  const arrow = flat ? "→" : up ? "▲" : "▼";
  const color = flat ? "var(--text-muted)" : good ? "var(--accent-deep)" : "var(--danger-deep)";
  return `<span class="kpi-trend" style="color:${color};">${arrow} ${Math.abs(pct).toFixed(0)}% vs. mês anterior</span>`;
}

function kpiCard(label, value, atual, anterior, tagColor, invert = false) {
  return `
    <div class="card stat-card" style="--tag-color:${tagColor}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${value}</p>
      ${trendHtml(atual, anterior, invert)}
    </div>
  `;
}

// ── Fluxo de caixa projetado (Roadmap Fase 2) ────────────────────────────

function projecaoCaixa(contasFuturas, parcelasFuturas, dias) {
  const limite = addDaysStr(dias);
  const aReceber = parcelasFuturas.filter((p) => p.data_vencimento <= limite).reduce((s, p) => s + Number(p.valor || 0), 0);
  const aPagar = contasFuturas.filter((c) => c.data_vencimento <= limite).reduce((s, c) => s + Number(c.valor || 0), 0);
  return { aReceber, aPagar, saldo: aReceber - aPagar };
}

function projecaoCard(label, proj) {
  return `
    <div class="card stat-card" style="--tag-color:${proj.saldo >= 0 ? "var(--accent)" : "var(--danger)"}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${formatCurrency(proj.saldo)}</p>
      <p class="cell-muted" style="margin-top: 0.3rem;">+${formatCurrency(proj.aReceber)} a receber · −${formatCurrency(proj.aPagar)} a pagar</p>
    </div>
  `;
}

// ── CRM — funil de propostas ──────────────────────────────────────────

const STAGE_DEFS = [
  { key: "draft", label: "Rascunho", color: "var(--text-muted)" },
  { key: "enviada", label: "Enviada", color: "var(--info)" },
  { key: "aprovada", label: "Aprovada", color: "var(--accent)" },
  { key: "reprovada", label: "Reprovada", color: "var(--danger)" },
];

function renderStageBar(counts) {
  return `
    <div class="stage-bar">
      ${STAGE_DEFS.map((s) => counts[s.key] > 0 ? `<div class="stage-bar__seg" style="flex:${counts[s.key]}; background:${s.color};" title="${s.label}: ${counts[s.key]}"></div>` : "").join("")}
    </div>
    <div class="stage-bar__legend">
      ${STAGE_DEFS.map((s) => `<span class="stage-bar__legend-item"><span class="stage-bar__dot" style="background:${s.color}"></span>${escapeHtml(s.label)} (${counts[s.key]})</span>`).join("")}
    </div>
  `;
}

// ── Vendas: barras semanais + ranking de produtos ────────────────────────

function weekBuckets(vendas, hoje) {
  const semanasCorridas = Math.min(5, Math.ceil(hoje.getDate() / 7));
  const buckets = Array.from({ length: semanasCorridas }, () => 0);
  for (const v of vendas) {
    const dia = new Date(`${v.data_venda}T00:00:00`).getDate();
    const idx = Math.min(semanasCorridas - 1, Math.floor((dia - 1) / 7));
    buckets[idx] += Number(v.total || 0);
  }
  return buckets;
}

function renderMiniBars(valores, prefixoLabel) {
  if (valores.every((v) => v === 0)) {
    return `<p class="cell-muted" style="margin: 0.6rem 0 0;">Nenhuma venda registrada ainda neste mês.</p>`;
  }
  const max = Math.max(1, ...valores);
  return `
    <div class="mini-bars">
      ${valores.map((v, i) => `
        <div class="mini-bars__col">
          <div class="mini-bars__track"><div class="mini-bars__bar" style="height:${Math.max(4, Math.round((v / max) * 100))}%" title="${formatCurrency(v)}"></div></div>
          <span class="mini-bars__label">${escapeHtml(prefixoLabel)}${i + 1}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function vendaItemLinhas(vendas) {
  const linhas = [];
  for (const v of vendas) {
    for (const it of v.itens || []) {
      linhas.push({
        produtoId: it.produto_id,
        produtoNome: it.produto?.nome || "Produto removido",
        quantidade: Number(it.quantidade || 0),
        valor: Number(it.subtotal || 0),
      });
    }
  }
  return linhas;
}

function parcelaLinhas(parcelas) {
  return parcelas.map((p) => ({
    produtoId: p.matricula?.produto?.id || `matricula-${p.matricula?.numero ?? "sem-produto"}`,
    produtoNome: p.matricula?.produto?.nome || "Serviço (matrícula)",
    quantidade: 1,
    valor: Number(p.valor || 0),
  }));
}

function recebimentoLinhas(recebimentos) {
  return recebimentos.map((r) => ({
    produtoId: r.produto?.id || "recebimento-sem-produto",
    produtoNome: r.produto?.nome || "Produto",
    quantidade: Number(r.quantidade || 0),
    valor: Number(r.valor || 0),
  }));
}

function aggregateProdutos(linhas) {
  const map = new Map();
  for (const l of linhas) {
    if (!map.has(l.produtoId)) map.set(l.produtoId, { label: l.produtoNome, quantidade: 0, total: 0 });
    const entry = map.get(l.produtoId);
    entry.quantidade += l.quantidade;
    entry.total += l.valor;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, 5);
}

function renderTopProdutosBars(rows) {
  const max = Math.max(...rows.map((r) => r.total), 1);
  return `
    <div class="hbar-list">
      ${rows.map((r) => `
        <div class="hbar-row">
          <span class="hbar-row__label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
          <div class="hbar-row__track"><div class="hbar-row__fill" style="width:${Math.max(4, Math.round((r.total / max) * 100))}%"></div></div>
          <span class="hbar-row__value">${formatCurrency(r.total)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

// ── Estoques: gauge de saúde + destaques críticos ────────────────────────

function renderGauge(pct) {
  const cor = pct >= 80 ? "var(--accent)" : pct >= 50 ? "var(--amber)" : "var(--danger)";
  const deg = Math.max(0, Math.min(360, Math.round((pct / 100) * 360)));
  return `
    <div class="gauge" style="background: conic-gradient(${cor} ${deg}deg, var(--line) ${deg}deg 360deg);">
      <div class="gauge__hole"><span class="gauge__value">${pct.toFixed(0)}%</span></div>
    </div>
  `;
}

function renderChips(estoqueBaixo) {
  if (estoqueBaixo.length === 0) {
    return `<p class="cell-muted" style="margin: 0.7rem 0 0;">Nenhum produto abaixo do estoque mínimo.</p>`;
  }
  const visiveis = estoqueBaixo.slice(0, 6);
  return `
    <div class="chip-list">
      ${visiveis.map((p) => `<span class="chip chip--danger">${escapeHtml(p.nome)} · ${p.estoque}/${p.estoque_minimo}</span>`).join("")}
      ${estoqueBaixo.length > 6 ? `<span class="chip">+${estoqueBaixo.length - 6}</span>` : ""}
    </div>
  `;
}

// ── Últimas movimentações: timeline ──────────────────────────────────────

function movimentacoes(vendas, parcelas, recebimentos, contasPagar) {
  const linhas = [
    ...vendas.map((v) => ({
      data: v.data_venda,
      tipo: "entrada",
      origem: `Venda #${v.numero}`,
      quem: v.cliente?.nome || "Sem cliente",
      valor: Number(v.total || 0),
    })),
    ...parcelas.map((p) => ({
      data: p.data_pagamento,
      tipo: "entrada",
      origem: `Matrícula #${p.matricula?.numero ?? "?"} · parcela ${p.numero_parcela}`,
      quem: p.cliente?.nome || "Sem cliente",
      valor: Number(p.valor || 0),
    })),
    ...recebimentos.map((r) => ({
      data: r.data_recebimento,
      tipo: "entrada",
      origem: "Recebimento manual",
      quem: r.cliente?.nome || "Sem cliente",
      valor: Number(r.valor || 0),
    })),
    ...contasPagar.map((c) => ({
      data: c.data_pagamento,
      tipo: "saida",
      origem: c.descricao || "Conta a pagar",
      quem: c.fornecedor?.nome || "—",
      valor: Number(c.valor || 0),
    })),
  ];
  return linhas.sort((a, b) => new Date(b.data) - new Date(a.data));
}

function renderTimeline(linhas) {
  if (linhas.length === 0) {
    return '<div class="empty-state" style="padding: 1.5rem;">Nenhuma movimentação neste mês.</div>';
  }
  return `
    <div class="timeline">
      ${linhas.map((l) => `
        <div class="timeline__item">
          <span class="timeline__dot timeline__dot--${l.tipo}"></span>
          <div class="timeline__body">
            <div class="timeline__row">
              <span class="timeline__origem">${escapeHtml(l.origem)}</span>
              <span class="timeline__valor" style="color: ${l.tipo === "entrada" ? "var(--accent-deep)" : "var(--danger-deep)"};">${l.tipo === "entrada" ? "+" : "−"} ${formatCurrency(l.valor)}</span>
            </div>
            <div class="timeline__meta">
              <span>${escapeHtml(l.quem)}</span>
              <span>${formatDate(l.data)}</span>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function statCard(label, value, tagColor) {
  return `
    <div class="card stat-card" style="--tag-color:${tagColor}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${value}</p>
    </div>
  `;
}
