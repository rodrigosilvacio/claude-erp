import { renderCadastro } from "./cadastro.js";
import { supabase } from "./supabaseClient.js";
import { showToast, friendlyPgError, openModal, formatCurrency, formatDate, escapeHtml } from "./app.js";
import { getCurrentEmpresaId } from "./auth.js";

const SITUACAO_LABEL = { pendente: "Pendente", aprovado: "Aprovado", reprovado: "Reprovado" };

// Lista sugerida (não travada — o campo é "combo", aceita texto livre) de
// canais de origem. Mesma lista usada no formulário de proposta do CRM
// (crm.js), pra manter os valores consistentes entre as duas telas.
const ORIGEM_OPTIONS = [
  { value: "Indicação", label: "Indicação" },
  { value: "Instagram", label: "Instagram" },
  { value: "Facebook", label: "Facebook" },
  { value: "Google", label: "Google" },
  { value: "Site", label: "Site" },
  { value: "Evento", label: "Evento" },
  { value: "Passando na rua", label: "Passando na rua" },
  { value: "Outro", label: "Outro" },
];
function loadOrigemOptions() {
  return ORIGEM_OPTIONS;
}

// Roadmap Fase 2 — "página única do cliente": em vez de abrir Vendas, CRM,
// Matrículas e Agenda separadamente para saber tudo sobre um cliente, o
// histórico junta as quatro origens por cliente_id numa única linha do
// tempo, só lendo dados que a RLS já restringe à empresa de quem está logado.
const VENDA_STATUS_LABEL = { orcamento: "Orçamento", confirmada: "Confirmada", cancelada: "Cancelada" };
const MATRICULA_STATUS_LABEL = { ativa: "Ativa", aguardando_pagamento: "Aguardando pagamento", cancelada: "Cancelada" };
const PROPOSTA_STATUS_LABEL = { draft: "Rascunho", enviada: "Enviada", aprovada: "Aprovada", reprovada: "Reprovada" };
const AGENDAMENTO_STATUS_LABEL = { agendado: "Agendado", atendido: "Atendido" };

