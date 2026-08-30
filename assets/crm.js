// ERPConnect — CRM: pipeline de Propostas (grupo Movimentações). Uma
// proposta é um orçamento para um lead (campo livre) ou um cliente já
// cadastrado, com múltiplos produtos e valor total — criar/editar uma
// proposta NUNCA mexe em estoque, só quando (e se) ela virar uma venda de
// verdade pela tela de Vendas já existente.
//
// Tela redesenhada como um quadro kanban por estágio (Rascunho → Enviada →
// Aprovada/Reprovada), não uma tabela de lançamentos nem o checkout de
// Vendas: um CRM se organiza por onde cada negociação está no funil, não
// por ordem cronológica de registro. "+ Nova proposta" e "Editar" abrem um
// formulário em modal — o carrinho de itens continua com preço por item
// editável (é um orçamento, não uma venda a preço de tabela).

import { supabase } from "./supabaseClient.js";
import {
  showToast, openModal, closeModal, confirmDialog, formatCurrency, formatDate, escapeHtml,
  createSearchSelect, registerAutoRefresh, withButtonLock, friendlyPgError, exportCsv, formatCsvNumber,
  setVendaPrefill, setMatriculaPrefill,
} from "./app.js";
import { isAdmin, getCurrentUsuario } from "./auth.js";
import { loadClientesAtivos, loadProdutosAtivos, loadEmpresasAtivas, clienteSearchOptions, produtoSearchOptions, empresaSearchOptions, produtoMetaPrecoEstoque } from "./catalogo.js";

const ICON_LEAD = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" stroke-dasharray="2 2"/></svg>';
const ICON_CLIENTE = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>';
const SEARCH_ICON = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

// Lista sugerida (campo é texto livre com datalist, não trava num valor
// fixo) — mesma lista usada em Clientes, pra manter os valores consistentes
// entre as duas telas que perguntam "de onde veio".
const ORIGEM_OPTIONS = ["Indicação", "Instagram", "Facebook", "Google", "Site", "Evento", "Passando na rua", "Outro"];

const STATUS_LABELS = { draft: "Rascunho", enviada: "Enviada", aprovada: "Aprovada", reprovada: "Reprovada" };
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

// Colunas do quadro, na ordem do funil. COLUNA_CAP limita quantos cards uma
// coluna desenha de uma vez — o board mostra tudo de uma vez (sem
// paginação, ao contrário das listas do resto do app), então precisa de um
// teto para não desenhar centenas de cards de uma empresa com anos de
// histórico.
const COLUNAS = [
  { key: "draft", label: "Rascunho" },
  { key: "enviada", label: "Enviada" },
  { key: "aprovada", label: "Aprovada" },
  { key: "reprovada", label: "Reprovada" },
];
const COLUNA_CAP = 60;
const BOARD_FETCH_LIMIT = 400;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeForSearch(str) {
  return String(str ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

let clientesOptions = [];
let produtosOptions = [];
let empresasOptions = [];
// Carrinho de produtos e a proposta em edição no MODAL aberto no momento
// (null = novo formulário do zero). Módulo-scope, mesmo padrão de `cart` em
// vendas.js — só é limpo ao abrir um novo formulário ou fechar o modal.
let itens = [];
let editingProposta = null;

// Cache da última busca ao banco + referência da view atual, para o filtro
// de texto reaplicar sem nova consulta e para os modais (detalhe, edição)
// saberem em cima de qual tela recarregar o quadro depois de fechar.
let boardCache = [];
let boardView = null;
let boardState = { search: "" };

export async function render(view, actionsEl) {
  boardView = view;
  boardState = { search: "" };
  itens = [];
  editingProposta = null;

  actionsEl.innerHTML = `
    <button type="button" class="btn btn--ghost" id="btn-exportar-csv">Exportar CSV</button>
    <button type="button" class="btn btn--primary" id="btn-nova-proposta">+ Nova proposta</button>
  `;
  actionsEl.querySelector("#btn-exportar-csv").addEventListener("click", exportarPropostasCsv);
  actionsEl.querySelector("#btn-nova-proposta").addEventListener("click", () => {
    editingProposta = null;
    itens = [];
    openPropostaFormModal();
  });

  view.innerHTML = `
    <div class="stat-grid" id="crm-stats"></div>
    <div class="toolbar" style="margin: 1.1rem 0;">
      <div class="search-input-wrap">
        ${SEARCH_ICON}
        <input type="search" class="input" id="crm-search" placeholder="Buscar por nome do lead ou cliente…" />
      </div>
      <p class="record-count" id="crm-record-count"></p>
    </div>
    <div class="crm-board" id="crm-board"><div class="empty-state">Carregando…</div></div>
  `;

  [clientesOptions, produtosOptions, empresasOptions] = await Promise.all([loadClientesAtivos(), loadProdutosAtivos(), loadEmpresasAtivas()]);

  const searchInput = view.querySelector("#crm-search");
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      boardState.search = searchInput.value.trim();
      renderBoardFromCache(view);
    }, 200);
  });

  await loadBoard(view);

  registerAutoRefresh(() => loadBoard(view, { silent: true }), 15000);
}

const BOARD_SELECT = "id, numero, tipo_contato, lead_nome, data_proposta, validade_ate, total, status, venda_id, matricula_id, cliente:clientes(nome), vendedor:usuarios(nome)";

