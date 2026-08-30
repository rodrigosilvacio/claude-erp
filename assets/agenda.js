// ERPConnect — agenda de atendimentos: a equipe marca um horário para um
// cliente (com um produto associado), com visão por dia, semana ou mês.
// Todo agendamento novo nasce "agendado". Clicar em "Atendido" na listagem
// do dia não muda o status na hora — abre a tela de Vendas pré-preenchida
// com os dados do atendimento, e o agendamento só vira "atendido" quando o
// usuário confirma a venda por lá (ver setVendaPrefill/consumeVendaPrefill
// em app.js e o handler de "Finalizar venda" em vendas.js).

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, escapeHtml, createSearchSelect, registerAutoRefresh, setVendaPrefill, setMatriculaPrefill, withButtonLock, friendlyPgError } from "./app.js";
import { isAdmin, getCurrentUsuario, getCurrentEmpresaId } from "./auth.js";
import { loadClientesAtivos, loadProdutosAtivos, loadEmpresasAtivas, clienteSearchOptions, produtoSearchOptions, empresaSearchOptions } from "./catalogo.js";

// Grade padrão de horários — usada quando a empresa do usuário logado não
// tem horarios_agenda configurado (Administração > Configurações). Exportada
// pra configuracoes.js mostrar como placeholder do campo de edição.
export const HORARIOS_PADRAO = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

// Admin global (sem empresa) sempre usa a grade padrão — a visão do
// calendário já mistura agendamentos de todas as empresas para esse papel,
// então não há "uma" empresa cujos horários customizados façam sentido
// aplicar aqui.
function getHorarios() {
  const custom = getCurrentUsuario()?.empresa?.horarios_agenda;
  return custom && custom.length > 0 ? custom : HORARIOS_PADRAO;
}

let clientesOptions = [];
let produtosOptions = [];

function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function addMonths(d, n) {
  const copy = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return copy;
}

function startOfWeek(d) {
  return addDays(d, -d.getDay());
}

// Horário cheio corrente, no mesmo formato de getHorarios() ("08:00") — usado
// para destacar o horário atual e sinalizar horários já passados na
// visão do dia. Comparação de string funciona pois o formato é fixo.
function horaAtual() {
  return `${String(new Date().getHours()).padStart(2, "0")}:00`;
}