export async function render(view, actionsEl) {
  await renderCadastro(view, actionsEl, {
    table: "clientes",
    titleSingular: "Cliente",
    searchPlaceholder: "Buscar por nome, documento ou cidade…",
    searchColumns: ["nome", "documento", "cidade"],
    orderBy: "nome",
    scopeByEmpresa: true,
    columns: [
      { key: "nome", label: "Nome" },
      { key: "documento", label: "Documento" },
      { key: "telefone", label: "Telefone" },
      { key: "cidade", label: "Cidade" },
      { key: "origem", label: "Origem", render: (row) => escapeHtml(row.origem || "—") },
      {
        key: "status_cadastro",
        label: "Situação",
        render: (row) => `<span class="status status--${row.status_cadastro}">${SITUACAO_LABEL[row.status_cadastro] || row.status_cadastro}</span>`,
      },
      {
        key: "ativo",
        label: "Status",
        render: (row) => `<span class="status status--${row.ativo ? "ativo" : "inativo"}">${row.ativo ? "Ativo" : "Inativo"}</span>`,
      },
    ],
    fields: [
      { key: "nome", label: "Nome", required: true, full: true },
      { key: "documento", label: "CPF/CNPJ" },
      { key: "cep", label: "CEP", type: "cep", autofillMap: { logradouro: "endereco", localidade: "cidade", uf: "uf" } },
      { key: "endereco", label: "Endereço", full: true },
      { key: "cidade", label: "Cidade" },
      { key: "uf", label: "UF" },
      { key: "email", label: "E-mail", type: "email" },
      { key: "telefone", label: "Telefone" },
      { key: "origem", label: "Origem / canal", type: "combo", optionsLoader: loadOrigemOptions },
      { key: "ativo", label: "Cliente ativo", type: "checkbox", default: true, full: true },
    ],
    rowActions: (row) => {
      const historico = `<button type="button" class="btn btn--ghost btn--sm" data-row-action="historico" data-row-action-id="${row.id}">Histórico</button>`;
      if (row.status_cadastro === "aprovado") return historico;
      const aprovar = `<button type="button" class="btn btn--primary btn--sm" data-row-action="aprovar" data-row-action-id="${row.id}">Aprovar</button>`;
      const reprovar = row.status_cadastro === "pendente"
        ? `<button type="button" class="btn btn--danger btn--sm" data-row-action="reprovar" data-row-action-id="${row.id}">Reprovar</button>`
        : "";
      return historico + aprovar + reprovar;
    },
    onRowAction: async (action, row, reload) => {
      if (action === "historico") {
        abrirHistorico(row);
        return;
      }
      const patch = action === "aprovar"
        ? { status_cadastro: "aprovado", ativo: true }
        : { status_cadastro: "reprovado", ativo: false };
      const { error } = await supabase.from("clientes").update(patch).eq("id", row.id);
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast(action === "aprovar" ? `${row.nome} aprovado — já pode ser selecionado nas vendas.` : `${row.nome} reprovado.`);
      reload();
    },
  });

  actionsEl.insertAdjacentHTML("afterbegin", `<button type="button" class="btn btn--ghost" id="btn-copy-precadastro">Copiar link de pré-cadastro</button>`);
  actionsEl.querySelector("#btn-copy-precadastro").addEventListener("click", async () => {
    const basePath = window.location.pathname.replace(/[^/]*$/, "");
    let query = "";
    const empresaId = getCurrentEmpresaId();
    if (empresaId) {
      const { data: empresa, error } = await supabase.from("empresas").select("codigo").eq("id", empresaId).maybeSingle();
      if (error) showToast(friendlyPgError(error), "error");
      if (empresa?.codigo) query = `?empresa=${encodeURIComponent(empresa.codigo)}`;
    }
    const url = `${window.location.origin}${basePath}pre-cadastro.html${query}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link de pré-cadastro copiado.");
    } catch {
      showToast(`Link: ${url}`);
    }
  });
}

// ── Histórico do cliente (Roadmap Fase 2) ───────────────────────────────
async function abrirHistorico(row) {
  const body = openModal(`Histórico — ${row.nome}`);
  body.innerHTML = `<div class="empty-state">Carregando histórico…</div>`;

  const [vendasRes, matriculasRes, propostasRes, agendamentosRes] = await Promise.all([
    supabase.from("vendas").select("id, numero, data_venda, status, total").eq("cliente_id", row.id).order("data_venda", { ascending: false }).limit(100),
    supabase.from("matriculas").select("id, numero, data_matricula, status, valor_total, produto:produtos(nome)").eq("cliente_id", row.id).order("data_matricula", { ascending: false }).limit(100),
    supabase.from("propostas").select("id, numero, data_proposta, status, total").eq("cliente_id", row.id).order("data_proposta", { ascending: false }).limit(100),
    supabase.from("agendamentos").select("id, data_agendamento, horario, status, produto:produtos(nome)").eq("cliente_id", row.id).order("data_agendamento", { ascending: false }).limit(100),
  ]);

  const erro = vendasRes.error || matriculasRes.error || propostasRes.error || agendamentosRes.error;
  if (erro) {
    body.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar o histórico</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(erro))}</p></div>`;
    return;
  }

  const linhas = [
    ...(vendasRes.data || []).map((v) => ({
      data: v.data_venda,
      tipo: "Venda",
      origem: `Venda #${v.numero}`,
      status: VENDA_STATUS_LABEL[v.status] || v.status,
      statusCls: v.status === "cancelada" ? "cancelada" : v.status === "confirmada" ? "confirmada" : "pendente",
      valor: Number(v.total || 0),
    })),
    ...(matriculasRes.data || []).map((m) => ({
      data: m.data_matricula,
      tipo: "Matrícula",
      origem: `Matrícula #${m.numero} · ${m.produto?.nome || "—"}`,
      status: MATRICULA_STATUS_LABEL[m.status] || m.status,
      statusCls: m.status === "cancelada" ? "cancelada" : m.status === "ativa" ? "confirmada" : "pendente",
      valor: Number(m.valor_total || 0),
    })),
    ...(propostasRes.data || []).map((p) => ({
      data: p.data_proposta,
      tipo: "Proposta (CRM)",
      origem: `Proposta #${p.numero}`,
      status: PROPOSTA_STATUS_LABEL[p.status] || p.status,
      statusCls: p.status === "aprovada" ? "confirmada" : p.status === "reprovada" ? "cancelada" : "pendente",
      valor: Number(p.total || 0),
    })),
    ...(agendamentosRes.data || []).map((a) => ({
      data: a.data_agendamento,
      tipo: "Agenda",
      origem: `${a.produto?.nome || "Atendimento"} · ${(a.horario || "").slice(0, 5)}`,
      status: AGENDAMENTO_STATUS_LABEL[a.status] || a.status,
      statusCls: a.status === "atendido" ? "confirmada" : "pendente",
      valor: null,
    })),
  ].sort((a, b) => new Date(b.data) - new Date(a.data));

  const totalMovimentado = (vendasRes.data || []).filter((v) => v.status === "confirmada").reduce((s, v) => s + Number(v.total || 0), 0)
    + (matriculasRes.data || []).filter((m) => m.status !== "cancelada").reduce((s, m) => s + Number(m.valor_total || 0), 0);

  body.innerHTML = linhas.length === 0
    ? `<div class="empty-state">Nenhuma venda, matrícula, proposta ou agendamento para este cliente ainda.</div>`
    : `
    <p class="record-count" style="margin: 0 0 1rem;">${linhas.length} registro${linhas.length === 1 ? "" : "s"} · total em vendas e matrículas não canceladas: ${formatCurrency(totalMovimentado)}</p>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Data</th><th>Tipo</th><th>Origem</th><th>Status</th><th style="text-align:right">Valor</th></tr></thead>
        <tbody>
          ${linhas.map((l) => `
            <tr>
              <td>${formatDate(l.data)}</td>
              <td>${escapeHtml(l.tipo)}</td>
              <td>${escapeHtml(l.origem)}</td>
              <td><span class="status status--${l.statusCls}">${escapeHtml(l.status)}</span></td>
              <td class="cell-num">${l.valor != null ? formatCurrency(l.valor) : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}
