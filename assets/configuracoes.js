// ERPConnect — Administração > Configurações: painel único de variáveis
// para operar o mesmo app com várias empresas/clientes diferentes
// (white-label), reestruturado em seções. Só admins globais (sem empresa
// vinculada) acessam esta tela — a rota já é bloqueada em app.js
// (globalAdminOnly), e a RPC `atualizar_config_empresa` revalida a mesma
// regra no banco.

import { supabase } from "./supabaseClient.js";
import { showToast, escapeHtml, friendlyPgError, createSearchSelect, DEFAULT_APP_NAME } from "./app.js";
import { HORARIOS_PADRAO } from "./agenda.js";

const HORARIO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const COR_RE = /^#[0-9a-fA-F]{6}$/;
const COR_PADRAO = "#2a8a5a";

// Agrupado pelas mesmas áreas da barra lateral (breadcrumb em app.js) —
// facilita achar "todo o Financeiro" ou "toda a Loja" em vez de uma lista
// solta de 11 itens sem relação visual entre eles.
const MENU_GRUPOS = [
  {
    label: "Cadastros",
    items: [
      { key: "clientes", label: "Clientes" },
      { key: "produtos", label: "Produtos" },
      { key: "fornecedores", label: "Fornecedores" },
    ],
  },
  {
    label: "Movimentações",
    items: [
      { key: "crm", label: "CRM (Propostas)" },
      { key: "vendas", label: "Loja" },
      { key: "agenda", label: "Agenda" },
      { key: "estoques", label: "Estoques" },
      { key: "matriculas", label: "Matrículas" },
    ],
  },
  {
    label: "Financeiro",
    items: [
      { key: "contas-receber", label: "Contas a Receber" },
      { key: "contas-pagar", label: "Contas a Pagar" },
    ],
  },
  {
    label: "Relatórios",
    items: [
      { key: "relatorios", label: "Visão geral (Relatórios)" },
    ],
  },
];
const MENU_ITEMS = MENU_GRUPOS.flatMap((g) => g.items);

async function loadEmpresasOptions() {
  const { data } = await supabase
    .from("empresas")
    .select("id, nome_fantasia, codigo, ativo")
    .order("nome_fantasia", { ascending: true });
  return (data || []).map((e) => ({ value: e.id, label: e.nome_fantasia, meta: e.ativo ? e.codigo : `${e.codigo} · inativa` }));
}

export async function render(view, actionsEl) {
  actionsEl.innerHTML = "";
  view.innerHTML = `
    <div class="card card-section">
      <p class="section-title">Selecione a empresa</p>
      <p class="field-hint" style="margin: -0.4rem 0 1rem;">Escolha para qual empresa/cliente você quer configurar identidade, módulos, regras e usuários — cada empresa tem seu próprio conjunto de variáveis.</p>
      <div class="field field--full" style="max-width: 28rem;">
        <div data-mount="f-empresa"></div>
      </div>
    </div>
    <div id="config-form-mount"></div>
  `;

  const empresasOptions = await loadEmpresasOptions();
  const formMount = view.querySelector("#config-form-mount");

  createSearchSelect({
    container: view.querySelector('[data-mount="f-empresa"]'),
    placeholder: "Buscar empresa…",
    options: empresasOptions,
    onChange: async (empresaId) => {
      if (!empresaId) {
        formMount.innerHTML = "";
        return;
      }
      await renderConfigForm(formMount, empresaId);
    },
  });
}