// Cancelado não é excluído (ver migration 0019 — o slot fica livre pro
// índice parcial, mas a linha continua no banco como rastro), só some da
// grade: nem o calendário nem o resumo por dia mostram agendamento
// cancelado, então essas duas consultas sempre excluem esse status.
async function loadAgendamentos(startKey, endKey) {
  const { data, error } = await supabase
    .from("agendamentos")
    .select("id, data_agendamento, horario, status, observacoes, cliente_id, produto_id, empresa_id, presenca_confirmada, cliente:clientes(nome), produto:produtos(nome, tipo)")
    .neq("status", "cancelado")
    .gte("data_agendamento", startKey)
    .lte("data_agendamento", endKey)
    .order("horario", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadResumoPorDia(startKey, endKey) {
  const { data, error } = await supabase
    .from("agendamentos")
    .select("data_agendamento, status")
    .neq("status", "cancelado")
    .gte("data_agendamento", startKey)
    .lte("data_agendamento", endKey);
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) {
    if (!map.has(row.data_agendamento)) map.set(row.data_agendamento, { agendado: 0, atendido: 0 });
    map.get(row.data_agendamento)[row.status] += 1;
  }
  return map;
}

export async function render(content) {
  [clientesOptions, produtosOptions] = await Promise.all([loadClientesAtivos(), loadProdutosAtivos("id, nome, sku")]);

  const state = { view: "dia", anchor: new Date() };

  content.innerHTML = `
    <div class="agenda">
      <div class="agenda__toolbar">
        <div class="agenda__nav">
          <button type="button" class="btn btn--ghost btn--sm" id="ag-prev" aria-label="Anterior">‹</button>
          <button type="button" class="btn btn--ghost btn--sm" id="ag-hoje">Hoje</button>
          <button type="button" class="btn btn--ghost btn--sm" id="ag-next" aria-label="Próximo">›</button>
          <p class="agenda__label" id="ag-label"></p>
        </div>
        <div class="segmented" id="ag-view" role="radiogroup" aria-label="Visualização">
          <button type="button" class="segmented__btn" data-view="dia" role="radio">Dia</button>
          <button type="button" class="segmented__btn" data-view="semana" role="radio">Semana</button>
          <button type="button" class="segmented__btn" data-view="mes" role="radio">Mês</button>
        </div>
        <button type="button" class="btn btn--ghost" id="ag-link-publico">Link de agendamento</button>
        <button type="button" class="btn btn--primary" id="ag-novo">+ Novo agendamento</button>
      </div>
      <div class="agenda__body" id="ag-body"></div>
    </div>
  `;

  const body = content.querySelector("#ag-body");
  const label = content.querySelector("#ag-label");
  const viewGroup = content.querySelector("#ag-view");

  function updateLabel() {
    if (state.view === "dia") {
      const text = state.anchor.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
      label.textContent = text.charAt(0).toUpperCase() + text.slice(1);
      return;
    }
    if (state.view === "semana") {
      const start = startOfWeek(state.anchor);
      const end = addDays(start, 6);
      label.textContent = start.getMonth() === end.getMonth()
        ? `${start.getDate()} – ${end.getDate()} de ${MESES[start.getMonth()]} de ${start.getFullYear()}`
        : `${start.getDate()} de ${MESES[start.getMonth()]} – ${end.getDate()} de ${MESES[end.getMonth()]} de ${end.getFullYear()}`;
      return;
    }
    label.textContent = `${MESES[state.anchor.getMonth()]} de ${state.anchor.getFullYear()}`;
  }

  function goToDay(key) {
    state.anchor = fromKey(key);
    setView("dia");
  }

  async function draw() {
    updateLabel();
    if (state.view === "dia") await renderDia(body, state.anchor, draw);
    else if (state.view === "semana") await renderSemana(body, state.anchor, goToDay);
    else await renderMes(body, state.anchor, goToDay);
  }

  function setView(view) {
    state.view = view;
    viewGroup.querySelectorAll(".segmented__btn").forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    draw();
  }

  viewGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) setView(btn.dataset.view);
  });

  content.querySelector("#ag-prev").addEventListener("click", () => {
    if (state.view === "dia") state.anchor = addDays(state.anchor, -1);
    else if (state.view === "semana") state.anchor = addDays(state.anchor, -7);
    else state.anchor = addMonths(state.anchor, -1);
    draw();
  });

  content.querySelector("#ag-next").addEventListener("click", () => {
    if (state.view === "dia") state.anchor = addDays(state.anchor, 1);
    else if (state.view === "semana") state.anchor = addDays(state.anchor, 7);
    else state.anchor = addMonths(state.anchor, 1);
    draw();
  });

  content.querySelector("#ag-hoje").addEventListener("click", () => {
    state.anchor = new Date();
    draw();
  });

  content.querySelector("#ag-novo").addEventListener("click", () => {
    openAgendamentoForm({ data: toKey(state.anchor) }, draw);
  });

  // Segunda via de agendar, além de um funcionário criar direto aqui:
  // um link público (sem login) que qualquer pessoa com acesso pode usar
  // pra marcar um serviço sozinha — ver agendamento-publico.html/
  // migration 0022. Mesmo padrão de "Copiar link de pré-cadastro" em
  // clientes.js: sem empresa_id (admin global), o link cai no fallback
  // MATRIZ da RPC — mesma regra de lá, não uma escolha nova.
  content.querySelector("#ag-link-publico").addEventListener("click", async () => {
    const basePath = window.location.pathname.replace(/[^/]*$/, "");
    let query = "";
    const empresaId = getCurrentEmpresaId();
    if (empresaId) {
      const { data: empresa, error } = await supabase.from("empresas").select("codigo").eq("id", empresaId).maybeSingle();
      if (error) showToast(friendlyPgError(error), "error");
      if (empresa?.codigo) query = `?empresa=${encodeURIComponent(empresa.codigo)}`;
    }
    const url = `${window.location.origin}${basePath}agendamento-publico.html${query}`;
    window.open(url, "_blank", "noopener");
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link de agendamento aberto em nova aba (e copiado).");
    } catch {
      showToast("Link de agendamento aberto em nova aba.");
    }
  });

  setView("dia");

  registerAutoRefresh(() => draw(), 20000);
}

function skeletonCard() {
  return `<div class="card"><div class="empty-state">Carregando…</div></div>`;
}

function errorCard(message) {
  return `<div class="card"><div class="empty-state"><p class="empty-state__title">Não foi possível carregar a agenda</p><p class="empty-state__hint">${escapeHtml(message)}</p></div></div>`;
}

