// Página pública de agendamento — sem login, sem app-shell. Roda isolada de
// app.js/auth.js de propósito, mesmo racional de pre-cadastro.js: é uma
// tela pensada para ser aberta por alguém que não é da equipe. Segunda via
// de marcar um atendimento na Agenda (a primeira é um funcionário criando
// direto na tela interna) — só agenda serviço (curso/mensalidade), nunca
// produto físico, ver migration 0022.

import { supabase } from "./supabaseClient.js";

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// Mesmo racional de friendlyRpcError em pre-cadastro.js: as próprias RPCs
// (agenda_publica_info/agendar_publico) já levantam mensagens em português
// (SQLSTATE P0001) — exibidas como estão. Qualquer outro erro (rede, coluna,
// RLS) não deve vazar a mensagem técnica crua do Postgres pra quem está
// preenchendo um formulário público.
function friendlyRpcError(error) {
  if (!error) return "Ocorreu um erro inesperado.";
  if (error.code === "P0001") return error.message;
  return "Não foi possível concluir. Tente novamente em instantes.";
}

function formatCurrencyBRL(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString("pt-BR");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const loadingEl = document.getElementById("ap-loading");
const indisponivelEl = document.getElementById("ap-indisponivel");
const form = document.getElementById("ap-form");
const errorEl = document.getElementById("ap-error");
const successEl = document.getElementById("ap-success");
const submitBtn = document.getElementById("ap-submit");
const brandMarkEl = document.getElementById("ap-brand-mark");
const brandNameEl = document.getElementById("ap-brand-name");
const hintEl = document.getElementById("ap-hint");

const servicoSelect = document.getElementById("ap-servico");
const dataInput = document.getElementById("ap-data");
const horarioSelect = document.getElementById("ap-horario");

dataInput.min = todayKey();
dataInput.value = todayKey();

let empresaId = null;
let horariosPermitidos = [];

function mostrarIndisponivel(mensagem) {
  loadingEl.hidden = true;
  indisponivelEl.hidden = false;
  indisponivelEl.textContent = mensagem;
}

async function carregarInfo() {
  const empresaCodigo = new URLSearchParams(window.location.search).get("empresa");
  const { data, error } = await supabase.rpc("agenda_publica_info", { p_empresa_codigo: empresaCodigo });

  if (error) {
    mostrarIndisponivel(friendlyRpcError(error));
    return;
  }

  const info = Array.isArray(data) ? data[0] : data;
  if (!info) {
    mostrarIndisponivel("Não foi possível carregar as informações de agendamento.");
    return;
  }

  const servicos = info.servicos || [];
  if (servicos.length === 0) {
    mostrarIndisponivel("Nenhum serviço disponível para agendamento no momento. Fale com a nossa equipe.");
    return;
  }

  empresaId = info.empresa_id;
  horariosPermitidos = info.horarios_agenda || [];

  document.title = `Agendar aula · ${info.nome_exibicao}`;
  brandNameEl.textContent = info.nome_exibicao;
  brandMarkEl.textContent = String(info.nome_exibicao || "BC").replace(/\s+/g, "").slice(0, 2).toUpperCase() || "BC";
  hintEl.textContent = `Escolha o serviço, a data e o horário na ${info.nome_exibicao}, e preencha seus dados para confirmar.`;

  servicoSelect.innerHTML = servicos
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nome)} — ${escapeHtml(formatCurrencyBRL(s.preco))}</option>`)
    .join("");

  loadingEl.hidden = true;
  form.hidden = false;

  await atualizarHorarios();
}

async function atualizarHorarios() {
  if (!dataInput.value || !empresaId) return;

  horarioSelect.disabled = true;
  horarioSelect.innerHTML = `<option value="">Carregando horários…</option>`;

  const { data: ocupadosData, error } = await supabase.rpc("horarios_ocupados_publico", {
    p_empresa_id: empresaId,
    p_data: dataInput.value,
  });

  if (error) {
    horarioSelect.innerHTML = `<option value="">Não foi possível carregar os horários</option>`;
    return;
  }

  const ocupados = new Set(ocupadosData || []);
  const ehHoje = dataInput.value === todayKey();
  const agora = nowHHMM();

  const disponiveis = horariosPermitidos.filter((h) => !ocupados.has(h) && (!ehHoje || h > agora));

  if (disponiveis.length === 0) {
    horarioSelect.innerHTML = `<option value="">Nenhum horário disponível nesta data</option>`;
    horarioSelect.disabled = true;
    return;
  }

  horarioSelect.innerHTML = disponiveis.map((h) => `<option value="${h}">${h}</option>`).join("");
  horarioSelect.disabled = false;
}

dataInput.addEventListener("change", atualizarHorarios);

// Mesma mitigação de spam de pre-cadastro.js: campo-armadilha (só um bot
// preenche) + tempo mínimo entre a página carregar e o envio.
const formLoadedAt = Date.now();
const MIN_SUBMIT_MS = 2500;

function pareceBot() {
  return Boolean(document.getElementById("ap-website").value) || Date.now() - formLoadedAt < MIN_SUBMIT_MS;
}

function mostrarSucesso({ nome, data, horario, servicoNome }) {
  form.hidden = true;
  successEl.hidden = false;
  successEl.innerHTML = `
    <div class="precadastro-success">
      <div class="precadastro-success__icon">
        <svg aria-hidden="true" focusable="false" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <p class="precadastro-success__title">Agendamento confirmado, ${escapeHtml(nome)}!</p>
      <p class="precadastro-success__hint">${escapeHtml(servicoNome)} em ${escapeHtml(formatDateBR(data))} às ${escapeHtml(horario.slice(0, 5))}. Te esperamos!</p>
    </div>
  `;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.innerHTML = "";

  const servicoId = servicoSelect.value;
  const servicoNome = servicoSelect.options[servicoSelect.selectedIndex]?.textContent || "seu serviço";
  const horario = horarioSelect.value;

  if (!servicoId) {
    errorEl.innerHTML = `<div class="form-error">Selecione um serviço.</div>`;
    return;
  }
  if (!horario) {
    errorEl.innerHTML = `<div class="form-error">Selecione um horário.</div>`;
    return;
  }

  if (pareceBot()) {
    mostrarSucesso({ nome: document.getElementById("ap-nome").value || "", data: dataInput.value, horario, servicoNome });
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Enviando…";

  const payload = {
    p_empresa_codigo: new URLSearchParams(window.location.search).get("empresa") || null,
    p_nome: document.getElementById("ap-nome").value,
    p_documento: document.getElementById("ap-documento").value,
    p_produto_id: servicoId,
    p_data_agendamento: dataInput.value,
    p_horario: horario,
    p_telefone: document.getElementById("ap-telefone").value || null,
    p_email: document.getElementById("ap-email").value || null,
    p_observacoes: document.getElementById("ap-obs").value || null,
  };

  const { data, error } = await supabase.rpc("agendar_publico", payload);

  if (error) {
    errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyRpcError(error))}</div>`;
    submitBtn.disabled = false;
    submitBtn.textContent = "Confirmar agendamento";
    // Horário pode ter sido ocupado por outra pessoa entre carregar a tela
    // e enviar — atualiza a lista pra não deixar a pessoa tentar de novo o
    // mesmo horário indisponível.
    await atualizarHorarios();
    return;
  }

  const confirmado = Array.isArray(data) ? data[0] : data;
  mostrarSucesso({
    nome: confirmado?.nome || document.getElementById("ap-nome").value || "",
    data: confirmado?.data_agendamento || dataInput.value,
    horario: confirmado?.horario || horario,
    servicoNome,
  });
});

carregarInfo();
