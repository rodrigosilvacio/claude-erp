// ERPConnect — Movimentações > Matrículas: contratação de um curso/serviço
// por um cliente, com parcelamento. Mesma UX de pagamento da Loja (vendas) —
// tiles de forma de pagamento + fluxo Stripe (QR/link) — mas sem carrinho:
// aqui é sempre um cliente + um curso. Ver supabase/migrations/0015 para o
// racional completo de como as parcelas viram títulos a receber.
//
// Pagamento parcelado + Stripe: o Stripe cobra só a 1ª parcela agora (uma
// Checkout Session é cobrança única, não assinatura recorrente); as demais
// nascem como títulos a receber com vencimento futuro e são recebidas
// manualmente no balcão (ver "Registrar pagamento" no detalhe da matrícula).

import { supabase } from "./supabaseClient.js";
import { showToast, openModal, closeModal, confirmDialog, formatCurrency, formatDate, escapeHtml, createSearchSelect, registerAutoRefresh, consumeMatriculaPrefill, setMatriculaPrefill, withButtonLock, friendlyPgError } from "./app.js";
import { isAdmin } from "./auth.js";
import { loadClientesAtivos, loadProdutosServicos, loadEmpresasAtivas, clienteSearchOptions, produtoSearchOptions, empresaSearchOptions, produtoMetaPreco } from "./catalogo.js";
import { FORMAS_PAGAMENTO, paytilesHtml, mountPaytiles, chamarCriarCheckoutStripe, mostrarModalStripe, dispararConfirmacaoNegocio } from "./pagamento.js";

let clientesOptions = [];
let produtosOptions = [];
let empresasOptions = [];
// Id do agendamento que originou a matrícula em andamento (fluxo Agenda →
// Matrículas, via setMatriculaPrefill/consumeMatriculaPrefill em app.js).
// Null numa matrícula avulsa ou numa renovação.
let agendamentoOrigemId = null;
// Id da proposta que originou a matrícula em andamento (fluxo CRM →
// Matrículas, via setMatriculaPrefill/consumeMatriculaPrefill em app.js).
// Null numa matrícula avulsa, renovação ou vinda de agendamento.
let propostaOrigemId = null;
// Referência à função activate(tab) de render() — permite que "Renovar
// matrícula" (chamada de dentro do modal de detalhes, na aba Histórico)
// volte pra aba "Nova matrícula" já com os dados prontos, sem depender de
// mudar o hash da rota (não dispara "hashchange" se já estiver em #/matriculas).
let activateTab = null;

// Inclui `descricao` (não faz parte das colunas padrão de loadProdutosAtivos)
// — é o texto que vira o cartão "Orientações para os pais" abaixo do curso.
const PRODUTO_SERVICO_COLUMNS = "id, nome, sku, preco, estoque, tipo, descricao";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function render(view, actionsEl) {
  actionsEl.innerHTML = "";
  agendamentoOrigemId = null;
  propostaOrigemId = null;

  view.innerHTML = `
    <div class="toolbar" style="margin-bottom: 1.25rem;">
      <div style="display:flex; gap:0.5rem;">
        <button type="button" class="btn btn--primary" id="tab-nova">Nova matrícula</button>
        <button type="button" class="btn btn--ghost" id="tab-historico">Histórico</button>
      </div>
    </div>
    <div id="tab-content"></div>
  `;

  const tabNova = view.querySelector("#tab-nova");
  const tabHistorico = view.querySelector("#tab-historico");
  const content = view.querySelector("#tab-content");

  function activate(tab) {
    tabNova.className = tab === "nova" ? "btn btn--primary" : "btn btn--ghost";
    tabHistorico.className = tab === "historico" ? "btn btn--primary" : "btn btn--ghost";
    if (tab === "nova") renderNovaMatricula(content);
    else renderHistorico(content);
  }

  tabNova.addEventListener("click", () => activate("nova"));
  tabHistorico.addEventListener("click", () => activate("historico"));
  activateTab = activate;

  [clientesOptions, produtosOptions, empresasOptions] = await Promise.all([loadClientesAtivos(), loadProdutosServicos(PRODUTO_SERVICO_COLUMNS), loadEmpresasAtivas()]);

  activate("nova");
}