// ── Visão do dia: a listagem de horários com o botão Atendido ───────

async function renderDia(body, anchor, onChange) {
  const key = toKey(anchor);
  const isHoje = key === toKey(new Date());
  body.innerHTML = skeletonCard();

  let rows;
  try {
    rows = await loadAgendamentos(key, key);
  } catch (err) {
    body.innerHTML = errorCard(err.message);
    return;
  }

  const byHorario = new Map(rows.map((r) => [r.horario.slice(0, 5), r]));
  const agora = isHoje ? horaAtual() : null;
  const horarios = getHorarios();

  const resumo = { agendado: 0, atendido: 0 };
  rows.forEach((r) => resumo[r.status]++);
  const livres = horarios.length - rows.length;

  body.innerHTML = `
    <div class="card">
      <div class="agenda-day__summary">
        <span class="agenda-day__stat" style="--dot-color: var(--warning)">${resumo.agendado} agendado${resumo.agendado === 1 ? "" : "s"}</span>
        <span class="agenda-day__stat" style="--dot-color: var(--success)">${resumo.atendido} atendido${resumo.atendido === 1 ? "" : "s"}</span>
        <span class="agenda-day__stat" style="--dot-color: var(--text-muted)">${livres} livre${livres === 1 ? "" : "s"}</span>
      </div>
      <div class="agenda-day">
        ${horarios.map((h) => slotHtml(h, byHorario.get(h), {
          isAgora: agora !== null && h === agora,
          isPassado: agora !== null && h < agora,
        })).join("")}
      </div>
    </div>
  `;

  body.querySelectorAll("[data-slot-livre]").forEach((btn) => {
    btn.addEventListener("click", () => openAgendamentoForm({ data: key, horario: btn.dataset.slotLivre }, onChange));
  });

  body.querySelectorAll("[data-editar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ag = rows.find((r) => r.id === btn.dataset.editar);
      if (!ag) return;
      openAgendamentoForm({
        id: ag.id,
        clienteId: ag.cliente_id,
        produtoId: ag.produto_id,
        empresaId: ag.empresa_id,
        data: ag.data_agendamento,
        horario: ag.horario.slice(0, 5),
        observacoes: ag.observacoes || "",
      }, onChange);
    });
  });

  body.querySelectorAll("[data-atendido]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const ag = rows.find((r) => r.id === btn.dataset.atendido);
      if (!ag) return;
      const prefill = {
        agendamentoId: ag.id,
        clienteId: ag.cliente_id,
        clienteNome: ag.cliente?.nome || null,
        produtoId: ag.produto_id,
        dataAgendamento: ag.data_agendamento,
        horario: ag.horario.slice(0, 5),
        observacoes: ag.observacoes || "",
      };
      // Produto do agendamento decide o destino: serviço (curso/mensalidade)
      // vira Matrícula, produto físico continua indo pra Vendas — ver
      // migration 0017 (produtos.tipo).
      if (ag.produto?.tipo === "servico") {
        setMatriculaPrefill(prefill);
        window.location.hash = "#/matriculas";
      } else {
        setVendaPrefill(prefill);
        window.location.hash = "#/vendas";
      }
    });
  });

  // Check-in de presença: independente do status agendado/atendido (que
  // controla se virou venda/matrícula) — um aluno pode ter comparecido à
  // aula mesmo sem gerar cobrança nesse horário específico.
  body.querySelectorAll("[data-presenca]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ag = rows.find((r) => r.id === btn.dataset.presenca);
      if (!ag) return;
      const novoValor = btn.dataset.presencaAtual !== "1";
      const { error } = await supabase
        .from("agendamentos")
        .update({
          presenca_confirmada: novoValor,
          presenca_confirmada_em: novoValor ? new Date().toISOString() : null,
        })
        .eq("id", ag.id);
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast(novoValor ? "Presença confirmada." : "Presença desfeita.");
      onChange();
    });
  });

  // Cancelar em vez de excluir de fato — mantém o registro no banco como
  // rastro de quem cancelou o quê (ver migration 0019); o horário libera pro
  // índice parcial e some da grade do mesmo jeito que uma exclusão faria.
  body.querySelectorAll("[data-excluir]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Cancelar este agendamento?", { confirmLabel: "Cancelar agendamento" });
      if (!ok) return;
      const { error } = await supabase.from("agendamentos").update({ status: "cancelado" }).eq("id", btn.dataset.excluir);
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast("Agendamento cancelado.");
      onChange();
    });
  });
}

