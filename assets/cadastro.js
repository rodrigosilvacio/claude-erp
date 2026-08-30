// Motor genérico de tela de cadastro (listar + buscar + ordenar + criar/editar
// + excluir). Clientes, Produtos e Fornecedores compartilham exatamente este
// fluxo — só mudam os campos e colunas — então fica configurado por tela em
// vez de triplicado.

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, escapeHtml, skeletonTable, createSearchSelect, registerAutoRefresh, friendlyPgError } from "./app.js";
import { consultarCep } from "./cep.js";
import { isAdmin } from "./auth.js";

const SEARCH_ICON = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

// A tabela inteira era buscada a cada montagem, busca e refresh automático
// (15s) — não escala à medida que a base cresce. PAGE_SIZE limita cada
// requisição a uma página real, contada no servidor via `{ count: "exact" }`.
const PAGE_SIZE = 50;

// Telas marcadas com `scopeByEmpresa: true` (Clientes, Produtos,
// Fornecedores) ganham, só para administradores, um campo "Empresa"
// obrigatório no formulário e uma coluna correspondente na listagem — quem
// não é admin nunca vê nem um nem outro, e o INSERT sem empresa_id é
// preenchido pelo trigger set_empresa_id() no banco.
async function loadEmpresasOptions() {
  const { data } = await supabase
    .from("empresas")
    .select("id, nome_fantasia, codigo")
    .eq("ativo", true)
    .order("nome_fantasia", { ascending: true });
  return (data || []).map((e) => ({ value: e.id, label: e.nome_fantasia, meta: e.codigo }));
}

function withEmpresaScope(rawConfig) {
  if (!rawConfig.scopeByEmpresa || !isAdmin()) return rawConfig;

  return {
    ...rawConfig,
    selectQuery: `${rawConfig.selectQuery || "*"}, empresa:empresas(nome_fantasia)`,
    columns: [
      ...rawConfig.columns,
      // Relação (empresas.nome_fantasia via join), não uma coluna própria de
      // config.table — não dá pra ordenar direto com .order() no servidor.
      { key: "empresa", label: "Empresa", sortable: false, render: (row) => escapeHtml(row.empresa?.nome_fantasia || "—") },
    ],
    fields: [
      ...rawConfig.fields,
      { key: "empresa_id", label: "Empresa", type: "search-select", required: true, full: true, optionsLoader: loadEmpresasOptions },
    ],
  };
}

export async function renderCadastro(view, actionsEl, rawConfig) {
  const config = withEmpresaScope(rawConfig);
  actionsEl.innerHTML = `<button type="button" class="btn btn--primary" id="btn-new">+ Novo ${escapeHtml(config.titleSingular)}</button>`;
  view.innerHTML = `
    <div class="toolbar">
      <div class="search-input-wrap">
        ${SEARCH_ICON}
        <input type="search" class="input" id="search-input" placeholder="${escapeHtml(config.searchPlaceholder)}" />
      </div>
      <p class="record-count" id="record-count"></p>
    </div>
    ${skeletonTable()}
  `;

  const searchInput = view.querySelector("#search-input");
  const state = { key: config.orderBy || "nome", asc: true, page: 0 };

  actionsEl.querySelector("#btn-new").addEventListener("click", () => openForm(config, null, () => loadRows(config, view, searchInput.value.trim(), state)));

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.page = 0;
      loadRows(config, view, searchInput.value.trim(), state);
    }, 250);
  });

  await loadRows(config, view, "", state);

  registerAutoRefresh(() => loadRows(config, view, searchInput.value.trim(), state), 15000);
}

