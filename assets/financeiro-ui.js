// Peças de UI compartilhadas entre Financeiro > Contas a Receber
// (financeiro.js) e Contas a Pagar (contas-pagar.js) — as duas telas
// cresceram como gêmeas quase idênticas (datas padrão, cartões de
// estatística, toolbar de filtro "De/Até/Só pendentes" e paginação) sem
// nenhum módulo compartilhado. Extraído daqui em vez de generalizar para o
// resto do app: são as duas únicas telas com esse padrão específico de
// "extrato por período + lista fechada de pendentes".

import { escapeHtml } from "./app.js";

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function firstDayOfMonthStr() {
  return `${todayStr().slice(0, 7)}-01`;
}

export function statCard(label, value, tagColor) {
  return `
    <div class="card stat-card" style="--tag-color:${tagColor}">
      <p class="stat-card__label">${escapeHtml(label)}</p>
      <p class="stat-card__value">${value}</p>
    </div>
  `;
}

// Toolbar "De / Até / Filtrar / Só pendentes (todos os vencimentos)".
// `prefix` mantém os ids que o CSS/cada tela já espera (`cr-*` em
// financeiro.js, `cp-*` em contas-pagar.js).
export function periodoToolbarHtml({ prefix, inicioLabel = "De", inicio, fim }) {
  return `
    <div class="toolbar financeiro-filtro">
      <div class="field financeiro-filtro__field--date">
        <label for="${prefix}-inicio">${escapeHtml(inicioLabel)}</label>
        <input class="input" type="date" id="${prefix}-inicio" value="${inicio}" />
      </div>
      <div class="field financeiro-filtro__field--date">
        <label for="${prefix}-fim">Até</label>
        <input class="input" type="date" id="${prefix}-fim" value="${fim}" />
      </div>
      <div class="field financeiro-filtro__field--action">
        <label>&nbsp;</label>
        <button type="button" class="btn btn--ghost" id="${prefix}-filtrar">Filtrar</button>
      </div>
      <div class="field financeiro-filtro__field--push">
        <label>&nbsp;</label>
        <label class="financeiro-filtro__checkbox">
          <input type="checkbox" id="${prefix}-somente-pendentes" />
          Só pendentes (todos os vencimentos)
        </label>
      </div>
    </div>
  `;
}

// Liga a toolbar acima a um `state` com `{ inicio, fim, page,
// somentePendentes }`. `onChange` é chamado (com state já atualizado e
// `page` zerado) a cada clique em "Filtrar" ou toggle de "Só pendentes".
export function wirePeriodoToolbar(view, { prefix, state, onChange }) {
  const inicioInput = view.querySelector(`#${prefix}-inicio`);
  const fimInput = view.querySelector(`#${prefix}-fim`);
  const filtrarBtn = view.querySelector(`#${prefix}-filtrar`);
  const somentePendentesInput = view.querySelector(`#${prefix}-somente-pendentes`);

  function syncDisabled() {
    const disabled = state.somentePendentes;
    inicioInput.disabled = disabled;
    fimInput.disabled = disabled;
    filtrarBtn.disabled = disabled;
  }
  syncDisabled();

  filtrarBtn.addEventListener("click", () => {
    state.inicio = inicioInput.value || state.inicio;
    state.fim = fimInput.value || state.fim;
    state.page = 0;
    onChange();
  });

  somentePendentesInput.addEventListener("change", () => {
    state.somentePendentes = somentePendentesInput.checked;
    state.page = 0;
    syncDisabled();
    onChange();
  });
}

// Paginação "‹ Anterior … Próxima ›" — mesma estrutura nas duas telas.
export function paginacaoHtml(prefix, page, totalPages) {
  if (totalPages <= 1) return "";
  return `
    <div class="pagination">
      <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-page-prev" ${page === 0 ? "disabled" : ""}>‹ Anterior</button>
      <span class="pagination__label">Página ${page + 1} de ${totalPages}</span>
      <button type="button" class="btn btn--ghost btn--sm" id="${prefix}-page-next" ${page >= totalPages - 1 ? "disabled" : ""}>Próxima ›</button>
    </div>
  `;
}

export function wirePaginacao(content, prefix, state, totalPages, reload) {
  if (totalPages <= 1) return;
  content.querySelector(`#${prefix}-page-prev`).addEventListener("click", () => {
    state.page = Math.max(0, state.page - 1);
    reload();
  });
  content.querySelector(`#${prefix}-page-next`).addEventListener("click", () => {
    state.page += 1;
    reload();
  });
}