function renderNovaMatricula(content) {
  const prefill = consumeMatriculaPrefill();
  agendamentoOrigemId = prefill?.agendamentoId || null;
  propostaOrigemId = prefill?.propostaId || null;
  const admin = isAdmin();

  content.innerHTML = `
    ${prefill?.agendamentoId ? `
      <div class="form-info">
        Confirmando atendimento de ${escapeHtml(prefill.clienteNome || "cliente sem cadastro")} em ${formatDate(prefill.dataAgendamento)} às ${prefill.horario}. Revise os dados e finalize para registrar a matrícula.
      </div>
    ` : prefill?.renovacao ? `
      <div class="form-info">
        Renovando a matrícula #${prefill.origemNumero} de ${escapeHtml(prefill.clienteNome || "cliente")}. Cliente, curso, duração, parcelas e forma de pagamento vieram preenchidos — revise e finalize para criar a nova matrícula.
      </div>
    ` : propostaOrigemId ? `
      <div class="form-info">
        Convertendo a proposta #${prefill.propostaNumero} em matrícula${prefill.pendingServicos?.length ? ` (restam ${prefill.pendingServicos.length + 1} itens de serviço desta proposta, um de cada vez)` : ""}. Revise os dados e finalize — a proposta será marcada como convertida.
      </div>
    ` : ""}

    <div class="matricula-layout">
      <div class="matricula-steps">
        <div class="card step-card">
          <div class="step-head">
            <span class="step-num">1</span>
            <h3 class="step-title">Aluno</h3>
          </div>
          <div class="step-body">
            ${admin ? `
              <div class="field">
                <label>Empresa<span class="field-required">*</span></label>
                <div data-mount="m-empresa"></div>
              </div>
            ` : ""}
            <div class="venda-meta">
              <div class="field" style="flex: 1 1 auto; min-width: 0;">
                <label>Cliente<span class="field-required">*</span></label>
                <div data-mount="m-cliente"></div>
              </div>
              <div class="field venda-meta__data">
                <label for="m-data">Data da matrícula</label>
                <input class="input" type="date" id="m-data" value="${todayStr()}" />
              </div>
            </div>
            <div class="info-card" id="m-aluno-info" hidden></div>
          </div>
        </div>

        <div class="card step-card">
          <div class="step-head">
            <span class="step-num">2</span>
            <h3 class="step-title">Curso</h3>
          </div>
          <div class="step-body">
            <div class="field">
              <label>Curso / Serviço<span class="field-required">*</span></label>
              <div data-mount="m-produto"></div>
            </div>
            <div class="info-card info-card--curso" id="m-curso-info" hidden></div>

            <div class="form-grid">
              <div class="field">
                <label for="m-meses">Duração do curso (meses) <span class="field-optional">informativo</span></label>
                <input class="input" type="number" id="m-meses" min="1" step="1" value="1" />
              </div>
              <div class="field">
                <label for="m-parcelas">Número de parcelas<span class="field-required">*</span></label>
                <input class="input" type="number" id="m-parcelas" min="1" step="1" value="1" />
              </div>
            </div>
            <p class="field-hint">A duração não afeta o valor cobrado — é só um registro de quanto tempo dura o curso. Quem define o valor é o preço do curso/serviço escolhido acima, dividido entre as parcelas. A 1ª parcela é paga agora, na forma de pagamento escolhida ao lado; as demais viram títulos a receber com vencimento mensal, cobrados no balcão conforme o aluno for pagando.</p>

            <button type="button" class="venda-obs-toggle" id="m-obs-toggle">+ Adicionar observação</button>
            <div class="field venda-obs" id="m-obs-field" hidden>
              <label for="m-obs">Observações</label>
              <textarea class="input" id="m-obs" rows="2"></textarea>
            </div>
          </div>
        </div>
      </div>

      <div class="card enroll-summary">
        <div class="step-head">
          <span class="step-num">3</span>
          <h3 class="step-title">Pagamento</h3>
        </div>

        <p class="enroll-summary__label">Forma de pagamento</p>
        <div class="paytiles" id="m-forma" role="radiogroup" aria-label="Forma de pagamento">
          ${paytilesHtml()}
        </div>

        <div class="enroll-summary__lines">
          <div class="enroll-summary__row"><span>Valor do curso/serviço</span><span id="r-mensalidade">${formatCurrency(0)}</span></div>
          <p class="field-hint" id="r-mensalidade-hint" ${prefill?.precoUnitario != null ? "" : "hidden"} style="margin: -0.4rem 0 0.4rem;">Preço negociado na proposta de origem — diferente do preço de catálogo do curso.</p>
          <div class="enroll-summary__row enroll-summary__row--input">
            <span>Desconto</span>
            <input class="input enroll-summary__discount" type="number" id="m-desconto" min="0" step="0.01" value="${prefill?.desconto || 0}" />
          </div>
          <div class="enroll-summary__row"><span>Total contratado</span><span id="r-total">${formatCurrency(0)}</span></div>
        </div>

        <div class="enroll-summary__due">
          <span class="enroll-summary__due-label">Cobrado agora — 1ª parcela</span>
          <span class="enroll-summary__due-value" id="r-cobrar-agora">${formatCurrency(0)}</span>
          <span class="enroll-summary__due-hint" id="r-parcelas-info"></span>
        </div>

        <button type="button" class="btn btn--primary" id="m-finalizar" style="width:100%; justify-content:center;">Finalizar matrícula</button>
        <div id="m-error"></div>
      </div>
    </div>
  `;

  const paytiles = mountPaytiles(content.querySelector("#m-forma"), prefill?.renovacao ? prefill.formaPagamento : undefined);
  const descontoInput = content.querySelector("#m-desconto");
  const mesesInput = content.querySelector("#m-meses");
  const parcelasInput = content.querySelector("#m-parcelas");

  if (prefill?.renovacao) {
    if (prefill.meses) mesesInput.value = prefill.meses;
    if (prefill.numeroParcelas) parcelasInput.value = prefill.numeroParcelas;
  }

  const obsToggle = content.querySelector("#m-obs-toggle");
  const obsField = content.querySelector("#m-obs-field");
  const obsInput = content.querySelector("#m-obs");
  obsToggle.addEventListener("click", () => {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.focus();
  });

  if (prefill?.agendamentoId) {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.value = `Matrícula referente ao atendimento agendado em ${formatDate(prefill.dataAgendamento)} às ${prefill.horario}.${prefill.observacoes ? ` Obs. do agendamento: ${prefill.observacoes}` : ""}`;
  } else if (prefill?.renovacao) {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.value = `Renovação da matrícula #${prefill.origemNumero}.`;
  } else if (propostaOrigemId) {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.value = prefill.observacoes || `Convertida da proposta #${prefill.propostaNumero}.`;
  }

  const empresaSelect = admin
    ? createSearchSelect({
        container: content.querySelector('[data-mount="m-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: prefill?.empresaId || null,
        allowClear: false,
      })
    : null;

  const clienteSelect = createSearchSelect({
    container: content.querySelector('[data-mount="m-cliente"]'),
    placeholder: "Buscar cliente por nome ou documento…",
    options: clienteSearchOptions(clientesOptions),
    value: prefill?.clienteId || null,
    allowClear: false,
    onChange: () => updateAlunoInfo(),
  });

  // Preço negociado numa proposta do CRM — substitui o preço de catálogo do
  // curso enquanto o produto selecionado continuar sendo o da proposta.
  // Trocar o curso manualmente invalida o valor negociado (era o preço de UM
  // produto específico, não vale pra outro) — por isso onChange abaixo
  // sempre zera, mesmo quando o novo valor é o mesmo id de novo.
  let precoOverride = prefill?.precoUnitario != null ? Number(prefill.precoUnitario) : null;

  const produtoSelect = createSearchSelect({
    container: content.querySelector('[data-mount="m-produto"]'),
    placeholder: "Buscar curso/serviço por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPreco }),
    value: prefill?.produtoId || null,
    allowClear: false,
    onChange: () => {
      precoOverride = null;
      updateTotals();
      updateCursoInfo();
    },
  });

  // Cartão "Aluno": telefone/e-mail/documento à mão (o combo de busca só
  // guarda o id internamente) e aviso se o cliente já tem outra matrícula
  // ativa — hoje isso era invisível pro atendente, que só descobria
  // duplicidade no Histórico.
  async function updateAlunoInfo() {
    const el = content.querySelector("#m-aluno-info");
    if (!el) return;
    const clienteId = clienteSelect.getValue();
    if (!clienteId) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }

    const cliente = clientesOptions.find((c) => c.id === clienteId);
    el.hidden = false;
    el.innerHTML = `
      <p class="info-card__title">Aluno</p>
      <div class="info-card__row"><span>Telefone</span><span>${escapeHtml(cliente?.telefone || "—")}</span></div>
      <div class="info-card__row"><span>E-mail</span><span>${escapeHtml(cliente?.email || "—")}</span></div>
      <div class="info-card__row"><span>Documento</span><span>${escapeHtml(cliente?.documento || "—")}</span></div>
      <p class="info-card__hint">Verificando matrículas ativas…</p>
    `;

    const { data, error } = await supabase
      .from("matriculas")
      .select("numero, produto:produtos(nome)")
      .eq("cliente_id", clienteId)
      .eq("status", "ativa")
      .order("numero", { ascending: false });

    // Se o cliente selecionado mudou enquanto a consulta rodava, o
    // innerHTML de cima já foi substituído por uma chamada mais recente —
    // este hintEl aponta pra um nó desanexado e escrever nele é inofensivo.
    const hintEl = el.querySelector(".info-card__hint");
    if (!hintEl) return;
    if (error) {
      hintEl.hidden = true;
      return;
    }
    if (!data || data.length === 0) {
      hintEl.textContent = "Sem outras matrículas ativas.";
      return;
    }
    hintEl.classList.add("info-card__hint--alert");
    hintEl.textContent = `Já matriculado(a) em: ${data.map((m) => m.produto?.nome || `curso #${m.numero}`).join(", ")}.`;
  }

  // Cartão "Orientações para os pais": mostra a `descricao` do curso — o
  // mesmo texto cadastrado em Cadastros > Produtos, aqui em destaque pra
  // quem está atendendo o balcão repetir sem precisar decorar.
  function updateCursoInfo() {
    const el = content.querySelector("#m-curso-info");
    if (!el) return;
    const produto = produtosOptions.find((p) => p.id === produtoSelect.getValue());
    if (!produto) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const descricao = (produto.descricao || "").trim();
    el.hidden = false;
    el.innerHTML = `
      <p class="info-card__title">Orientações para os pais</p>
      ${descricao
        ? `<p class="info-card__text">${escapeHtml(descricao)}</p>`
        : `<p class="info-card__text info-card__text--muted">Nenhuma orientação cadastrada para este curso — adicione em Cadastros → Produtos.</p>`}
    `;
  }

  if (prefill?.produtoId && !produtosOptions.some((p) => p.id === prefill.produtoId)) {
    showToast("Curso/serviço do atendimento não encontrado no catálogo de Matrículas.", "error");
  }

  // Duração (meses) é só um campo informativo — não entra nesta conta.
  // Quem define o valor é o preço do produto (curso/serviço) — ou o preço
  // negociado na proposta de origem, se houver (precoOverride) —, ver
  // criar_matricula.
  function updateTotals() {
    const produto = produtosOptions.find((p) => p.id === produtoSelect.getValue());
    const valorServico = precoOverride != null ? precoOverride : (produto ? Number(produto.preco || 0) : 0);
    const hintEl = content.querySelector("#r-mensalidade-hint");
    if (hintEl) hintEl.hidden = precoOverride == null;
    const parcelas = Math.max(Number(parcelasInput.value || 0), 1);
    const desconto = Number(descontoInput.value || 0);
    const total = Math.max(valorServico - desconto, 0);
    const valorParcela = total / parcelas;

    content.querySelector("#r-mensalidade").textContent = formatCurrency(valorServico);
    content.querySelector("#r-total").textContent = formatCurrency(total);
    content.querySelector("#r-cobrar-agora").textContent = formatCurrency(valorParcela);
    // Cálculo em tela é aproximado (só pra guiar o operador) — o servidor
    // recalcula com arredondamento exato e ajusta a última parcela, ver
    // criar_matricula.
    content.querySelector("#r-parcelas-info").textContent = parcelas > 1
      ? `+ ${parcelas - 1} parcela${parcelas - 1 > 1 ? "s" : ""} mensa${parcelas - 1 > 1 ? "is" : "l"} de ${formatCurrency(valorParcela)} (aprox.)`
      : "Pagamento único — sem parcelas futuras.";
  }

  parcelasInput.addEventListener("input", updateTotals);
  descontoInput.addEventListener("input", updateTotals);
  updateTotals();
  updateAlunoInfo();
  updateCursoInfo();

  content.querySelector("#m-finalizar").addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
    const errorEl = content.querySelector("#m-error");
    errorEl.innerHTML = "";

    const clienteId = clienteSelect.getValue();
    if (!clienteId) {
      errorEl.innerHTML = `<div class="form-error">Selecione um cliente.</div>`;
      return;
    }

    const produtoId = produtoSelect.getValue();
    if (!produtoId) {
      errorEl.innerHTML = `<div class="form-error">Selecione um curso/serviço.</div>`;
      return;
    }

    const meses = Number(mesesInput.value || 0);
    if (meses <= 0) {
      errorEl.innerHTML = `<div class="form-error">Informe a duração do curso em meses.</div>`;
      return;
    }

    const parcelas = Number(parcelasInput.value || 0);
    if (parcelas <= 0) {
      errorEl.innerHTML = `<div class="form-error">Informe o número de parcelas.</div>`;
      return;
    }

    if (admin && !empresaSelect.getValue()) {
      errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
      return;
    }

    const payload = {
      p_cliente_id: clienteId,
      p_produto_id: produtoId,
      p_meses: meses,
      p_numero_parcelas: parcelas,
      p_data_matricula: content.querySelector("#m-data").value || null,
      p_desconto: Number(descontoInput.value || 0),
      p_observacoes: content.querySelector("#m-obs").value || null,
    };
    if (admin) payload.p_empresa_id = empresaSelect.getValue();
    // Preço negociado na proposta de origem (se houver) — criar_matricula
    // resolve o valor sozinha a partir do id da proposta; precoOverride
    // aqui é só o que aparece na tela (r-mensalidade-hint), nunca o que é
    // cobrado.
    if (propostaOrigemId) payload.p_proposta_id = propostaOrigemId;

    const formaPagamento = paytiles.getValue();

    if (formaPagamento === "Stripe") {
      await iniciarPagamentoStripe(payload, errorEl);
      return;
    }

    const { data: novaMatriculaId, error } = await supabase.rpc("criar_matricula", { ...payload, p_forma_pagamento: formaPagamento });

    if (error) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
      return;
    }

    await finalizarComSucesso(novaMatriculaId);
  }));

  // `prefill` (closure de renderNovaMatricula) segue disponível aqui — é de
  // onde vem a fila de itens de serviço pendentes (pendingServicos) quando a
  // origem é uma proposta do CRM com mais de um serviço.
  async function finalizarComSucesso(matriculaId, mensagemBase = "Matrícula registrada com sucesso.") {
    dispararConfirmacaoNegocio("matricula", matriculaId);

    if (agendamentoOrigemId) {
      const { error: agError } = await supabase.from("agendamentos").update({ status: "atendido" }).eq("id", agendamentoOrigemId);
      showToast(agError ? "Matrícula registrada, mas não foi possível confirmar o atendimento na agenda." : "Matrícula registrada e atendimento confirmado.", agError ? "error" : "success");
    } else if (propostaOrigemId) {
      // Só marca a proposta como convertida DEPOIS da matrícula existir de
      // fato — nunca antes (mesmo racional do fluxo CRM → Vendas em
      // vendas.js). Sobrescreve matricula_id a cada matrícula desta mesma
      // proposta (pode gerar mais de uma, se houver mais de um curso na
      // proposta) — a última criada é a que fica vinculada; as anteriores
      // continuam rastreáveis pelo texto "Convertida da proposta #N" que
      // cada uma leva nas observações.
      const { error: propError } = await supabase
        .from("propostas")
        .update({ matricula_id: matriculaId, convertida_em: new Date().toISOString() })
        .eq("id", propostaOrigemId);

      const proximo = prefill?.pendingServicos?.[0];
      if (!propError && proximo) {
        const resto = prefill.pendingServicos.slice(1);
        setMatriculaPrefill({
          propostaId: prefill.propostaId,
          propostaNumero: prefill.propostaNumero,
          clienteId: prefill.clienteId,
          clienteNome: prefill.clienteNome,
          empresaId: prefill.empresaId,
          produtoId: proximo.produto_id,
          precoUnitario: proximo.preco_unitario,
          // O desconto da proposta já foi aplicado nesta 1ª matrícula — as
          // seguintes da mesma fila não descontam de novo.
          desconto: 0,
          observacoes: prefill.observacoes,
          pendingServicos: resto,
        });
        showToast("Matrícula registrada. Continue com o próximo item de serviço da mesma proposta.");
        agendamentoOrigemId = null;
        propostaOrigemId = null;
        produtosOptions = await loadProdutosServicos(PRODUTO_SERVICO_COLUMNS);
        renderNovaMatricula(content);
        return;
      }

      showToast(propError ? "Matrícula registrada, mas não foi possível marcar a proposta como convertida." : "Matrícula registrada e proposta marcada como convertida.", propError ? "error" : "success");
    } else {
      showToast(mensagemBase);
    }

    agendamentoOrigemId = null;
    propostaOrigemId = null;
    produtosOptions = await loadProdutosServicos(PRODUTO_SERVICO_COLUMNS);
    renderNovaMatricula(content);
  }

  async function iniciarPagamentoStripe(payload, errorEl) {
    // Base do próprio index.html do appvendas (funciona local ou em qualquer
    // domínio de deploy) — as páginas de retorno vivem ao lado dele.
    const baseUrl = new URL(".", window.location.href).href;

    let data;
    try {
      data = await chamarCriarCheckoutStripe({
        ...payload,
        p_tipo: "matricula",
        success_url: `${baseUrl}pagamento-confirmado.html`,
        cancel_url: `${baseUrl}pagamento-cancelado.html`,
      });
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
      return;
    }

    await mostrarModalStripe({
      title: `Pagamento via Stripe — Matrícula #${data.numero}`,
      id: data.matricula_id,
      table: "matriculas",
      successStatus: "ativa",
      checkoutUrl: data.url,
      onConfirmada: () => finalizarComSucesso(data.matricula_id, "Pagamento confirmado. Matrícula registrada."),
    });
  }

  // Atualiza silenciosamente os catálogos de cliente/curso (novos cadastros)
  // sem perder o que já foi preenchido no formulário nem fechar os campos
  // de busca.
  registerAutoRefresh(async () => {
    const [nextClientes, nextProdutos] = await Promise.all([loadClientesAtivos(), loadProdutosServicos(PRODUTO_SERVICO_COLUMNS)]);
    clientesOptions = nextClientes;
    produtosOptions = nextProdutos;
    clienteSelect.setOptions(clienteSearchOptions(clientesOptions));
    produtoSelect.setOptions(produtoSearchOptions(produtosOptions, { meta: produtoMetaPreco }));
  }, 15000);
}