async function loadRows(config, view, term, state) {
  const countEl = view.querySelector("#record-count");
  const existingCard = view.querySelector(".card");

  // O skeleton só aparece na primeira montagem da tela. Buscas, o
  // recarregamento automático e o refresh após salvar/excluir mantêm a
  // tabela atual visível até os novos dados chegarem — troca sem piscar.
  if (!existingCard) {
    view.insertAdjacentHTML("beforeend", skeletonTable());
    if (countEl) countEl.textContent = "";
  }

  let query = supabase.from(config.table).select(config.selectQuery || "*", { count: "exact" });

  if (term && config.searchColumns?.length) {
    const orFilter = config.searchColumns.map((col) => `${col}.ilike.%${term.replace(/[%,]/g, "")}%`).join(",");
    query = query.or(orFilter);
  }

  const from = state.page * PAGE_SIZE;
  query = query.order(state.key || config.orderBy || "nome", { ascending: state.asc }).range(from, from + PAGE_SIZE - 1);

  const { data, error, count } = await query;
  const card = view.querySelector(".card");

  if (error) {
    card.innerHTML = `<div class="empty-state"><p class="empty-state__title">Erro ao carregar</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  // Página ficou vazia (ex.: último registro da página foi excluído) — volta
  // para a última página que ainda tem dados, em vez de mostrar tela em branco.
  if ((!data || data.length === 0) && state.page > 0 && count > 0) {
    state.page = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
    return loadRows(config, view, term, state);
  }

  if (!data || data.length === 0) {
    card.innerHTML = `<div class="empty-state"><p class="empty-state__title">Nenhum registro encontrado</p><p class="empty-state__hint">Use "+ Novo ${escapeHtml(config.titleSingular)}" para cadastrar o primeiro.</p></div>`;
    return;
  }

  if (countEl) {
    const primeiro = from + 1;
    const ultimo = from + data.length;
    countEl.textContent = count > data.length || state.page > 0
      ? `${primeiro}–${ultimo} de ${count} registro${count === 1 ? "" : "s"}`
      : `${count} registro${count === 1 ? "" : "s"}`;
  }

  renderTable(config, view, card, data, state);
  renderPagination(config, view, term, state, count);
}

function renderPagination(config, view, term, state, count) {
  const existing = view.querySelector(".pagination");
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  if (totalPages <= 1) {
    if (existing) existing.remove();
    return;
  }

  const html = `
    <div class="pagination">
      <button type="button" class="btn btn--ghost btn--sm" id="page-prev" ${state.page === 0 ? "disabled" : ""}>‹ Anterior</button>
      <span class="pagination__label">Página ${state.page + 1} de ${totalPages}</span>
      <button type="button" class="btn btn--ghost btn--sm" id="page-next" ${state.page >= totalPages - 1 ? "disabled" : ""}>Próxima ›</button>
    </div>
  `;

  if (existing) existing.outerHTML = html;
  else view.insertAdjacentHTML("beforeend", html);

  view.querySelector("#page-prev").addEventListener("click", () => {
    state.page = Math.max(0, state.page - 1);
    loadRows(config, view, term, state);
  });
  view.querySelector("#page-next").addEventListener("click", () => {
    state.page += 1;
    loadRows(config, view, term, state);
  });
}

// Ordena no servidor (state.key/state.asc entram no .order() de loadRows) —
// os dados já chegam prontos aqui, então renderTable só desenha. Antes disso
// reordenava só a página de 50 linhas já em memória, o que dava resultado
// enganoso a partir da página 2 (não trazia as linhas certas do banco,
// só embaralhava as que por acaso já tinham vindo).
function renderTable(config, view, card, data, state) {
  const rows = data.map((row) => {
    const railColor = "ativo" in row ? `var(${row.ativo ? "--success" : "--text-muted"})` : "transparent";
    return `
    <tr>
      ${config.columns.map((col, idx) => {
        const classes = [col.align === "right" ? "cell-num" : "", idx === 0 ? "cell-rail" : ""].filter(Boolean).join(" ");
        const style = idx === 0 ? ` style="--rail-color:${railColor}"` : "";
        return `<td class="${classes}"${style}>${col.render ? col.render(row) : escapeHtml(row[col.key] ?? "—")}</td>`;
      }).join("")}
      <td class="cell-actions">
        ${config.rowActions ? config.rowActions(row) : ""}
        <button type="button" class="btn btn--ghost btn--sm" data-edit="${row.id}">Editar</button>
        <button type="button" class="btn btn--danger btn--sm" data-delete="${row.id}">Excluir</button>
      </td>
    </tr>
  `;
  }).join("");

  card.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            ${config.columns.map((col) => `
              <th ${col.align === "right" ? 'style="text-align:right"' : ""}>
                ${col.sortable === false ? escapeHtml(col.label) : `
                  <button type="button" class="th-sort ${state.key === col.key ? "is-active" : ""}" data-sort="${col.key}">
                    ${escapeHtml(col.label)}
                    <span class="th-sort__caret">${state.key === col.key ? (state.asc ? "▲" : "▼") : "↕"}</span>
                  </button>
                `}
              </th>
            `).join("")}
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  card.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      state.asc = state.key === key ? !state.asc : true;
      state.key = key;
      state.page = 0;
      loadRows(config, view, view.querySelector("#search-input").value.trim(), state);
    });
  });

  card.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = data.find((r) => r.id === btn.dataset.edit);
      openForm(config, row, () => loadRows(config, view, view.querySelector("#search-input").value.trim(), state));
    });
  });

  card.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog(`Excluir este ${config.titleSingular.toLowerCase()}? Esta ação não pode ser desfeita.`, { confirmLabel: "Excluir" });
      if (!ok) return;
      const { error } = await supabase.from(config.table).delete().eq("id", btn.dataset.delete);
      if (error) {
        showToast(friendlyPgError(error, { 23503: "Não é possível excluir: existem registros vinculados a este cadastro." }), "error");
        return;
      }
      showToast(`${config.titleSingular} excluído.`);
      loadRows(config, view, view.querySelector("#search-input").value.trim(), state);
    });
  });

  card.querySelectorAll("[data-row-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = data.find((r) => r.id === btn.dataset.rowActionId);
      config.onRowAction(btn.dataset.rowAction, row, () => loadRows(config, view, view.querySelector("#search-input").value.trim(), state));
    });
  });
}

async function openForm(config, existingRow, onSaved) {
  const isEdit = Boolean(existingRow);
  const body = openModal(isEdit ? `Editar ${config.titleSingular}` : `Novo ${config.titleSingular}`);

  const optionsByField = {};
  for (const field of config.fields) {
    if ((field.type === "select" || field.type === "search-select" || field.type === "combo") && field.optionsLoader) {
      const dependsOnValue = field.dependsOn && existingRow ? existingRow[field.dependsOn] : undefined;
      optionsByField[field.key] = await field.optionsLoader(existingRow, dependsOnValue);
    }
  }

  body.innerHTML = `
    <form id="cadastro-form">
      <div id="form-error"></div>
      <div class="form-grid">
        ${config.fields.map((field) => renderField(field, existingRow, optionsByField[field.key])).join("")}
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="btn-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Salvar</button>
      </div>
    </form>
  `;

  const searchSelects = {};
  for (const field of config.fields) {
    if (field.type !== "search-select") continue;
    const mount = body.querySelector(`[data-search-select="${field.key}"]`);
    // Campos que dependem de outro (ex.: fornecedor filtrado pela empresa
    // escolhida) recarregam suas opções quando o campo do qual dependem muda,
    // em vez de listar opções de todas as empresas de uma vez.
    const dependents = config.fields.filter((f) => f.dependsOn === field.key && f.optionsLoader);
    searchSelects[field.key] = createSearchSelect({
      container: mount,
      placeholder: field.placeholder || `Buscar ${field.label.toLowerCase()}…`,
      options: optionsByField[field.key] || [],
      value: existingRow ? existingRow[field.key] : (field.default ?? null),
      allowClear: !field.required,
      onChange: dependents.length
        ? async (value) => {
            for (const dep of dependents) {
              searchSelects[dep.key]?.setOptions(await dep.optionsLoader(existingRow, value));
            }
          }
        : undefined,
    });
  }

  for (const field of config.fields) {
    if (field.type !== "cep") continue;
    wireCepField(body, field);
  }

  body.querySelector("#btn-cancel").addEventListener("click", closeModal);

  body.querySelector("#cadastro-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {};
    const errorEl = form.querySelector("#form-error");
    errorEl.innerHTML = "";

    for (const field of config.fields) {
      if (field.type === "search-select") {
        const value = searchSelects[field.key].getValue();
        if (field.required && !value) {
          errorEl.innerHTML = `<div class="form-error">Selecione um valor para "${escapeHtml(field.label)}".</div>`;
          return;
        }
        payload[field.key] = value;
        continue;
      }
      const input = form.elements[field.key];
      if (field.type === "checkbox") {
        payload[field.key] = input.checked;
      } else if (field.type === "number") {
        payload[field.key] = input.value === "" ? null : Number(input.value);
      } else {
        payload[field.key] = input.value === "" ? null : input.value;
      }
    }

    const query = isEdit
      ? supabase.from(config.table).update(payload).eq("id", existingRow.id)
      : supabase.from(config.table).insert(payload);

    const { error } = await query;

    if (error) {
      const friendly = friendlyPgError(error, { 23505: "Já existe um registro com os mesmos dados (verifique se algum campo precisa ser único, como o documento)." });
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendly)}</div>`;
      return;
    }

    showToast(`${config.titleSingular} ${isEdit ? "atualizado" : "cadastrado"}.`);
    closeModal();
    if (onSaved) onSaved();
  });
}

