// ERPConnect — cadastro de usuários (somente administradores acessam esta
// tela; a rota já é bloqueada em app.js, mas as ações também são
// re-validadas do lado do servidor pela edge function manage-usuarios).

import { supabase } from "./supabaseClient.js";
import { callManageUsuarios, getCurrentUsuario } from "./auth.js";
import { showToast, openModal, closeModal, confirmDialog, escapeHtml, skeletonTable, registerAutoRefresh, createSearchSelect, friendlyPgError } from "./app.js";

async function loadEmpresasOptions() {
  const { data } = await supabase
    .from("empresas")
    .select("id, nome_fantasia, codigo, papel_padrao_novo_usuario")
    .eq("ativo", true)
    .order("nome_fantasia", { ascending: true });
  // papelPadrao viaja junto com a opção (não aparece no label/meta) só para
  // o formulário de novo usuário poder pré-selecionar o papel configurado
  // em Configurações > Usuários para a empresa escolhida.
  return (data || []).map((e) => ({ value: e.id, label: e.nome_fantasia, meta: e.codigo, papelPadrao: e.papel_padrao_novo_usuario }));
}

const SEARCH_ICON = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

export async function render(view, actionsEl) {
  actionsEl.innerHTML = `<button type="button" class="btn btn--primary" id="btn-new">+ Novo usuário</button>`;
  view.innerHTML = `
    <div class="toolbar">
      <div class="search-input-wrap">
        ${SEARCH_ICON}
        <input type="search" class="input" id="search-input" placeholder="Buscar por nome ou usuário…" />
      </div>
      <p class="record-count" id="record-count"></p>
    </div>
    ${skeletonTable()}
  `;

  const searchInput = view.querySelector("#search-input");

  actionsEl.querySelector("#btn-new").addEventListener("click", () => {
    openForm(null, () => loadRows(view, searchInput.value.trim()));
  });

  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadRows(view, searchInput.value.trim()), 250);
  });

  await loadRows(view, "");
  registerAutoRefresh(() => loadRows(view, searchInput.value.trim()), 15000);
}