async function loadBoard(view, opts = {}) {
  const { silent = false } = opts;
  const boardEl = view.querySelector("#crm-board");
  if (!boardEl) return;
  if (!silent) boardEl.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const { data, error } = await supabase
    .from("propostas")
    .select(BOARD_SELECT)
    .order("numero", { ascending: false })
    .limit(BOARD_FETCH_LIMIT);

  if (error) {
    boardEl.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar as propostas</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  boardCache = data || [];
  renderStats(view, boardCache);
  renderBoardFromCache(view);
}

function renderStats(view, rows) {
  const emAberto = rows.filter((r) => r.status === "draft" || r.status === "enviada");
  const aprovadas = rows.filter((r) => r.status === "aprovada");
  const reprovadas = rows.filter((r) => r.status === "reprovada");
  const fechadas = aprovadas.length + reprovadas.length;
  const taxaConversao = fechadas > 0 ? (aprovadas.length / fechadas) * 100 : 0;
  const valorEmAberto = emAberto.reduce((soma, r) => soma + Number(r.total || 0), 0);
  const ticketMedio = aprovadas.length > 0 ? aprovadas.reduce((soma, r) => soma + Number(r.total || 0), 0) / aprovadas.length : 0;

  view.querySelector("#crm-stats").innerHTML = `
    ${statCard("Propostas em aberto", emAberto.length, "var(--info)")}
    ${statCard("Valor em aberto", formatCurrency(valorEmAberto), "var(--accent)")}
    ${statCard("Taxa de conversão", `${taxaConversao.toFixed(0)}%`, "var(--success)")}
    ${statCard("Ticket médio aprovado", formatCurrency(ticketMedio), "var(--amber)")}
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

function renderBoardFromCache(view) {
  const boardEl = view.querySelector("#crm-board");
  const countEl = view.querySelector("#crm-record-count");
  if (!boardEl) return;

  if (boardCache.length === 0) {
    boardEl.innerHTML = `<div class="empty-state"><p class="empty-state__title">Nenhuma proposta ainda</p><p class="empty-state__hint">Use "+ Nova proposta" para criar a primeira.</p></div>`;
    if (countEl) countEl.textContent = "";
    return;
  }

  const termo = normalizeForSearch(boardState.search);
  const filtradas = termo
    ? boardCache.filter((p) => {
        const nome = p.tipo_contato === "cliente" ? (p.cliente?.nome || "") : (p.lead_nome || "");
        return normalizeForSearch(nome).includes(termo);
      })
    : boardCache;

  if (countEl) {
    countEl.textContent = termo
      ? `${filtradas.length} de ${boardCache.length} proposta${boardCache.length === 1 ? "" : "s"}`
      : `${boardCache.length} proposta${boardCache.length === 1 ? "" : "s"}${boardCache.length >= BOARD_FETCH_LIMIT ? " (mais recentes)" : ""}`;
  }

  boardEl.innerHTML = COLUNAS.map((col) => {
    const linhas = filtradas
      .filter((p) => p.status === col.key)
      .sort((a, b) => new Date(b.data_proposta) - new Date(a.data_proposta));
    const soma = linhas.reduce((s, r) => s + Number(r.total || 0), 0);
    const visiveis = linhas.slice(0, COLUNA_CAP);

    return `
      <div class="crm-column crm-column--${col.key}">
        <div class="crm-column__head">
          <span class="crm-column__title">${escapeHtml(col.label)}</span>
          <span class="crm-column__count">${linhas.length}</span>
        </div>
        <div class="crm-column__sum">${formatCurrency(soma)}</div>
        <div class="crm-column__cards">
          ${visiveis.length === 0
            ? `<div class="empty-state" style="padding: 1rem; font-size: 0.8rem;">Nada por aqui.</div>`
            : visiveis.map((p) => renderCard(p, col.key)).join("")}
          ${linhas.length > COLUNA_CAP ? `<p class="cell-muted" style="text-align:center; font-size:0.72rem; padding: 0.3rem 0;">+${linhas.length - COLUNA_CAP} mais — refine a busca</p>` : ""}
        </div>
      </div>
    `;
  }).join("");

  boardEl.querySelectorAll("[data-detail]").forEach((cardEl) => {
    const abrir = () => showDetail(cardEl.dataset.detail, () => loadBoard(boardView, { silent: true }));
    cardEl.addEventListener("click", abrir);
    // role="button" sozinho não torna o card operável por teclado — sem
    // isto, Tab foca o card mas Enter/Espaço não fazem nada.
    cardEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        abrir();
      }
    });
  });
}

function renderCard(p, colKey) {
  const nome = p.tipo_contato === "cliente" ? (p.cliente?.nome || "Cliente") : (p.lead_nome || "Lead");
  const badgeIcon = p.tipo_contato === "cliente" ? ICON_CLIENTE : ICON_LEAD;
  const badgeClass = p.tipo_contato === "cliente" ? "crm-card__badge--cliente" : "crm-card__badge--lead";
  const vencida = (colKey === "draft" || colKey === "enviada") && Boolean(p.validade_ate) && p.validade_ate < todayStr();
  const convertida = p.status === "aprovada" && Boolean(p.venda_id || p.matricula_id);

  return `
    <div class="crm-card" data-detail="${p.id}" role="button" tabindex="0">
      <div class="crm-card__row">
        <span class="crm-card__badge ${badgeClass}" title="${p.tipo_contato === "cliente" ? "Cliente" : "Lead"}">${badgeIcon}</span>
        <span class="crm-card__num">#${p.numero}</span>
      </div>
      <p class="crm-card__nome">${escapeHtml(nome)}</p>
      <p class="crm-card__valor">${formatCurrency(p.total)}</p>
      <div class="crm-card__foot">
        <span>${escapeHtml(p.vendedor?.nome || "—")}</span>
        <span>${formatDate(p.data_proposta)}</span>
      </div>
      ${vencida ? `<span class="crm-card__flag">Validade vencida</span>` : ""}
      ${convertida ? `<span class="crm-card__flag crm-card__flag--ok">Convertida</span>` : ""}
    </div>
  `;
}

const EXPORT_CAP = 5000;

async function exportarPropostasCsv() {
  const { data, error } = await supabase
    .from("propostas")
    .select("numero, data_proposta, tipo_contato, lead_nome, status, total, cliente:clientes(nome), vendedor:usuarios(nome)")
    .order("numero", { ascending: false })
    .limit(EXPORT_CAP);

  if (error) {
    showToast(friendlyPgError(error), "error");
    return;
  }

  exportCsv(
    "propostas.csv",
    ["Nº", "Data", "Contato", "Tipo", "Vendedor", "Total", "Status"],
    (data || []).map((p) => [
      p.numero,
      p.data_proposta,
      p.tipo_contato === "cliente" ? (p.cliente?.nome || "") : (p.lead_nome || ""),
      p.tipo_contato === "cliente" ? "Cliente" : "Lead",
      p.vendedor?.nome || "",
      formatCsvNumber(p.total),
      statusLabel(p.status),
    ]),
  );
}

// ── Formulário de proposta (modal) ──────────────────────────────────────
// `editingProposta`/`itens` (module-scope) já devem estar preenchidos por
// quem chama: null/[] para nova proposta, ou os dados carregados por
// editarProposta() para edição.
function openPropostaFormModal() {
  const admin = isAdmin();
  const usuario = getCurrentUsuario();
  const editing = editingProposta;
  const tipoInicial = editing ? editing.tipo_contato : "lead";

  const body = openModal(editing ? `Editar proposta #${editing.numero}` : "Nova proposta", {
    size: "wide",
    onClose: () => {
      itens = [];
      editingProposta = null;
    },
  });

  body.innerHTML = `
    <form id="proposta-form">
      <div id="p-error"></div>
      <div class="form-grid">
        ${admin && !editing ? `
        <div class="field field--full">
          <label>Empresa<span class="field-required">*</span></label>
          <div data-mount="p-empresa"></div>
        </div>
        ` : ""}

        <div class="field field--full">
          <label>Contato</label>
          <div class="paytiles" id="p-tipo-contato" role="radiogroup" aria-label="Tipo de contato" style="max-width: 280px;">
            <button type="button" class="paytile ${tipoInicial === "lead" ? "is-active" : ""}" data-value="lead" role="radio" aria-checked="${tipoInicial === "lead"}">
              <span class="paytile__icon">${ICON_LEAD}</span>
              <span class="paytile__label">Lead</span>
            </button>
            <button type="button" class="paytile ${tipoInicial === "cliente" ? "is-active" : ""}" data-value="cliente" role="radio" aria-checked="${tipoInicial === "cliente"}">
              <span class="paytile__icon">${ICON_CLIENTE}</span>
              <span class="paytile__label">Cliente</span>
            </button>
          </div>
        </div>

        <div class="field field--full" id="p-contato-mount"></div>

        <div class="field">
          <label for="p-telefone">Telefone</label>
          <input class="input" type="text" id="p-telefone" value="${escapeHtml(editing?.contato_telefone || "")}" />
        </div>
        <div class="field">
          <label for="p-email">E-mail</label>
          <input class="input" type="email" id="p-email" value="${escapeHtml(editing?.contato_email || "")}" />
        </div>
        <div class="field">
          <label for="p-data">Data da proposta</label>
          <input class="input" type="date" id="p-data" value="${editing?.data_proposta || todayStr()}" />
        </div>
        <div class="field">
          <label for="p-validade">Válida até <span class="field-optional">opcional</span></label>
          <input class="input" type="date" id="p-validade" value="${editing?.validade_ate || ""}" />
        </div>
        <div class="field">
          <label for="p-condicoes">Condições de pagamento <span class="field-optional">opcional</span></label>
          <input class="input" type="text" id="p-condicoes" placeholder="Ex.: à vista, 3x sem juros…" value="${escapeHtml(editing?.condicoes_pagamento || "")}" />
        </div>
        <div class="field">
          <label for="p-prazo">Prazo de entrega <span class="field-optional">opcional</span></label>
          <input class="input" type="text" id="p-prazo" placeholder="Ex.: 5 dias úteis" value="${escapeHtml(editing?.prazo_entrega || "")}" />
        </div>
        <div class="field">
          <label for="p-origem">Origem / canal <span class="field-optional">opcional</span></label>
          <input class="input" type="text" id="p-origem" list="p-origem-options" placeholder="Ex.: Indicação, Instagram…" value="${escapeHtml(editing?.origem || "")}" />
          <datalist id="p-origem-options">
            ${ORIGEM_OPTIONS.map((o) => `<option value="${escapeHtml(o)}"></option>`).join("")}
          </datalist>
        </div>
      </div>

      <p class="field-hint" style="margin: 0.9rem 0 0;">Vendedor responsável: <strong>${escapeHtml(editing?.vendedor?.nome || usuario?.nome || "—")}</strong></p>

      <p class="section-title" style="margin-top: 1.35rem;">Produtos a oferecer</p>
      <div class="form-grid form-grid--itens-proposta">
        <div class="field">
          <label>Produto</label>
          <div data-mount="p-produto"></div>
        </div>
        <div class="field">
          <label for="p-qtd">Qtd.</label>
          <input class="input" type="number" id="p-qtd" min="1" step="1" value="1" />
        </div>
        <div class="field">
          <label for="p-preco">Preço unit.</label>
          <input class="input" type="number" id="p-preco" min="0" step="0.01" value="0" />
        </div>
        <div class="field">
          <button type="button" class="btn btn--ghost" id="p-add-item">+ Adicionar</button>
        </div>
      </div>

      <div class="table-wrap" style="margin-top: 1rem;">
        <table class="data-table" id="proposta-itens-table">
          <thead>
            <tr><th>Produto</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Preço</th><th style="text-align:right">Subtotal</th><th></th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="field field--full" style="margin-top: 1rem;">
        <label for="p-observacoes">Observações / condições gerais</label>
        <textarea class="input" id="p-observacoes" rows="2">${escapeHtml(editing?.observacoes || "")}</textarea>
      </div>

      <div class="crm-totais">
        <div class="crm-totais__row"><span>Subtotal</span><span id="p-subtotal">${formatCurrency(0)}</span></div>
        <div class="crm-totais__row">
          <span>Desconto</span>
          <input class="input" type="number" id="p-desconto" min="0" step="0.01" value="${editing?.desconto || 0}" style="width: 110px; text-align:right; font-family: var(--font-mono);" />
        </div>
        <div class="crm-totais__row crm-totais__row--total"><span>Total</span><span id="p-total">${formatCurrency(0)}</span></div>
      </div>

      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="p-cancel">Cancelar</button>
        <button type="button" class="btn btn--primary" id="p-salvar">${editing ? "Salvar alterações" : "Salvar rascunho"}</button>
      </div>
    </form>
  `;

  const cartBody = body.querySelector("#proposta-itens-table tbody");
  const descontoInput = body.querySelector("#p-desconto");
  const telefoneInput = body.querySelector("#p-telefone");
  const emailInput = body.querySelector("#p-email");
  const errorEl = body.querySelector("#p-error");
  const contatoMount = body.querySelector("#p-contato-mount");

  const empresaSelect = admin && !editing
    ? createSearchSelect({
        container: body.querySelector('[data-mount="p-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        allowClear: false,
      })
    : null;

  let clienteSelect = null;
  let tipoAtual = tipoInicial;

  function renderContatoField(tipo) {
    if (tipo === "cliente") {
      contatoMount.innerHTML = `
        <label>Cliente<span class="field-required">*</span></label>
        <div data-mount="p-cliente"></div>
      `;
      clienteSelect = createSearchSelect({
        container: contatoMount.querySelector('[data-mount="p-cliente"]'),
        placeholder: "Buscar cliente por nome ou documento…",
        options: clienteSearchOptions(clientesOptions),
        value: editing?.cliente_id || null,
        allowClear: true,
        onChange: (clienteId) => {
          const cliente = clientesOptions.find((c) => c.id === clienteId);
          telefoneInput.value = cliente?.telefone || "";
          emailInput.value = cliente?.email || "";
          telefoneInput.readOnly = Boolean(cliente);
          emailInput.readOnly = Boolean(cliente);
        },
      });
      // Cliente pré-selecionado (edição): trava os campos sem passar pelo
      // onChange acima, que só dispara em interação do usuário.
      if (editing?.cliente_id) {
        const cliente = clientesOptions.find((c) => c.id === editing.cliente_id);
        telefoneInput.readOnly = Boolean(cliente);
        emailInput.readOnly = Boolean(cliente);
      }
    } else {
      contatoMount.innerHTML = `
        <label for="p-lead-nome">Nome do lead<span class="field-required">*</span></label>
        <input class="input" type="text" id="p-lead-nome" value="${escapeHtml(editing?.lead_nome || "")}" />
      `;
      clienteSelect = null;
      telefoneInput.readOnly = false;
      emailInput.readOnly = false;
    }
  }

  renderContatoField(tipoInicial);

  const tipoGroup = body.querySelector("#p-tipo-contato");
  tipoGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn || btn.dataset.value === tipoAtual) return;
    tipoAtual = btn.dataset.value;
    tipoGroup.querySelectorAll(".paytile").forEach((b) => {
      const active = b.dataset.value === tipoAtual;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    renderContatoField(tipoAtual);
  });

  const qtdInput = body.querySelector("#p-qtd");
  const precoInput = body.querySelector("#p-preco");

  const produtoSelect = createSearchSelect({
    container: body.querySelector('[data-mount="p-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    allowClear: true,
    onChange: (value) => {
      if (!value) return;
      const produto = produtosOptions.find((p) => p.id === value);
      qtdInput.value = 1;
      precoInput.value = produto ? Number(produto.preco).toFixed(2) : 0;
      qtdInput.focus();
      qtdInput.select();
    },
  });

  function renderItensTable() {
    if (itens.length === 0) {
      cartBody.innerHTML = `<tr><td colspan="5" class="empty-state" style="padding: 1.5rem;">Nenhum produto adicionado ainda.</td></tr>`;
    } else {
      cartBody.innerHTML = itens.map((item, idx) => `
        <tr>
          <td>${escapeHtml(item.nome)}</td>
          <td class="cell-num">
            <input type="number" class="input" data-qty="${idx}" min="1" step="1" value="${item.quantidade}" style="width: 64px; text-align:right; padding: 0.35rem 0.5rem; font-family: var(--font-mono);" />
          </td>
          <td class="cell-num">
            <input type="number" class="input" data-price="${idx}" min="0" step="0.01" value="${item.preco_unitario}" style="width: 90px; text-align:right; padding: 0.35rem 0.5rem; font-family: var(--font-mono);" />
          </td>
          <td class="cell-num">${formatCurrency(item.quantidade * item.preco_unitario)}</td>
          <td class="cell-actions"><button type="button" class="icon-btn" data-remove="${idx}" aria-label="Remover">&times;</button></td>
        </tr>
      `).join("");
      cartBody.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          itens.splice(Number(btn.dataset.remove), 1);
          renderItensTable();
        });
      });
      cartBody.querySelectorAll("[data-qty]").forEach((input) => {
        input.addEventListener("change", () => {
          const idx = Number(input.dataset.qty);
          itens[idx].quantidade = Math.max(Math.floor(Number(input.value || 0)), 1);
          renderItensTable();
        });
      });
      cartBody.querySelectorAll("[data-price]").forEach((input) => {
        input.addEventListener("change", () => {
          const idx = Number(input.dataset.price);
          itens[idx].preco_unitario = Math.max(Number(input.value || 0), 0);
          renderItensTable();
        });
      });
    }
    updateTotals();
  }

  function updateTotals() {
    const subtotal = itens.reduce((sum, item) => sum + item.quantidade * item.preco_unitario, 0);
    const desconto = Number(descontoInput.value || 0);
    body.querySelector("#p-subtotal").textContent = formatCurrency(subtotal);
    body.querySelector("#p-total").textContent = formatCurrency(Math.max(subtotal - desconto, 0));
  }

  descontoInput.addEventListener("input", updateTotals);

  function addItem() {
    const produtoId = produtoSelect.getValue();
    const produto = produtosOptions.find((p) => p.id === produtoId);
    const quantidade = Number(qtdInput.value || 0);
    const preco = Number(precoInput.value || 0);

    if (!produto || quantidade <= 0) return;

    const existing = itens.find((item) => item.produto_id === produto.id);
    if (existing) existing.quantidade += quantidade;
    else itens.push({ produto_id: produto.id, nome: produto.nome, quantidade, preco_unitario: preco });

    qtdInput.value = 1;
    precoInput.value = 0;
    produtoSelect.reset();
    produtoSelect.focusInput();
    renderItensTable();
  }

  body.querySelector("#p-add-item").addEventListener("click", addItem);
  qtdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } });
  precoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } });

  body.querySelector("#p-cancel").addEventListener("click", closeModal);

  body.querySelector("#p-salvar").addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
    errorEl.innerHTML = "";

    if (itens.length === 0) {
      errorEl.innerHTML = `<div class="form-error">Adicione ao menos um produto antes de salvar.</div>`;
      return;
    }
    if (empresaSelect && !empresaSelect.getValue()) {
      errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
      return;
    }
    if (tipoAtual === "cliente" && !clienteSelect?.getValue()) {
      errorEl.innerHTML = `<div class="form-error">Selecione um cliente.</div>`;
      return;
    }
    const leadNomeInput = body.querySelector("#p-lead-nome");
    if (tipoAtual === "lead" && !leadNomeInput?.value.trim()) {
      errorEl.innerHTML = `<div class="form-error">Informe o nome do lead.</div>`;
      return;
    }

    const payload = {
      p_tipo_contato: tipoAtual,
      p_cliente_id: tipoAtual === "cliente" ? clienteSelect.getValue() : null,
      p_lead_nome: tipoAtual === "lead" ? leadNomeInput.value.trim() : null,
      p_contato_telefone: telefoneInput.value.trim() || null,
      p_contato_email: emailInput.value.trim() || null,
      p_data_proposta: body.querySelector("#p-data").value || null,
      p_validade_ate: body.querySelector("#p-validade").value || null,
      p_condicoes_pagamento: body.querySelector("#p-condicoes").value.trim() || null,
      p_prazo_entrega: body.querySelector("#p-prazo").value.trim() || null,
      p_origem: body.querySelector("#p-origem").value.trim() || null,
      p_observacoes: body.querySelector("#p-observacoes").value.trim() || null,
      p_desconto: Number(descontoInput.value || 0),
      p_itens: itens.map((item) => ({ produto_id: item.produto_id, quantidade: item.quantidade, preco_unitario: item.preco_unitario })),
    };

    let rpcError;
    if (editing) {
      ({ error: rpcError } = await supabase.rpc("atualizar_proposta", { p_proposta_id: editing.id, ...payload }));
    } else {
      if (empresaSelect) payload.p_empresa_id = empresaSelect.getValue();
      ({ error: rpcError } = await supabase.rpc("criar_proposta", payload));
    }

    if (rpcError) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(rpcError))}</div>`;
      return;
    }

    showToast(editing ? "Proposta atualizada." : "Proposta salva como rascunho.");
    closeModal();
    loadBoard(boardView, { silent: true });
  }));

  renderItensTable();
}

async function editarProposta(id) {
  const [{ data: proposta, error }, { data: itensData }] = await Promise.all([
    supabase.from("propostas").select("*, vendedor:usuarios(nome)").eq("id", id).single(),
    supabase.from("proposta_itens").select("*, produto:produtos(nome)").eq("proposta_id", id).order("created_at", { ascending: true }),
  ]);

  if (error || !proposta) {
    showToast(error ? friendlyPgError(error) : "Proposta não encontrada.", "error");
    return;
  }

  editingProposta = proposta;
  itens = (itensData || []).map((i) => ({
    produto_id: i.produto_id,
    nome: i.produto?.nome || "Produto",
    quantidade: i.quantidade,
    preco_unitario: Number(i.preco_unitario),
  }));
  openPropostaFormModal();
}

// ── Conversão (integração CRM → Vendas/Matrículas) ──────────────────────
//
// Objetivo: nenhuma proposta aprovada deve ficar "solta" sem se saber se
// virou negócio de fato. Regra: item de produto físico vira Venda (Loja);
// item de serviço vira Matrícula — mesma separação que já existe no resto
// do app (catalogo.js: Loja só vende produto físico, serviço é parcelado
// só em Matrículas). Uma proposta pode ter só um tipo, ou os dois — nesse
// caso os dois destinos são preenchidos, um depois do outro.
//
// Em vez de criar venda/matrícula por baixo dos panos aqui (duplicando toda
// a lógica de carrinho/pagamento/estoque/parcelamento), isto só monta o
// "prefill" e navega pra tela certa — quem finaliza de verdade (RPC
// criar_venda/criar_matricula) é vendas.js/matriculas.js, e só DEPOIS do
// sucesso é que a proposta é marcada como convertida
// (propostas.venda_id/matricula_id/convertida_em). Assim, uma venda ou
// matrícula abandonada no meio do caminho (aba fechada, Stripe cancelado)
// nunca deixa a proposta "convertida" sem um registro de verdade por trás —
// mesmo racional do fluxo Agenda → Vendas/Matrículas já existente
// (setVendaPrefill/setMatriculaPrefill).
async function iniciarConversaoProposta(propostaId) {
  const [{ data: proposta, error }, { data: itensData }] = await Promise.all([
    supabase.from("propostas").select("*, cliente:clientes(nome)").eq("id", propostaId).single(),
    supabase.from("proposta_itens").select("*, produto:produtos(nome, tipo)").eq("proposta_id", propostaId).order("created_at", { ascending: true }),
  ]);

  if (error || !proposta) {
    showToast(error ? friendlyPgError(error) : "Proposta não encontrada.", "error");
    return;
  }

  const itensProduto = (itensData || []).filter((i) => i.produto?.tipo !== "servico");
  const itensServico = (itensData || []).filter((i) => i.produto?.tipo === "servico");

  if (itensProduto.length === 0 && itensServico.length === 0) {
    showToast("Esta proposta não tem itens para converter.", "error");
    return;
  }

  // Matrícula sempre exige um cliente cadastrado (matriculas.cliente_id não
  // aceita nulo) — diferente de venda, que aceita cliente em branco. Um lead
  // com item de serviço não tem como virar matrícula direto.
  const clienteIdReal = proposta.tipo_contato === "cliente" ? proposta.cliente_id : null;
  const podeMatricula = itensServico.length > 0 && Boolean(clienteIdReal);
  if (itensServico.length > 0 && !clienteIdReal) {
    showToast("Esta proposta tem item(ns) de serviço, mas o contato é um lead sem cadastro — cadastre-o como cliente antes de converter em matrícula.", "error");
    if (itensProduto.length === 0) return;
  }

  const obsPartes = [`Convertida da proposta #${proposta.numero}.`];
  if (proposta.tipo_contato === "lead") {
    obsPartes.push(`Lead: ${proposta.lead_nome}.`);
    if (proposta.contato_telefone) obsPartes.push(`Tel.: ${proposta.contato_telefone}.`);
    if (proposta.contato_email) obsPartes.push(`E-mail: ${proposta.contato_email}.`);
  }
  if (proposta.observacoes) obsPartes.push(`Obs. da proposta: ${proposta.observacoes}`);
  const observacoes = obsPartes.join(" ");

  // O desconto da proposta é um valor único sobre o total — aplicado só no
  // primeiro registro gerado (venda, se houver produto; senão a 1ª
  // matrícula), pra não descontar a mesma quantia mais de uma vez quando a
  // proposta se desdobra em vários registros.
  const descontoTotal = Number(proposta.desconto || 0);
  const descontoNaVenda = itensProduto.length > 0 ? descontoTotal : 0;
  const descontoNaPrimeiraMatricula = itensProduto.length === 0 ? descontoTotal : 0;

  const filaServicos = podeMatricula
    ? itensServico.map((i) => ({ produto_id: i.produto_id, nome: i.produto?.nome || "Produto", preco_unitario: Number(i.preco_unitario) }))
    : [];

  closeModal();

  if (itensServico.length > 0 && !podeMatricula) {
    showToast(`${itensServico.length} item(ns) de serviço da proposta não foram migrados — cadastre o lead como cliente e registre-os como Matrícula manualmente.`, "error");
  }

  if (itensProduto.length > 0) {
    setVendaPrefill({
      propostaId: proposta.id,
      propostaNumero: proposta.numero,
      clienteId: clienteIdReal,
      clienteNome: proposta.cliente?.nome || null,
      empresaId: proposta.empresa_id,
      desconto: descontoNaVenda,
      itens: itensProduto.map((i) => ({ produto_id: i.produto_id, nome: i.produto?.nome || "Produto", quantidade: i.quantidade, preco_unitario: Number(i.preco_unitario) })),
      observacoes,
      // Fila de serviços pendentes: vendas.js não faz nada com isto além de
      // repassar pra Matrículas depois que a venda for finalizada (ver
      // finalizarComSucesso em vendas.js) — mantém os dois destinos da mesma
      // proposta encadeados num só fluxo, sem o vendedor ter que caçar o
      // resto manualmente.
      pendingServicos: filaServicos,
      pendingServicosDesconto: descontoNaPrimeiraMatricula,
    });
    window.location.hash = "#/vendas";
    return;
  }

  if (podeMatricula) {
    const [primeiro, ...resto] = filaServicos;
    setMatriculaPrefill({
      propostaId: proposta.id,
      propostaNumero: proposta.numero,
      clienteId: clienteIdReal,
      clienteNome: proposta.cliente?.nome || null,
      empresaId: proposta.empresa_id,
      produtoId: primeiro.produto_id,
      precoUnitario: primeiro.preco_unitario,
      desconto: descontoNaPrimeiraMatricula,
      observacoes,
      pendingServicos: resto,
    });
    window.location.hash = "#/matriculas";
  }
}