// Ao sair do campo de CEP, consulta o endereço e preenche os campos
// mapeados em `field.autofillMap` (ex.: { logradouro: "endereco", localidade:
// "cidade", uf: "uf" }) — sem travar o resto do formulário se a consulta falhar.
function wireCepField(body, field) {
  const input = body.querySelector(`#f-${field.key}`);
  const hint = body.querySelector(`#f-${field.key}-hint`);
  const form = body.querySelector("#cadastro-form");

  input.addEventListener("blur", async () => {
    const digits = input.value.replace(/\D/g, "");
    if (!digits) {
      hint.hidden = true;
      return;
    }

    hint.hidden = false;
    hint.className = "field-hint";
    hint.textContent = "Buscando endereço…";

    try {
      const endereco = await consultarCep(digits);
      hint.hidden = true;
      if (field.autofillMap) {
        for (const [sourceKey, targetName] of Object.entries(field.autofillMap)) {
          const targetInput = form.elements[targetName];
          if (targetInput && endereco[sourceKey]) targetInput.value = endereco[sourceKey];
        }
      }
    } catch (err) {
      hint.hidden = false;
      hint.className = "field-hint field-hint--error";
      hint.textContent = err.message;
    }
  });
}

function renderField(field, existingRow, options) {
  const value = existingRow ? existingRow[field.key] : field.default;
  const wrapClass = field.full ? "field field--full" : "field";
  const required = field.required ? "required" : "";
  const requiredMark = field.required ? '<span class="field-required">*</span>' : "";

  if (field.type === "checkbox") {
    const checked = existingRow ? Boolean(value) : field.default !== false;
    return `
      <div class="${wrapClass}">
        <label><input type="checkbox" name="${field.key}" ${checked ? "checked" : ""} /> ${escapeHtml(field.label)}</label>
      </div>
    `;
  }

  if (field.type === "search-select") {
    return `
      <div class="${wrapClass}">
        <label>${escapeHtml(field.label)}${requiredMark}</label>
        <div data-search-select="${field.key}"></div>
      </div>
    `;
  }

  if (field.type === "select") {
    return `
      <div class="${wrapClass}">
        <label for="f-${field.key}">${escapeHtml(field.label)}${requiredMark}</label>
        <select class="input" id="f-${field.key}" name="${field.key}" ${required}>
          <option value="">—</option>
          ${(options || []).map((opt) => `<option value="${escapeHtml(opt.value)}" ${String(value) === String(opt.value) ? "selected" : ""}>${escapeHtml(opt.label)}</option>`).join("")}
        </select>
      </div>
    `;
  }

  // "combo": input de texto livre com sugestões (datalist nativo) — ao
  // contrário de "select", não obriga escolher um valor já existente.
  // Usado em campos como categoria/origem, onde travar numa lista fixa
  // impediria cadastrar um valor novo, mas texto livre puro deixa a
  // mesma categoria virar "Suplemento"/"Suplementos" sem ninguém notar.
  if (field.type === "combo") {
    return `
      <div class="${wrapClass}">
        <label for="f-${field.key}">${escapeHtml(field.label)}${requiredMark}</label>
        <input class="input" type="text" id="f-${field.key}" name="${field.key}" list="dl-${field.key}" value="${escapeHtml(value ?? "")}" ${required} />
        <datalist id="dl-${field.key}">
          ${(options || []).map((opt) => `<option value="${escapeHtml(opt.value)}"></option>`).join("")}
        </datalist>
      </div>
    `;
  }

  if (field.type === "textarea") {
    return `
      <div class="${wrapClass}">
        <label for="f-${field.key}">${escapeHtml(field.label)}${requiredMark}</label>
        <textarea class="input" id="f-${field.key}" name="${field.key}" rows="3" ${required}>${escapeHtml(value ?? "")}</textarea>
      </div>
    `;
  }

  if (field.type === "cep") {
    return `
      <div class="${wrapClass}">
        <label for="f-${field.key}">${escapeHtml(field.label)}${requiredMark}</label>
        <input class="input" type="text" id="f-${field.key}" name="${field.key}" value="${escapeHtml(value ?? "")}" placeholder="00000-000" inputmode="numeric" ${required} />
        <p class="field-hint" id="f-${field.key}-hint" hidden></p>
      </div>
    `;
  }

  return `
    <div class="${wrapClass}">
      <label for="f-${field.key}">${escapeHtml(field.label)}${requiredMark}</label>
      <input class="input" type="${field.type || "text"}" id="f-${field.key}" name="${field.key}" step="${field.step || ""}" value="${escapeHtml(value ?? "")}" ${required} />
    </div>
  `;
}