function slotHtml(hora, ag, { isAgora = false, isPassado = false } = {}) {
  const agoraTag = isAgora ? `<span class="agenda-slot__agora">Agora</span>` : "";
  const stateClasses = isAgora ? "agenda-slot--agora" : "";

  if (!ag) {
    return `
      <div class="agenda-slot cell-rail agenda-slot--livre ${isPassado ? "agenda-slot--passado" : ""} ${stateClasses}" style="--rail-color: var(--line-strong)">
        <span class="agenda-slot__hora">${hora}${agoraTag}</span>
        <span class="agenda-slot__info cell-muted">Livre</span>
        <div class="agenda-slot__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-slot-livre="${hora}">+ Agendar</button>
        </div>
      </div>
    `;
  }

  const atendido = ag.status === "atendido";
  const atrasado = !atendido && isPassado;
  const detalhe = [ag.produto?.nome, ag.observacoes].filter(Boolean).join(" · ");
  const railColor = atendido ? "var(--success)" : atrasado ? "var(--danger)" : "var(--warning)";

  // Presença é independente do status agendado/atendido — por isso o botão
  // aparece sempre que há um cliente vinculado, mesmo depois de "Atendido"
  // esconder as demais ações.
  const presencaBtn = ag.cliente_id ? `
    <button type="button" class="btn btn--sm ${ag.presenca_confirmada ? "btn--primary" : "btn--ghost"}" data-presenca="${ag.id}" data-presenca-atual="${ag.presenca_confirmada ? "1" : "0"}" title="${ag.presenca_confirmada ? "Presença confirmada — clique para desfazer" : "Marcar presença do aluno na aula"}">
      ${ag.presenca_confirmada ? "✓ Presença" : "Marcar presença"}
    </button>
  ` : "";

  return `
    <div class="agenda-slot cell-rail ${atendido ? "agenda-slot--atendido" : "agenda-slot--agendado"} ${stateClasses}" style="--rail-color: ${railColor}">
      <span class="agenda-slot__hora">${hora}${agoraTag}</span>
      <div class="agenda-slot__info">
        <p class="agenda-slot__cliente">${escapeHtml(ag.cliente?.nome || "Sem cliente")}</p>
        ${detalhe ? `<p class="cell-muted agenda-slot__detalhe">${escapeHtml(detalhe)}</p>` : ""}
        ${atrasado ? `<p class="agenda-slot__atraso">Horário já passou sem confirmação</p>` : ""}
      </div>
      <div class="agenda-slot__actions">
        <span class="status status--${atendido ? "atendido" : "agendado"}">${atendido ? "Atendido" : "Agendado"}</span>
        ${presencaBtn}
        ${atendido ? "" : `
          <button type="button" class="btn btn--primary btn--sm" data-atendido="${ag.id}">Atendido</button>
          <button type="button" class="btn btn--ghost btn--sm" data-editar="${ag.id}">Editar</button>
          <button type="button" class="btn btn--danger btn--sm" data-excluir="${ag.id}">Cancelar</button>
        `}
      </div>
    </div>
  `;
}

// ── Visão da semana: 7 colunas com um resumo de cada dia ────────────

async function renderSemana(body, anchor, goToDay) {
  body.innerHTML = skeletonCard();

  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayKey = toKey(new Date());

  let rows;
  try {
    rows = await loadAgendamentos(toKey(days[0]), toKey(days[6]));
  } catch (err) {
    body.innerHTML = errorCard(err.message);
    return;
  }

  const byDay = new Map(days.map((d) => [toKey(d), []]));
  rows.forEach((r) => byDay.get(r.data_agendamento)?.push(r));

  body.innerHTML = `
    <div class="agenda-week">
      ${days.map((d) => {
        const key = toKey(d);
        const items = byDay.get(key) || [];
        return `
          <div class="agenda-week__col ${key === todayKey ? "is-today" : ""}">
            <button type="button" class="agenda-week__head" data-day-open="${key}">
              <span class="agenda-week__dow">${DIAS_SEMANA[d.getDay()]}</span>
              <span class="agenda-week__daynum">${d.getDate()}</span>
            </button>
            <div class="agenda-week__items">
              ${items.length === 0
                ? '<p class="cell-muted agenda-week__empty">—</p>'
                : items.map((r) => `
                  <button type="button" class="agenda-week__item ${r.status === "atendido" ? "is-atendido" : ""}" data-day-open="${key}">
                    <span class="agenda-week__row">
                      <span class="agenda-week__dot"></span>
                      <span class="agenda-week__hora">${r.horario.slice(0, 5)}</span>
                    </span>
                    <span class="agenda-week__nome">${escapeHtml(r.cliente?.nome || "Sem cliente")}</span>
                  </button>
                `).join("")}
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;

  body.querySelectorAll("[data-day-open]").forEach((el) => {
    el.addEventListener("click", () => goToDay(el.dataset.dayOpen));
  });
}