function normalize(str) {
  return String(str ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

async function loadRows(view, term) {
  const countEl = view.querySelector("#record-count");
  const existingCard = view.querySelector(".card");

  if (!existingCard) {
    view.insertAdjacentHTML("beforeend", skeletonTable());
    if (countEl) countEl.textContent = "";
  }

  const { data, error } = await supabase
    .from("usuarios")
    .select("id, nome, login, role, ativo, empresa_id, created_at, empresa:empresas(nome_fantasia)")
    .order("nome", { ascending: true });

  const card = view.querySelector(".card");

  if (error) {
    card.innerHTML = `<div class="empty-state"><p class="empty-state__title">Erro ao carregar</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  const normalizedTerm = normalize(term);
  const filtered = normalizedTerm
    ? (data || []).filter((u) => normalize(u.nome).includes(normalizedTerm) || normalize(u.login).includes(normalizedTerm))
    : (data || []);

  if (filtered.length === 0) {
    card.innerHTML = `<div class="empty-state"><p class="empty-state__title">Nenhum usuário encontrado</p><p class="empty-state__hint">Use "+ Novo usuário" para cadastrar o primeiro.</p></div>`;
    return;
  }

  if (countEl) countEl.textContent = `${filtered.length} registro${filtered.length === 1 ? "" : "s"}`;

  renderTable(view, card, filtered);
}

function roleLabel(role) {
  return role === "admin" ? "Administrador" : "Caixa";
}

function renderTable(view, card, data) {
  const me = getCurrentUsuario();

  const rows = data.map((row) => {
    const isSelf = Boolean(me && me.id === row.id);
    return `
    <tr>
      <td class="cell-rail" style="--rail-color: var(${row.ativo ? "--success" : "--text-muted"})">${escapeHtml(row.nome)}${isSelf ? ' <span class="cell-muted">(você)</span>' : ""}</td>
      <td>${escapeHtml(row.login)}</td>
      <td><span class="status status--${row.role}">${roleLabel(row.role)}</span></td>
      <td>${escapeHtml(row.empresa?.nome_fantasia || "—")}</td>
      <td><span class="status status--${row.ativo ? "ativo" : "inativo"}">${row.ativo ? "Ativo" : "Inativo"}</span></td>
      <td class="cell-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-edit="${row.id}">Editar</button>
        <button type="button" class="btn btn--ghost btn--sm" data-reset="${row.id}">Redefinir senha</button>
        ${isSelf ? "" : `<button type="button" class="btn btn--danger btn--sm" data-delete="${row.id}">Excluir</button>`}
      </td>
    </tr>
  `;
  }).join("");

  card.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Nome</th><th>Usuário</th><th>Papel</th><th>Empresa</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  card.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = data.find((r) => r.id === btn.dataset.edit);
      openForm(row, () => loadRows(view, view.querySelector("#search-input").value.trim()));
    });
  });

  card.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", () => openResetForm(btn.dataset.reset));
  });

  card.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = data.find((r) => r.id === btn.dataset.delete);
      const ok = await confirmDialog(`Excluir o usuário "${row.nome}"? Esta ação não pode ser desfeita.`, { confirmLabel: "Excluir" });
      if (!ok) return;
      try {
        await callManageUsuarios("delete", { id: row.id });
        showToast("Usuário excluído.");
        loadRows(view, view.querySelector("#search-input").value.trim());
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  });
}

function requiredMark() {
  return '<span class="field-required">*</span>';
}

async function openForm(existingRow, onSaved) {
  const isEdit = Boolean(existingRow);
  const me = getCurrentUsuario();
  const isSelf = isEdit && Boolean(me && me.id === existingRow.id);
  const body = openModal(isEdit ? "Editar usuário" : "Novo usuário");
  const empresasOptions = await loadEmpresasOptions();

  body.innerHTML = `
    <form id="usuario-form">
      <div id="form-error"></div>
      <div class="form-grid">
        <div class="field field--full">
          <label for="f-nome">Nome${requiredMark()}</label>
          <input class="input" type="text" id="f-nome" name="nome" value="${escapeHtml(existingRow?.nome ?? "")}" required />
        </div>
        <div class="field field--full">
          <label for="f-login">Usuário (login)${requiredMark()}</label>
          <input class="input" type="text" id="f-login" name="login" value="${escapeHtml(existingRow?.login ?? "")}" autocapitalize="none" autocorrect="off" spellcheck="false" ${isEdit ? "disabled" : "required"} />
          ${isEdit ? '<p class="cell-muted" style="font-size:0.75rem;">O login não pode ser alterado depois de criado.</p>' : ""}
        </div>
        ${isEdit ? "" : `
        <div class="field field--full">
          <label for="f-senha">Senha${requiredMark()}</label>
          <input class="input" type="password" id="f-senha" name="senha" minlength="6" required />
        </div>
        `}
        <div class="field field--full">
          <label>Papel${requiredMark()}</label>
          <div class="segmented" id="f-role" role="radiogroup" aria-label="Papel">
            <button type="button" class="segmented__btn ${(existingRow?.role ?? "caixa") === "caixa" ? "is-active" : ""}" data-value="caixa" role="radio" aria-checked="${(existingRow?.role ?? "caixa") === "caixa"}" ${isSelf ? "disabled" : ""}>Caixa</button>
            <button type="button" class="segmented__btn ${existingRow?.role === "admin" ? "is-active" : ""}" data-value="admin" role="radio" aria-checked="${existingRow?.role === "admin"}" ${isSelf ? "disabled" : ""}>Administrador</button>
          </div>
        </div>
        <div class="field field--full">
          <label>Empresa<span class="field-required" id="f-empresa-required">*</span></label>
          <div data-mount="f-empresa"></div>
        </div>
        ${isEdit ? `
        <div class="field field--full">
          <label><input type="checkbox" name="ativo" ${existingRow.ativo ? "checked" : ""} ${isSelf ? "disabled" : ""} /> Usuário ativo</label>
        </div>
        ` : ""}
      </div>
      ${isSelf ? '<p class="cell-muted" style="font-size:0.8rem; margin: -0.5rem 0 1rem;">Você não pode alterar seu próprio papel nem desativar sua conta.</p>' : ""}
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="btn-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Salvar</button>
      </div>
    </form>
  `;

  const empresaSelect = createSearchSelect({
    container: body.querySelector('[data-mount="f-empresa"]'),
    placeholder: "Buscar empresa…",
    options: empresasOptions,
    value: existingRow?.empresa_id ?? null,
    allowClear: true,
    // Só em criação: trocar a empresa atualiza o papel pré-selecionado para
    // o padrão configurado nela (o admin ainda pode sobrepor manualmente).
    // Editar um usuário existente nunca deve mudar o papel dele sozinho.
    onChange: isEdit ? undefined : (_empresaId, opt) => setRole(opt?.papelPadrao || "caixa"),
  });

  const empresaRequiredMark = body.querySelector("#f-empresa-required");

  // Novo usuário parte do papel padrão configurado para a empresa do
  // próprio admin logado (Configurações > Usuários) — global admin sem
  // empresa própria cai no "caixa" de sempre até escolher uma empresa no
  // combo abaixo, que então atualiza para o padrão dela.
  let role = existingRow?.role ?? (isEdit ? "caixa" : (getCurrentUsuario()?.empresa?.papel_padrao_novo_usuario || "caixa"));
  const roleGroup = body.querySelector("#f-role");

  function setRole(newRole) {
    role = newRole;
    roleGroup.querySelectorAll(".segmented__btn").forEach((b) => {
      const active = b.dataset.value === newRole;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
    updateEmpresaRequiredMark();
  }

  function updateEmpresaRequiredMark() {
    empresaRequiredMark.hidden = role === "admin";
  }
  setRole(role);

  roleGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn || btn.disabled) return;
    setRole(btn.dataset.value);
  });

  body.querySelector("#btn-cancel").addEventListener("click", closeModal);

  body.querySelector("#usuario-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector("#form-error");
    errorEl.innerHTML = "";

    const empresaId = empresaSelect.getValue();
    if (role !== "admin" && !empresaId) {
      errorEl.innerHTML = `<div class="form-error">Selecione uma empresa para este usuário.</div>`;
      return;
    }

    try {
      if (isEdit) {
        const payload = { id: existingRow.id, nome: form.elements.nome.value.trim(), role, empresa_id: empresaId };
        if (!isSelf) payload.ativo = form.elements.ativo.checked;
        const { usuario } = await callManageUsuarios("update", payload);
        showToast(`Usuário ${usuario.nome} atualizado.`);
      } else {
        const payload = {
          nome: form.elements.nome.value.trim(),
          login: form.elements.login.value.trim(),
          senha: form.elements.senha.value,
          role,
          empresa_id: empresaId,
        };
        const { usuario } = await callManageUsuarios("create", payload);
        showToast(`Usuário ${usuario.nome} cadastrado.`);
      }
      closeModal();
      if (onSaved) onSaved();
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  });
}

function openResetForm(id) {
  const body = openModal("Redefinir senha");
  body.innerHTML = `
    <form id="reset-form">
      <div id="form-error"></div>
      <div class="field field--full">
        <label for="f-nova-senha">Nova senha${requiredMark()}</label>
        <input class="input" type="password" id="f-nova-senha" minlength="6" required />
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="btn-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Redefinir</button>
      </div>
    </form>
  `;

  body.querySelector("#btn-cancel").addEventListener("click", closeModal);

  body.querySelector("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = body.querySelector("#form-error");
    errorEl.innerHTML = "";
    const senha = body.querySelector("#f-nova-senha").value;

    try {
      await callManageUsuarios("reset_password", { id, senha });
      showToast("Senha redefinida.");
      closeModal();
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  });
}