// ── Envio por e-mail (edge function enviar-proposta) ────────────────────
// Mesmo padrão de erro de callManageUsuarios/chamarCriarCheckoutStripe: a
// edge function devolve `{ error }` em JSON tanto em falhas de validação
// quanto o supabase-js embrulha isso — o corpo de verdade só é acessível
// via error.context.
async function chamarEnviarProposta(propostaId) {
  const { data, error } = await supabase.functions.invoke("enviar-proposta", { body: { proposta_id: propostaId } });

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

// ── Impressão / PDF ──────────────────────────────────────────────────────
// Sem lib de PDF (nenhuma outra tela deste app usa uma): a área impressa
// fica escondida da tela normal e só aparece no `@media print` (ver
// styles.css) — o próprio diálogo de impressão do navegador já oferece
// "Salvar como PDF" como destino, cobrindo os dois pedidos (impressora e
// PDF) sem dependência nova.
function ensurePrintContainer() {
  let el = document.getElementById("print-proposta");
  if (!el) {
    el = document.createElement("div");
    el.id = "print-proposta";
    document.body.appendChild(el);
  }
  return el;
}

function imprimirProposta(proposta, itensData) {
  const contatoNome = proposta.tipo_contato === "cliente" ? (proposta.cliente?.nome || "Cliente") : (proposta.lead_nome || "Lead");
  const contatoTelefone = proposta.contato_telefone || proposta.cliente?.telefone || "";
  const contatoEmail = proposta.contato_email || proposta.cliente?.email || "";
  const empresaNome = proposta.empresa?.nome_aplicacao || proposta.empresa?.nome_fantasia || "ERPConnect";

  const el = ensurePrintContainer();
  el.innerHTML = `
    <h1>${escapeHtml(empresaNome)}</h1>
    <p>Proposta comercial nº ${proposta.numero}</p>
    <table class="print-info">
      <tbody>
        <tr><td>${proposta.tipo_contato === "cliente" ? "Cliente" : "Lead"}</td><td>${escapeHtml(contatoNome)}</td></tr>
        ${contatoTelefone ? `<tr><td>Telefone</td><td>${escapeHtml(contatoTelefone)}</td></tr>` : ""}
        ${contatoEmail ? `<tr><td>E-mail</td><td>${escapeHtml(contatoEmail)}</td></tr>` : ""}
        <tr><td>Vendedor</td><td>${escapeHtml(proposta.vendedor?.nome || "—")}</td></tr>
        <tr><td>Data</td><td>${formatDate(proposta.data_proposta)}</td></tr>
        ${proposta.validade_ate ? `<tr><td>Válida até</td><td>${formatDate(proposta.validade_ate)}</td></tr>` : ""}
        ${proposta.condicoes_pagamento ? `<tr><td>Pagamento</td><td>${escapeHtml(proposta.condicoes_pagamento)}</td></tr>` : ""}
        ${proposta.prazo_entrega ? `<tr><td>Entrega</td><td>${escapeHtml(proposta.prazo_entrega)}</td></tr>` : ""}
      </tbody>
    </table>
    <table class="print-itens">
      <thead><tr><th>Produto</th><th>Qtd.</th><th>Preço</th><th>Subtotal</th></tr></thead>
      <tbody>
        ${(itensData || []).map((i) => `<tr><td>${escapeHtml(i.produto?.nome || "Produto")}</td><td>${i.quantidade}</td><td>${formatCurrency(i.preco_unitario)}</td><td>${formatCurrency(i.subtotal)}</td></tr>`).join("")}
      </tbody>
    </table>
    <table class="print-totais">
      <tbody>
        <tr><td>Subtotal</td><td>${formatCurrency(proposta.subtotal)}</td></tr>
        <tr><td>Desconto</td><td>${formatCurrency(proposta.desconto)}</td></tr>
        <tr class="print-total-row"><td>Total</td><td>${formatCurrency(proposta.total)}</td></tr>
      </tbody>
    </table>
    ${proposta.observacoes ? `<p><strong>Observações:</strong><br>${escapeHtml(proposta.observacoes).replace(/\n/g, "<br>")}</p>` : ""}
  `;

  document.body.classList.add("is-printing");
  window.addEventListener("afterprint", () => document.body.classList.remove("is-printing"), { once: true });
  window.print();
}

// ── Detalhe (modal): visão completa + troca de status + imprimir/enviar ─
async function showDetail(propostaId, onClose) {
  const body = openModal("Detalhes da proposta", { onClose });
  body.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const [{ data: proposta, error: propostaError }, { data: itensData }] = await Promise.all([
    supabase.from("propostas").select("*, cliente:clientes(nome, telefone, email), vendedor:usuarios(nome), empresa:empresas(nome_fantasia, nome_aplicacao), venda:vendas(numero), matricula:matriculas(numero)").eq("id", propostaId).single(),
    supabase.from("proposta_itens").select("*, produto:produtos(nome, tipo)").eq("proposta_id", propostaId).order("created_at", { ascending: true }),
  ]);

  if (!proposta) {
    body.innerHTML = propostaError
      ? `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar a proposta</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(propostaError))}</p></div>`
      : `<div class="empty-state">Proposta não encontrada.</div>`;
    return;
  }

  const contatoNome = proposta.tipo_contato === "cliente" ? (proposta.cliente?.nome || "—") : (proposta.lead_nome || "—");
  const contatoTelefone = proposta.contato_telefone || proposta.cliente?.telefone || "—";
  const contatoEmail = proposta.contato_email || proposta.cliente?.email || "";
  const podeEnviarEmail = Boolean(contatoEmail);
  const temItemProduto = (itensData || []).some((i) => i.produto?.tipo !== "servico");
  const temItemServico = (itensData || []).some((i) => i.produto?.tipo === "servico");
  // "Convertida" só quando cada destino que a proposta precisa (venda e/ou
  // matrícula, conforme os tipos de item que ela carrega) já tem registro
  // vinculado — uma proposta mista só some do radar quando os dois lados
  // existirem de verdade.
  const totalmenteConvertida = (!temItemProduto || proposta.venda_id) && (!temItemServico || proposta.matricula_id);
  const algumaConversaoFeita = Boolean(proposta.venda_id || proposta.matricula_id);
  const labelConverter = temItemProduto && temItemServico ? "Converter (venda + matrícula)" : temItemServico ? "Converter em matrícula" : "Converter em venda";

  body.innerHTML = `
    <div class="crm-detail">
      <div class="crm-detail__head">
        <div>
          <p class="crm-detail__label">Proposta #${proposta.numero} · ${proposta.tipo_contato === "cliente" ? "Cliente" : "Lead"}</p>
          <p class="crm-detail__nome">${escapeHtml(contatoNome)}</p>
        </div>
        <span class="status status--${proposta.status}">${statusLabel(proposta.status)}</span>
      </div>

      <div class="crm-detail__grid">
        <div><span class="crm-detail__k">Telefone</span><span class="crm-detail__v">${escapeHtml(contatoTelefone)}</span></div>
        <div><span class="crm-detail__k">E-mail</span><span class="crm-detail__v">${escapeHtml(contatoEmail || "—")}</span></div>
        <div><span class="crm-detail__k">Vendedor</span><span class="crm-detail__v">${escapeHtml(proposta.vendedor?.nome || "—")}</span></div>
        <div><span class="crm-detail__k">Data</span><span class="crm-detail__v">${formatDate(proposta.data_proposta)}</span></div>
        ${proposta.origem ? `<div><span class="crm-detail__k">Origem</span><span class="crm-detail__v">${escapeHtml(proposta.origem)}</span></div>` : ""}
        ${proposta.validade_ate ? `<div><span class="crm-detail__k">Válida até</span><span class="crm-detail__v">${formatDate(proposta.validade_ate)}</span></div>` : ""}
        ${proposta.condicoes_pagamento ? `<div><span class="crm-detail__k">Pagamento</span><span class="crm-detail__v">${escapeHtml(proposta.condicoes_pagamento)}</span></div>` : ""}
        ${proposta.prazo_entrega ? `<div><span class="crm-detail__k">Entrega</span><span class="crm-detail__v">${escapeHtml(proposta.prazo_entrega)}</span></div>` : ""}
        ${proposta.status === "aprovada" && temItemProduto ? `<div><span class="crm-detail__k">Venda</span><span class="crm-detail__v">${proposta.venda_id ? `Convertida — venda #${proposta.venda?.numero ?? "?"}` : "Ainda não convertida em venda"}</span></div>` : ""}
        ${proposta.status === "aprovada" && temItemServico ? `<div><span class="crm-detail__k">Matrícula</span><span class="crm-detail__v">${proposta.matricula_id ? `Convertida — matrícula #${proposta.matricula?.numero ?? "?"}` : "Ainda não convertida em matrícula"}</span></div>` : ""}
        ${proposta.status === "reprovada" && proposta.motivo ? `<div class="crm-detail__grid--full"><span class="crm-detail__k">Motivo</span><span class="crm-detail__v">${escapeHtml(proposta.motivo)}</span></div>` : ""}
        ${proposta.observacoes ? `<div class="crm-detail__grid--full"><span class="crm-detail__k">Observações</span><span class="crm-detail__v">${escapeHtml(proposta.observacoes)}</span></div>` : ""}
      </div>

      <div class="crm-detail__itens">
        ${(itensData || []).map((i) => `
          <div class="crm-detail__item"><span>${i.quantidade}x ${escapeHtml(i.produto?.nome || "Produto")}</span><span>${formatCurrency(i.subtotal)}</span></div>
        `).join("")}
      </div>

      <div class="crm-totais">
        <div class="crm-totais__row"><span>Subtotal</span><span>${formatCurrency(proposta.subtotal)}</span></div>
        <div class="crm-totais__row"><span>Desconto</span><span>${formatCurrency(proposta.desconto)}</span></div>
        <div class="crm-totais__row crm-totais__row--total"><span>Total</span><span>${formatCurrency(proposta.total)}</span></div>
      </div>
    </div>

    <div id="detail-reprovar-box" hidden style="margin-top: 1.1rem;">
      <div class="field">
        <label for="detail-motivo">Motivo da reprovação<span class="field-required">*</span></label>
        <textarea class="input" id="detail-motivo" rows="2"></textarea>
      </div>
    </div>
    <div id="detail-error"></div>

    <div class="crm-detail__actions">
      <div class="crm-detail__actions-group">
        <button type="button" class="btn btn--ghost" id="detail-imprimir">Imprimir / PDF</button>
        <button type="button" class="btn btn--ghost" id="detail-email" ${podeEnviarEmail ? "" : "disabled title=\"Sem e-mail cadastrado para este contato\""}>Enviar por e-mail</button>
        ${proposta.status === "draft" && !algumaConversaoFeita ? `<button type="button" class="btn btn--ghost" id="detail-editar">Editar</button>` : ""}
      </div>
      <div class="crm-detail__actions-group">
        ${proposta.status !== "reprovada" && !algumaConversaoFeita ? `<button type="button" class="btn btn--danger" id="detail-reprovar">Reprovar</button>` : ""}
        ${proposta.status !== "aprovada" && proposta.status !== "reprovada" && !algumaConversaoFeita ? `<button type="button" class="btn btn--primary" id="detail-aprovar">Aprovar</button>` : ""}
        ${proposta.status === "aprovada" && !totalmenteConvertida ? `<button type="button" class="btn btn--primary" id="detail-converter">${escapeHtml(labelConverter)}</button>` : ""}
      </div>
    </div>
  `;

  body.querySelector("#detail-imprimir").addEventListener("click", () => imprimirProposta(proposta, itensData));

  const emailBtn = body.querySelector("#detail-email");
  if (podeEnviarEmail) {
    emailBtn.addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
      const errorEl = body.querySelector("#detail-error");
      errorEl.innerHTML = "";
      try {
        const res = await chamarEnviarProposta(proposta.id);
        showToast(`Proposta enviada para ${res.destinatario}.`);
        await showDetail(proposta.id, onClose);
      } catch (err) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
      }
    }));
  }

  body.querySelector("#detail-editar")?.addEventListener("click", async () => {
    closeModal();
    await editarProposta(proposta.id);
  });

  body.querySelector("#detail-aprovar")?.addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
    const { error } = await supabase.rpc("atualizar_status_proposta", { p_proposta_id: proposta.id, p_status: "aprovada" });
    if (error) {
      body.querySelector("#detail-error").innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
      return;
    }
    showToast("Proposta aprovada.");

    // Integração CRM → Vendas/Matrículas: uma proposta aprovada não deve
    // ficar "solta" sem se saber se virou negócio — por isso perguntamos na
    // hora. Quem recusar não perde a chance depois: enquanto não estiver
    // totalmente convertida, o botão "Converter…" continua disponível no
    // detalhe (ver botão #detail-converter mais abaixo).
    const converter = await confirmDialog(
      "Proposta aprovada! Deseja transformar esta proposta em uma venda/matrícula agora?",
      { confirmLabel: "Sim, converter", danger: false },
    );
    if (converter) {
      await iniciarConversaoProposta(proposta.id);
      return;
    }
    await showDetail(proposta.id, onClose);
  }));

  body.querySelector("#detail-converter")?.addEventListener("click", (e) => withButtonLock(e.currentTarget, () => iniciarConversaoProposta(proposta.id)));

  const reprovarBtn = body.querySelector("#detail-reprovar");
  reprovarBtn?.addEventListener("click", () => {
    const box = body.querySelector("#detail-reprovar-box");
    if (box.hidden) {
      box.hidden = false;
      reprovarBtn.textContent = "Confirmar reprovação";
      body.querySelector("#detail-motivo").focus();
      return;
    }
    withButtonLock(reprovarBtn, async () => {
      const errorEl = body.querySelector("#detail-error");
      errorEl.innerHTML = "";
      const motivo = body.querySelector("#detail-motivo").value.trim();
      if (!motivo) {
        errorEl.innerHTML = `<div class="form-error">Informe o motivo da reprovação.</div>`;
        return;
      }
      const { error } = await supabase.rpc("atualizar_status_proposta", { p_proposta_id: proposta.id, p_status: "reprovada", p_motivo: motivo });
      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }
      showToast("Proposta reprovada.");
      await showDetail(proposta.id, onClose);
    });
  });
}