// ── Visão do mês: grade com contagem de agendados/atendidos por dia ─

async function renderMes(body, anchor, goToDay) {
  body.innerHTML = skeletonCard();

  const month = anchor.getMonth();
  const firstOfMonth = new Date(anchor.getFullYear(), month, 1);
  const lastOfMonth = new Date(anchor.getFullYear(), month + 1, 0);
  const gridStart = startOfWeek(firstOfMonth);
  const gridEnd = addDays(startOfWeek(lastOfMonth), 6);
  const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
  const cells = Array.from({ length: totalDays }, (_, i) => addDays(gridStart, i));
  const todayKey = toKey(new Date());

  let byDay;
  try {
    byDay = await loadResumoPorDia(toKey(gridStart), toKey(gridEnd));
  } catch (err) {
    body.innerHTML = errorCard(err.message);
    return;
  }

  body.innerHTML = `
    <div class="agenda-month">
      <div class="agenda-month__dow-row">
        ${DIAS_SEMANA.map((d) => `<span>${d}</span>`).join("")}
      </div>
      <div class="agenda-month__grid">
        ${cells.map((d) => {
          const key = toKey(d);
          const counts = byDay.get(key);
          const outside = d.getMonth() !== month;
          return `
            <button type="button" class="agenda-month__cell ${outside ? "is-outside" : ""} ${key === todayKey ? "is-today" : ""}" data-day-open="${key}">
              <span class="agenda-month__daynum">${d.getDate()}</span>
              ${counts ? `
                <span class="agenda-month__badges">
                  ${counts.agendado ? `<span class="agenda-month__badge agenda-month__badge--agendado">${counts.agendado}</span>` : ""}
                  ${counts.atendido ? `<span class="agenda-month__badge agenda-month__badge--atendido">${counts.atendido}</span>` : ""}
                </span>
              ` : ""}
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;

  body.querySelectorAll("[data-day-open]").forEach((el) => {
    el.addEventListener("click", () => goToDay(el.dataset.dayOpen));
  });
}

// ── Modal de novo agendamento / edição ──────────────────────────────