async function renderConfigForm(formMount, empresaId) {
  formMount.innerHTML = `<div class="card card-section"><p class="section-title">Carregando…</p></div>`;

  const { data: empresa, error } = await supabase
    .from("empresas")
    .select("id, nome_fantasia, nome_aplicacao, menus_habilitados, horarios_agenda, cor_primaria, rodape_documentos, limite_usuarios, dias_lembrete_vencimento, papel_padrao_novo_usuario")
    .eq("id", empresaId)
    .single();

  if (error) {
    formMount.innerHTML = `<div class="empty-state"><p class="empty-state__title">Erro ao carregar configuração</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  const menus = empresa.menus_habilitados || {};
  const horariosAtuais = (empresa.horarios_agenda || []).join(", ");
  const corAtual = COR_RE.test(empresa.cor_primaria || "") ? empresa.cor_primaria : COR_PADRAO;
  const papelPadrao = empresa.papel_padrao_novo_usuario === "admin" ? "admin" : "caixa";

  formMount.innerHTML = `
    <form id="config-form">
      <div id="form-error"></div>

      <div class="card card-section">
        <p class="section-title">Identidade — ${escapeHtml(empresa.nome_fantasia)}</p>
        <p class="field-hint" style="margin: -0.4rem 0 1rem;">Campos comuns de marca, aplicados só para os usuários vinculados a esta empresa.</p>
        <div class="form-grid">
          <div class="field field--full">
            <label for="f-nome-aplicacao">Nome exibido na sidebar e na aba do navegador</label>
            <input class="input" type="text" id="f-nome-aplicacao" name="nome_aplicacao" value="${escapeHtml(empresa.nome_aplicacao ?? "")}" placeholder="${escapeHtml(DEFAULT_APP_NAME)} (padrão)" maxlength="60" />
            <p class="field-hint">Deixe em branco para usar o nome padrão (${escapeHtml(DEFAULT_APP_NAME)}). A tela de login continua mostrando o nome padrão.</p>
          </div>
          <div class="field">
            <label for="f-cor-primaria">Cor de destaque</label>
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <input type="color" id="f-cor-primaria-picker" value="${escapeHtml(corAtual)}" style="width:2.6rem; height:2.4rem; padding:0; border:1px solid var(--line); border-radius:0.4rem; background:none;" />
              <input class="input" type="text" id="f-cor-primaria" name="cor_primaria" value="${escapeHtml(empresa.cor_primaria ?? "")}" placeholder="${COR_PADRAO} (padrão)" maxlength="7" style="max-width:9rem;" />
            </div>
            <p class="field-hint" id="f-cor-primaria-hint">Aplicada na sidebar e nos botões principais para esta empresa. Deixe em branco para usar a cor padrão do sistema.</p>
          </div>
        </div>
      </div>

      <div class="card card-section">
        <p class="section-title">Módulos habilitados</p>
        <p class="field-hint" style="margin: -0.4rem 0 1rem;">Desmarque para esconder o item do menu de todos os usuários desta empresa (Início e Administração ficam sempre visíveis).</p>
        ${MENU_GRUPOS.map((grupo) => `
          <p class="cell-muted" style="font-weight:600; margin: 0.8rem 0 0.4rem; text-transform:uppercase; font-size:0.72rem; letter-spacing:0.04em;">${escapeHtml(grupo.label)}</p>
          <div class="form-grid">
            ${grupo.items.map((item) => `
              <div class="field">
                <label><input type="checkbox" name="menu-${item.key}" ${menus[item.key] === false ? "" : "checked"} /> ${escapeHtml(item.label)}</label>
              </div>
            `).join("")}
          </div>
        `).join("")}
      </div>

      <div class="card card-section">
        <p class="section-title">Agenda</p>
        <div class="field field--full">
          <label for="f-horarios-agenda">Horários de atendimento, separados por vírgula</label>
          <input class="input" type="text" id="f-horarios-agenda" name="horarios_agenda" value="${escapeHtml(horariosAtuais)}" placeholder="${escapeHtml(HORARIOS_PADRAO.join(", "))} (padrão)" />
          <p class="field-hint" id="f-horarios-agenda-hint">Formato 24h, "HH:MM" (ex.: 08:00, 08:30, 09:00…). Deixe em branco para usar a grade padrão do sistema.</p>
        </div>
      </div>

      <div class="card card-section">
        <p class="section-title">Regras &amp; lembretes</p>
        <div class="form-grid">
          <div class="field">
            <label for="f-dias-lembrete">Avisar conta a pagar vencendo com quantos dias de antecedência</label>
            <input class="input" type="number" id="f-dias-lembrete" name="dias_lembrete_vencimento" min="0" step="1" value="${Number(empresa.dias_lembrete_vencimento ?? 1)}" />
            <p class="field-hint">0 = só no próprio dia do vencimento. O lembrete é enviado por e-mail para o endereço cadastrado da empresa.</p>
          </div>
          <div class="field field--full">
            <label for="f-rodape-documentos">Rodapé customizado dos documentos</label>
            <textarea class="input" id="f-rodape-documentos" name="rodape_documentos" rows="2" placeholder="Ex.: CNPJ, endereço, política de trocas…">${escapeHtml(empresa.rodape_documentos ?? "")}</textarea>
            <p class="field-hint">Anexado ao final do e-mail de proposta (CRM) enviado por esta empresa. Deixe em branco para nenhum rodapé extra.</p>
          </div>
        </div>
      </div>

      <div class="card card-section">
        <p class="section-title">Usuários</p>
        <div class="form-grid">
          <div class="field">
            <label>Papel padrão para novo usuário</label>
            <div class="segmented" id="f-papel-padrao" role="radiogroup" aria-label="Papel padrão">
              <button type="button" class="segmented__btn ${papelPadrao === "caixa" ? "is-active" : ""}" data-value="caixa" role="radio" aria-checked="${papelPadrao === "caixa"}">Caixa</button>
              <button type="button" class="segmented__btn ${papelPadrao === "admin" ? "is-active" : ""}" data-value="admin" role="radio" aria-checked="${papelPadrao === "admin"}">Administrador</button>
            </div>
            <p class="field-hint">Pré-seleciona o papel ao abrir "+ Novo usuário" em Administração → Usuários para esta empresa.</p>
          </div>
          <div class="field">
            <label for="f-limite-usuarios">Limite de usuários ativos</label>
            <input class="input" type="number" id="f-limite-usuarios" name="limite_usuarios" min="1" step="1" value="${empresa.limite_usuarios ?? ""}" placeholder="Sem limite" />
            <p class="field-hint">Deixe em branco para não limitar. Ao atingir o limite, novos usuários só podem ser criados depois de desativar outro.</p>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn--primary">Salvar configurações</button>
      </div>
    </form>

    <div class="card card-section" id="auditoria-card">
      <p class="section-title">Auditoria</p>
      <p class="field-hint" style="margin: -0.4rem 0 1rem;">Últimas alterações em produtos, clientes, fornecedores, vendas, matrículas e contas a pagar desta empresa — quem mexeu, quando e o quê.</p>
      <div id="auditoria-mount"></div>
    </div>
  `;

  wireCorPrimaria(formMount);
  await renderAuditoria(formMount, empresaId);

  let papelPadraoSelecionado = papelPadrao;
  const papelGroup = formMount.querySelector("#f-papel-padrao");
  papelGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    papelPadraoSelecionado = btn.dataset.value;
    papelGroup.querySelectorAll(".segmented__btn").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-checked", String(active));
    });
  });

  formMount.querySelector("#config-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = form.querySelector("#form-error");
    errorEl.innerHTML = "";

    const menusHabilitados = {};
    MENU_ITEMS.forEach((item) => {
      menusHabilitados[item.key] = form.elements[`menu-${item.key}`].checked;
    });

    const horariosRaw = form.elements.horarios_agenda.value.trim();
    let horariosAgenda = null;
    if (horariosRaw) {
      horariosAgenda = horariosRaw.split(",").map((h) => h.trim()).filter(Boolean);
      const invalido = horariosAgenda.find((h) => !HORARIO_RE.test(h));
      if (invalido) {
        errorEl.innerHTML = `<div class="form-error">Horário inválido: "${escapeHtml(invalido)}". Use o formato 24h "HH:MM" (ex.: 08:00), separado por vírgulas.</div>`;
        return;
      }
      horariosAgenda = [...new Set(horariosAgenda)].sort();
    }

    const corRaw = form.elements.cor_primaria.value.trim();
    if (corRaw && !COR_RE.test(corRaw)) {
      errorEl.innerHTML = `<div class="form-error">Cor inválida: "${escapeHtml(corRaw)}". Use o formato hexadecimal, ex.: #2a8a5a.</div>`;
      return;
    }

    const diasLembreteRaw = form.elements.dias_lembrete_vencimento.value;
    const diasLembrete = diasLembreteRaw === "" ? 1 : Number(diasLembreteRaw);
    if (!Number.isInteger(diasLembrete) || diasLembrete < 0) {
      errorEl.innerHTML = `<div class="form-error">Dias de antecedência do lembrete deve ser um número inteiro, zero ou mais.</div>`;
      return;
    }

    const limiteRaw = form.elements.limite_usuarios.value.trim();
    let limiteUsuarios = null;
    if (limiteRaw) {
      limiteUsuarios = Number(limiteRaw);
      if (!Number.isInteger(limiteUsuarios) || limiteUsuarios <= 0) {
        errorEl.innerHTML = `<div class="form-error">O limite de usuários deve ser um número inteiro maior que zero (ou em branco para sem limite).</div>`;
        return;
      }
    }

    const { error: saveError } = await supabase.rpc("atualizar_config_empresa", {
      p_empresa_id: empresaId,
      p_nome_aplicacao: form.elements.nome_aplicacao.value,
      p_menus_habilitados: menusHabilitados,
      p_horarios_agenda: horariosAgenda,
      p_cor_primaria: corRaw || null,
      p_rodape_documentos: form.elements.rodape_documentos.value,
      p_limite_usuarios: limiteUsuarios,
      p_dias_lembrete_vencimento: diasLembrete,
      p_papel_padrao_novo_usuario: papelPadraoSelecionado,
    });

    if (saveError) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(saveError))}</div>`;
      return;
    }

    showToast("Configurações salvas.");
  });
}

const AUDIT_TABELA_LABEL = {
  produtos: "Produto", clientes: "Cliente", fornecedores: "Fornecedor",
  vendas: "Venda", matriculas: "Matrícula", contas_pagar: "Conta a pagar",
};
const AUDIT_ACAO_LABEL = { insert: "Criado", update: "Alterado", delete: "Excluído" };
const AUDIT_ACAO_CLASS = { insert: "ativo", update: "pendente", delete: "inativo" };

// Log de auditoria do próprio ERPConnect (tabela erp_audit_log, migration
// 0041) — antes disso, nenhuma alteração de preço/cadastro/exclusão ficava
// registrada em lugar nenhum. Só lista aqui (RLS já restringe a admin);
// "ver detalhes" expande o snapshot antes/depois gravado pela trigger.
async function renderAuditoria(formMount, empresaId) {
  const mount = formMount.querySelector("#auditoria-mount");
  mount.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const { data, error } = await supabase
    .from("erp_audit_log")
    .select("id, tabela, acao, registro_id, created_at, dados_antes, dados_depois, usuario:usuarios(nome)")
    .eq("empresa_id", empresaId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    mount.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar a auditoria</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  const linhas = data || [];
  if (linhas.length === 0) {
    mount.innerHTML = `<div class="empty-state" style="padding: 1.5rem;">Nenhuma alteração registrada ainda para esta empresa.</div>`;
    return;
  }

  mount.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Data/hora</th><th>Tabela</th><th>Ação</th><th>Usuário</th><th></th></tr></thead>
        <tbody>
          ${linhas.map((l) => `
            <tr>
              <td>${new Date(l.created_at).toLocaleString("pt-BR")}</td>
              <td>${escapeHtml(AUDIT_TABELA_LABEL[l.tabela] || l.tabela)}</td>
              <td><span class="status status--${AUDIT_ACAO_CLASS[l.acao] || "pendente"}">${escapeHtml(AUDIT_ACAO_LABEL[l.acao] || l.acao)}</span></td>
              <td class="cell-muted">${escapeHtml(l.usuario?.nome || "—")}</td>
              <td class="cell-actions"><button type="button" class="btn btn--ghost btn--sm" data-ver-detalhe="${l.id}">Ver detalhes</button></td>
            </tr>
            <tr id="audit-detalhe-${l.id}" hidden>
              <td colspan="5">
                <pre class="cell-muted" style="white-space: pre-wrap; font-size: 0.78rem; margin: 0;">${escapeHtml(JSON.stringify({ antes: l.dados_antes, depois: l.dados_depois }, null, 2))}</pre>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  mount.querySelectorAll("[data-ver-detalhe]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = mount.querySelector(`#audit-detalhe-${btn.dataset.verDetalhe}`);
      if (row) row.hidden = !row.hidden;
    });
  });
}

// Color picker nativo e o campo de texto hex ficam sincronizados nos dois
// sentidos — o texto é o que de fato viaja no submit (permite deixar em
// branco para "usar o padrão", coisa que um <input type="color"> sozinho
// não permite representar).
function wireCorPrimaria(formMount) {
  const picker = formMount.querySelector("#f-cor-primaria-picker");
  const texto = formMount.querySelector("#f-cor-primaria");

  picker.addEventListener("input", () => {
    texto.value = picker.value;
  });

  texto.addEventListener("input", () => {
    if (COR_RE.test(texto.value.trim())) picker.value = texto.value.trim();
  });
}