const HISTORICO_PAGE_SIZE = 50;

async function renderHistorico(content) {
  content.innerHTML = `<div class="card"><div class="table-wrap" id="matriculas-table">${'<div class="empty-state">Carregando…</div>'}</div></div><div id="matriculas-pagination"></div>`;

  const state = { page: 0 };
  await loadHistorico(content, state);

  registerAutoRefresh(() => loadHistorico(content, state, { silent: true }), 15000);
}

async function loadHistorico(content, state, opts = {}) {
  const { silent = false } = opts;
  const tableWrap = content.querySelector("#matriculas-table");
  if (!silent) tableWrap.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const from = state.page * HISTORICO_PAGE_SIZE;
  const { data, error, count } = await supabase
    .from("matriculas")
    .select("id, numero, data_matricula, status, valor_total, meses, numero_parcelas, forma_pagamento, cliente:clientes(nome), produto:produtos(nome)", { count: "exact" })
    .order("numero", { ascending: false })
    .range(from, from + HISTORICO_PAGE_SIZE - 1);

  if (error) {
    tableWrap.innerHTML = `<div class="empty-state"><p class="empty-state__title">Erro ao carregar</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(error))}</p></div>`;
    return;
  }

  if ((!data || data.length === 0) && state.page > 0 && count > 0) {
    state.page = Math.max(0, Math.ceil(count / HISTORICO_PAGE_SIZE) - 1);
    return loadHistorico(content, state, opts);
  }

  if (!data || data.length === 0) {
    tableWrap.innerHTML = `<div class="empty-state"><p class="empty-state__title">Nenhuma matrícula registrada ainda</p></div>`;
    content.querySelector("#matriculas-pagination").innerHTML = "";
    return;
  }

  tableWrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Curso</th><th>Parcelas</th><th style="text-align:right">Valor total</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        ${data.map((m) => `
          <tr>
            <td class="cell-num">#${m.numero}</td>
            <td>${formatDate(m.data_matricula)}</td>
            <td>${escapeHtml(m.cliente?.nome || "—")}</td>
            <td>${escapeHtml(m.produto?.nome || "—")}</td>
            <td class="cell-num">${m.numero_parcelas}x</td>
            <td class="cell-num">${formatCurrency(m.valor_total)}</td>
            <td><span class="status status--${matriculaStatusClass(m.status)}">${matriculaStatusLabel(m.status)}</span></td>
            <td class="cell-actions">
              <button type="button" class="btn btn--ghost btn--sm" data-detail="${m.id}">Detalhes</button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", () => showDetail(btn.dataset.detail, () => loadHistorico(content, state, { silent: true })));
  });

  renderHistoricoPagination(content, state, count);
}

function renderHistoricoPagination(content, state, count) {
  const el = content.querySelector("#matriculas-pagination");
  const totalPages = Math.max(1, Math.ceil(count / HISTORICO_PAGE_SIZE));

  if (totalPages <= 1) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <div class="pagination">
      <button type="button" class="btn btn--ghost btn--sm" id="matriculas-page-prev" ${state.page === 0 ? "disabled" : ""}>‹ Anterior</button>
      <span class="pagination__label">Página ${state.page + 1} de ${totalPages}</span>
      <button type="button" class="btn btn--ghost btn--sm" id="matriculas-page-next" ${state.page >= totalPages - 1 ? "disabled" : ""}>Próxima ›</button>
    </div>
  `;

  el.querySelector("#matriculas-page-prev").addEventListener("click", () => {
    state.page = Math.max(0, state.page - 1);
    loadHistorico(content, state);
  });
  el.querySelector("#matriculas-page-next").addEventListener("click", () => {
    state.page += 1;
    loadHistorico(content, state);
  });
}

function matriculaStatusClass(status) {
  return { ativa: "confirmada", cancelada: "cancelada", aguardando_pagamento: "aguardando_pagamento" }[status] || status;
}

function matriculaStatusLabel(status) {
  return { ativa: "Ativa", cancelada: "Cancelada", aguardando_pagamento: "Aguardando pagamento" }[status] || status;
}

function parcelaStatusClass(status) {
  return { pago: "confirmada", cancelado: "cancelada", pendente: "pendente" }[status] || status;
}

function parcelaStatusLabel(status) {
  return { pago: "Pago", cancelado: "Cancelado", pendente: "Pendente" }[status] || status;
}

// ── Detalhe da matrícula: dados + parcelas (títulos a receber), com ação de
// registrar pagamento por parcela e cancelar a matrícula inteira.
async function showDetail(matriculaId, onChange) {
  const body = openModal("Detalhes da matrícula");
  body.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const [{ data: matricula, error: matriculaError }, { data: parcelasData }, { data: propostaOrigem }, { data: agendamentosData }] = await Promise.all([
    supabase.from("matriculas").select("*, cliente:clientes(nome), produto:produtos(nome), usuario:usuarios(nome)").eq("id", matriculaId).single(),
    supabase.from("matricula_parcelas").select("*").eq("matricula_id", matriculaId).order("numero_parcela", { ascending: true }),
    supabase.from("propostas").select("numero").eq("matricula_id", matriculaId).maybeSingle(),
    supabase.from("agendamentos").select("id, data_agendamento, horario, status").eq("matricula_id", matriculaId).order("data_agendamento", { ascending: false }).limit(10),
  ]);

  if (!matricula) {
    body.innerHTML = matriculaError
      ? `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar a matrícula</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(matriculaError))}</p></div>`
      : `<div class="empty-state">Matrícula não encontrada.</div>`;
    return;
  }

  const parcelas = parcelasData || [];
  const agendamentos = agendamentosData || [];

  function renderBody() {
    body.innerHTML = `
      <div class="receipt" style="padding: 0;">
        <div class="receipt__row"><span>Nº da matrícula</span><span>#${matricula.numero}</span></div>
        ${propostaOrigem ? `<div class="receipt__row"><span>Origem</span><span>Proposta #${propostaOrigem.numero} (CRM)</span></div>` : ""}
        <div class="receipt__row"><span>Data</span><span>${formatDate(matricula.data_matricula)}</span></div>
        <div class="receipt__row"><span>Cliente</span><span>${escapeHtml(matricula.cliente?.nome || "—")}</span></div>
        <div class="receipt__row"><span>Curso</span><span>${escapeHtml(matricula.produto?.nome || "—")}</span></div>
        <div class="receipt__row"><span>Vendedor</span><span>${escapeHtml(matricula.usuario?.nome || "—")}</span></div>
        <div class="receipt__row"><span>Duração <span class="cell-muted">(informativo)</span></span><span>${matricula.meses} ${matricula.meses === 1 ? "mês" : "meses"}</span></div>
        <div class="receipt__row"><span>Status</span><span class="status status--${matriculaStatusClass(matricula.status)}">${matriculaStatusLabel(matricula.status)}</span></div>
        ${matricula.observacoes ? `<div class="receipt__row"><span>Obs.</span><span>${escapeHtml(matricula.observacoes)}</span></div>` : ""}
        <div class="receipt__tear"></div>
        <div class="receipt__row"><span>Valor do curso/serviço</span><span>${formatCurrency(matricula.valor_servico)}</span></div>
        <div class="receipt__row"><span>Desconto</span><span>${formatCurrency(matricula.desconto)}</span></div>
        <div class="receipt__total"><span>Total</span><span>${formatCurrency(matricula.valor_total)}</span></div>
      </div>

      <p class="section-title" style="margin-top: 1.25rem;">Parcelas (títulos a receber)</p>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr><th>Parcela</th><th>Vencimento</th><th style="text-align:right">Valor</th><th>Pagamento</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            ${parcelas.map((p) => `
              <tr>
                <td>${p.numero_parcela}/${matricula.numero_parcelas}</td>
                <td>${formatDate(p.data_vencimento)}</td>
                <td class="cell-num">${formatCurrency(p.valor)}</td>
                <td class="cell-muted">${escapeHtml(p.forma_pagamento || "—")}</td>
                <td><span class="status status--${parcelaStatusClass(p.status)}">${parcelaStatusLabel(p.status)}</span></td>
                <td class="cell-actions">
                  ${p.status === "pendente" && matricula.status === "ativa" ? `<button type="button" class="btn btn--primary btn--sm" data-pagar="${p.id}">Registrar pagamento</button>` : ""}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      ${agendamentos.length > 0 ? `
        <p class="section-title" style="margin-top: 1.25rem;">Aulas/atendimentos agendados</p>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Data</th><th>Horário</th><th>Status</th></tr></thead>
            <tbody>
              ${agendamentos.map((a) => `
                <tr>
                  <td>${formatDate(a.data_agendamento)}</td>
                  <td>${escapeHtml((a.horario || "").slice(0, 5))}</td>
                  <td><span class="status status--${a.status === "atendido" ? "ativo" : "pendente"}">${a.status === "atendido" ? "Atendido" : "Agendado"}</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : ""}

      ${matricula.status !== "aguardando_pagamento" ? `
        <div class="form-actions">
          <button type="button" class="btn btn--ghost" id="md-renovar">Renovar matrícula</button>
          ${matricula.status !== "cancelada" ? `<button type="button" class="btn btn--danger" id="md-cancelar">Cancelar matrícula</button>` : ""}
        </div>
      ` : ""}
    `;

    const renovarBtn = body.querySelector("#md-renovar");
    if (renovarBtn) {
      renovarBtn.addEventListener("click", () => {
        setMatriculaPrefill({
          renovacao: true,
          origemNumero: matricula.numero,
          clienteId: matricula.cliente_id,
          clienteNome: matricula.cliente?.nome || null,
          produtoId: matricula.produto_id,
          meses: matricula.meses,
          numeroParcelas: matricula.numero_parcelas,
          formaPagamento: matricula.forma_pagamento,
        });
        closeModal();
        if (activateTab) activateTab("nova");
      });
    }

    body.querySelectorAll("[data-pagar]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openPagamentoParcelaForm(btn.dataset.pagar, async () => {
          const { data: novasParcelas, error } = await supabase
            .from("matricula_parcelas")
            .select("*")
            .eq("matricula_id", matriculaId)
            .order("numero_parcela", { ascending: true });
          if (error) showToast(friendlyPgError(error), "error");
          parcelas.length = 0;
          parcelas.push(...(novasParcelas || []));
          renderBody();
          if (onChange) onChange();
        });
      });
    });

    const cancelarBtn = body.querySelector("#md-cancelar");
    if (cancelarBtn) {
      cancelarBtn.addEventListener("click", async () => {
        const ok = await confirmDialog("Cancelar esta matrícula? As parcelas ainda pendentes serão canceladas — as já pagas ficam registradas.", { confirmLabel: "Cancelar matrícula" });
        if (!ok) return;
        const { error } = await supabase.rpc("cancelar_matricula", { p_matricula_id: matriculaId });
        if (error) {
          showToast(friendlyPgError(error), "error");
          return;
        }
        showToast("Matrícula cancelada.");
        closeModal();
        if (onChange) onChange();
      });
    }
  }

  renderBody();
}

// ── Modal de registrar pagamento de uma parcela — Stripe fica de fora aqui:
// cobrar via Stripe exige o fluxo de Checkout Session (QR/link), não faz
// sentido como uma opção de um <select> de baixa manual. Exportado: também
// usado em financeiro.js (Contas a Receber lista as parcelas pendentes de
// matrícula ao lado de vendas/recebimentos manuais).
export function openPagamentoParcelaForm(parcelaId, onSaved) {
  const body = openModal("Registrar pagamento da parcela");

  body.innerHTML = `
    <form id="mp-form">
      <div id="mp-form-error"></div>
      <div class="form-grid">
        <div class="field">
          <label for="mp-data">Data do pagamento<span class="field-required">*</span></label>
          <input class="input" type="date" id="mp-data" value="${todayStr()}" required />
        </div>
        <div class="field">
          <label for="mp-forma">Forma de pagamento</label>
          <select class="input" id="mp-forma">
            <option value="">—</option>
            ${FORMAS_PAGAMENTO.filter((f) => f.label !== "Stripe").map((f) => `<option value="${escapeHtml(f.label)}">${escapeHtml(f.label)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" id="mp-cancel">Cancelar</button>
        <button type="submit" class="btn btn--primary">Confirmar pagamento</button>
      </div>
    </form>
  `;

  body.querySelector("#mp-cancel").addEventListener("click", closeModal);

  body.querySelector("#mp-form").addEventListener("submit", (e) => {
    e.preventDefault();
    withButtonLock(body.querySelector('#mp-form button[type="submit"]'), async () => {
      const errorEl = body.querySelector("#mp-form-error");
      errorEl.innerHTML = "";

      const { error } = await supabase.rpc("registrar_pagamento_parcela_matricula", {
        p_parcela_id: parcelaId,
        p_data_pagamento: body.querySelector("#mp-data").value || null,
        p_forma_pagamento: body.querySelector("#mp-forma").value || null,
      });

      if (error) {
        errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
        return;
      }

      showToast("Pagamento da parcela registrado.");
      closeModal();
      if (onSaved) onSaved();
    });
  });
}