async function openAgendamentoForm({ id = null, clienteId = null, produtoId = null, empresaId = null, data, horario, observacoes = "" } = {}, onSaved) {
  const editando = Boolean(id);
  const admin = isAdmin();
  const body = openModal(editando ? "Editar agendamento" : "Novo agendamento");
  const empresasOptions = admin ? empresaSearchOptions(await loadEmpresasAtivas()) : [];

  body.innerHTML = `
    <form id="agenda-form">
      <div id="agenda-form-error"></div>
      <div class="form-grid">
        ${admin ? `
        <div class="field field--full">
          <label>Empresa${'<span class="field-required">*</span>'}</label>
          <div data-mount="ag-empresa"></div>
        </div>
        ` : ""}
        <div class="field field--full">
          <label>Cliente <span class="field-optional">opcional</span></label>
          <div data-mount="ag-cliente"></div>
        </div>
        <div class="field field--full">
          <label>Produto${'<span class="field-required">*</span>'}</label>
          <div data-mount="ag-produto"></div>
        </div>
        <div class="field">
          <label for="ag-data">Data<span class="field-required">*</span></label>
          <input class="input" type="date" id="ag-data" value="${escapeHtml(data || toKey(new Date()))}" min="${toKey(new Date())}" required />
        </div>
        <div class="field">
          <label for="ag-horario">Horário<span class="field-required">*</span></label>
          <select class="input" id="ag-horario" required></select>
        </div>
        <div class="field field--full">
          <label for="ag-obs">Observações</label>
          <textarea class="input" id="ag-obs" rows="2">${escapeHtml(observacoes)}</textarea>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="ag-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">${editando ? "Salvar" : "Agendar"}</button>
      </div>
    </form>
  `;

  const empresaSelect = admin
    ? createSearchSelect({
        container: body.querySelector('[data-mount="ag-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresasOptions,
        value: empresaId,
        allowClear: false,
        onChange: () => refreshHorarios(),
      })
    : null;

  const clienteSelect = createSearchSelect({
    container: body.querySelector('[data-mount="ag-cliente"]'),
    placeholder: "Buscar cliente por nome ou documento… (opcional)",
    options: clienteSearchOptions(clientesOptions),
    value: clienteId,
    allowClear: true,
  });

  const produtoSelect = createSearchSelect({
    container: body.querySelector('[data-mount="ag-produto"]'),
    placeholder: "Buscar produto…",
    options: produtoSearchOptions(produtosOptions),
    value: produtoId,
    allowClear: true,
  });

  const dataInput = body.querySelector("#ag-data");
  const horarioSelect = body.querySelector("#ag-horario");

  async function refreshHorarios(preferido) {
    let ocupados = new Set();
    // Para admin, os horários ocupados são por empresa selecionada — cada
    // empresa tem sua própria agenda independente. Para quem não é admin, a
    // RLS já restringe a consulta à própria empresa.
    if (dataInput.value && !(admin && !empresaSelect.getValue())) {
      let query = supabase.from("agendamentos").select("horario").eq("data_agendamento", dataInput.value).neq("status", "cancelado");
      if (admin) query = query.eq("empresa_id", empresaSelect.getValue());
      if (editando) query = query.neq("id", id);
      const { data: rows } = await query;
      ocupados = new Set((rows || []).map((r) => r.horario.slice(0, 5)));
    }
    const manterSelecionado = preferido && !ocupados.has(preferido) ? preferido : horarioSelect.value;
    horarioSelect.innerHTML = getHorarios().map((h) => `
      <option value="${h}" ${ocupados.has(h) ? "disabled" : ""} ${h === manterSelecionado && !ocupados.has(h) ? "selected" : ""}>${h}${ocupados.has(h) ? " (ocupado)" : ""}</option>
    `).join("");
  }

  await refreshHorarios(horario);
  dataInput.addEventListener("change", () => refreshHorarios());

  body.querySelector("#ag-cancel").addEventListener("click", closeModal);

  body.querySelector("#agenda-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#agenda-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#agenda-form-error");
      errorEl.innerHTML = "";

      const produtoIdSelecionado = produtoSelect.getValue();
      if (!produtoIdSelecionado) {
        errorEl.innerHTML = `<div class="form-error">Selecione um produto.</div>`;
        return;
      }

      if (admin && !empresaSelect.getValue()) {
        errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
        return;
      }

      const clienteIdSelecionado = clienteSelect.getValue() || null;
      const payload = {
        cliente_id: clienteIdSelecionado,
        produto_id: produtoIdSelecionado,
        data_agendamento: dataInput.value,
        horario: horarioSelect.value,
        observacoes: body.querySelector("#ag-obs").value || null,
        // Fecha a lacuna Agenda ↔ Matrículas: resolve, em background, se o
        // cliente tem uma matrícula ativa para este produto/serviço — sem
        // isso não dava pra saber se um agendamento correspondia a uma
        // matrícula ativa (ou a nenhuma).
        matricula_id: null,
      };
      if (admin) payload.empresa_id = empresaSelect.getValue();

      if (clienteIdSelecionado) {
        const { data: matriculaAtiva } = await supabase
          .from("matriculas")
          .select("id")
          .eq("cliente_id", clienteIdSelecionado)
          .eq("produto_id", produtoIdSelecionado)
          .eq("status", "ativa")
          .order("data_matricula", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (matriculaAtiva) payload.matricula_id = matriculaAtiva.id;
      }

      const { error } = editando
        ? await supabase.from("agendamentos").update(payload).eq("id", id)
        : await supabase.from("agendamentos").insert(payload);

      if (error) {
        const friendly = friendlyPgError(error, { 23505: "Esse horário acabou de ser reservado por outra pessoa. Escolha outro." });
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendly)}</div>`;
        await refreshHorarios();
        return;
      }

      showToast(editando ? "Agendamento atualizado." : "Agendamento criado.");
      closeModal();
      if (onSaved) onSaved();
    });
  });
}
