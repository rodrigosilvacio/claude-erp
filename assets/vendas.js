import { supabase } from "./supabaseClient.js";
import { showToast, openModal, confirmDialog, formatCurrency, formatDate, formatDateTime, escapeHtml, createSearchSelect, registerAutoRefresh, consumeVendaPrefill, setMatriculaPrefill, withButtonLock, friendlyPgError, exportCsv } from "./app.js";
import { isAdmin } from "./auth.js";
import { loadClientesAtivos, loadProdutosVendaveis, loadEmpresasAtivas, clienteSearchOptions, produtoSearchOptions, empresaSearchOptions, produtoMetaPrecoEstoque } from "./catalogo.js";
import { paytilesHtml, mountPaytiles, chamarCriarCheckoutStripe, mostrarModalStripe, dispararConfirmacaoNegocio } from "./pagamento.js";

let clientesOptions = [];
let produtosOptions = [];
let empresasOptions = [];
let cart = [];
// Id do agendamento ou da proposta que originou a venda em andamento (fluxos
// Agenda → Vendas e CRM → Vendas, via setVendaPrefill/consumeVendaPrefill em
// app.js). Sempre no máximo um dos dois preenchido; null numa venda avulsa.
let agendamentoOrigemId = null;
let propostaOrigemId = null;
// Itens de serviço da mesma proposta, ainda pendentes de virar Matrícula
// depois que esta venda for finalizada (proposta mista: produto físico vira
// Venda, serviço vira Matrícula — ver iniciarConversaoProposta em crm.js).
// Null quando a origem não é uma proposta, ou quando ela não tinha item de
// serviço nenhum.
let pendingServicosOrigem = null;

export async function render(view, actionsEl) {
  actionsEl.innerHTML = "";
  cart = [];
  agendamentoOrigemId = null;
  propostaOrigemId = null;
  pendingServicosOrigem = null;

  view.innerHTML = `
    <div class="toolbar" style="margin-bottom: 1.25rem;">
      <div style="display:flex; gap:0.5rem;">
        <button type="button" class="btn btn--primary" id="tab-nova">Nova venda</button>
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
    if (tab === "nova") {
      actionsEl.innerHTML = "";
      renderNovaVenda(content);
    } else {
      actionsEl.innerHTML = `<button type="button" class="btn btn--ghost" id="btn-exportar-csv">Exportar CSV</button>`;
      actionsEl.querySelector("#btn-exportar-csv").addEventListener("click", exportarHistoricoCsv);
      renderHistorico(content);
    }
  }

  tabNova.addEventListener("click", () => activate("nova"));
  tabHistorico.addEventListener("click", () => activate("historico"));

  [clientesOptions, produtosOptions, empresasOptions] = await Promise.all([loadClientesAtivos(), loadProdutosVendaveis(), loadEmpresasAtivas()]);

  activate("nova");
}

function renderNovaVenda(content) {
  const prefill = consumeVendaPrefill();
  agendamentoOrigemId = prefill?.agendamentoId || null;
  propostaOrigemId = prefill?.propostaId || null;
  pendingServicosOrigem = propostaOrigemId && prefill?.pendingServicos?.length
    ? {
        itens: prefill.pendingServicos,
        clienteId: prefill.clienteId,
        clienteNome: prefill.clienteNome,
        empresaId: prefill.empresaId,
        desconto: prefill.pendingServicosDesconto || 0,
        observacoes: prefill.observacoes,
        propostaId: prefill.propostaId,
        propostaNumero: prefill.propostaNumero,
      }
    : null;
  const admin = isAdmin();

  content.innerHTML = `
    <div class="venda-layout">
      <div class="card card-section venda-itens">
        ${agendamentoOrigemId ? `
          <div class="form-info">
            Confirmando venda do atendimento de ${escapeHtml(prefill.clienteNome || "cliente sem cadastro")} em ${formatDate(prefill.dataAgendamento)} às ${prefill.horario}. Revise os dados e finalize para registrar a venda.
          </div>
        ` : ""}
        ${propostaOrigemId ? `
          <div class="form-info">
            Convertendo a proposta #${prefill.propostaNumero} em venda. Revise os dados e finalize para registrar — a proposta será marcada como convertida.
          </div>
        ` : ""}
        ${admin ? `
          <div class="field">
            <label>Empresa<span class="field-required">*</span></label>
            <div data-mount="v-empresa"></div>
          </div>
        ` : ""}
        <div class="venda-meta">
          <div class="field" style="flex: 1 1 auto; min-width: 0;">
            <label>Cliente <span class="field-optional">opcional</span></label>
            <div data-mount="v-cliente"></div>
          </div>
          <div class="field venda-meta__data">
            <label for="v-data">Data</label>
            <input class="input" type="date" id="v-data" value="${new Date().toISOString().slice(0, 10)}" />
          </div>
        </div>
        <button type="button" class="venda-obs-toggle" id="v-obs-toggle">+ Adicionar observação</button>
        <div class="field venda-obs" id="v-obs-field" hidden>
          <label for="v-obs">Observações</label>
          <textarea class="input" id="v-obs" rows="2"></textarea>
        </div>

        <p class="section-title" style="margin-top: 1.5rem;">Itens</p>
        <div class="form-grid form-grid--itens">
          <div class="field">
            <label>Produto</label>
            <div data-mount="v-produto"></div>
          </div>
          <div class="field">
            <label for="v-qtd">Quantidade</label>
            <input class="input" type="number" id="v-qtd" min="1" step="1" value="1" />
          </div>
          <div class="field">
            <button type="button" class="btn btn--ghost" id="v-add-item">+ Adicionar</button>
          </div>
        </div>

        <div class="table-wrap" style="margin-top: 1rem;">
          <table class="data-table" id="cart-table">
            <thead>
              <tr><th>Produto</th><th style="text-align:right">Qtd.</th><th style="text-align:right">Preço</th><th style="text-align:right">Subtotal</th><th></th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div class="card receipt">
        <p class="section-title">Fechamento</p>

        <p class="receipt__label">Forma de pagamento</p>
        <div class="paytiles" id="v-forma" role="radiogroup" aria-label="Forma de pagamento">
          ${paytilesHtml()}
        </div>

        <div class="receipt__tear"></div>
        <div class="receipt__row"><span>Subtotal</span><span id="r-subtotal">${formatCurrency(0)}</span></div>
        <div class="receipt__row">
          <span>Desconto</span>
          <input class="input" type="number" id="v-desconto" min="0" step="0.01" value="${prefill?.desconto || 0}" style="width: 110px; text-align:right; font-family: var(--font-mono);" />
        </div>
        <div class="receipt__tear"></div>
        <div class="receipt__total"><span>Total</span><span id="r-total">${formatCurrency(0)}</span></div>

        <div class="field" style="margin-top: 0.9rem;">
          <label><input type="checkbox" id="v-parcelar" /> Parcelar (venda a prazo)</label>
          <div id="v-parcelar-field" hidden style="margin-top: 0.5rem;">
            <label for="v-num-parcelas" class="field-hint">Número de parcelas</label>
            <input class="input" type="number" id="v-num-parcelas" min="2" step="1" value="2" style="width: 100px;" />
            <p class="field-hint">Requer cliente identificado. 1ª parcela vence em 30 dias — nenhum valor é dado como pago na hora.</p>
          </div>
        </div>

        <button type="button" class="btn btn--primary" id="v-finalizar" style="width:100%; justify-content:center; margin-top: 1.25rem;">Finalizar venda</button>
        <div id="v-error"></div>
      </div>
    </div>
  `;

  const cartBody = content.querySelector("#cart-table tbody");
  const descontoInput = content.querySelector("#v-desconto");
  const paytiles = mountPaytiles(content.querySelector("#v-forma"));

  const parcelarCheckbox = content.querySelector("#v-parcelar");
  const parcelarField = content.querySelector("#v-parcelar-field");
  parcelarCheckbox.addEventListener("change", () => {
    parcelarField.hidden = !parcelarCheckbox.checked;
  });

  const obsToggle = content.querySelector("#v-obs-toggle");
  const obsField = content.querySelector("#v-obs-field");
  const obsInput = content.querySelector("#v-obs");
  obsToggle.addEventListener("click", () => {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.focus();
  });

  if (agendamentoOrigemId) {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.value = `Venda referente ao atendimento agendado em ${formatDate(prefill.dataAgendamento)} às ${prefill.horario}.${prefill.observacoes ? ` Obs. do agendamento: ${prefill.observacoes}` : ""}`;
  } else if (propostaOrigemId) {
    obsField.hidden = false;
    obsToggle.hidden = true;
    obsInput.value = prefill.observacoes || `Convertida da proposta #${prefill.propostaNumero}.`;
  }

  const empresaSelect = admin
    ? createSearchSelect({
        container: content.querySelector('[data-mount="v-empresa"]'),
        placeholder: "Buscar empresa…",
        options: empresaSearchOptions(empresasOptions),
        value: prefill?.empresaId || null,
        allowClear: false,
      })
    : null;

  const clienteSelect = createSearchSelect({
    container: content.querySelector('[data-mount="v-cliente"]'),
    placeholder: "Buscar cliente por nome ou documento… (opcional)",
    options: clienteSearchOptions(clientesOptions),
    value: prefill?.clienteId || null,
    allowClear: true,
  });

  const qtdInput = content.querySelector("#v-qtd");

  const produtoSelect = createSearchSelect({
    container: content.querySelector('[data-mount="v-produto"]'),
    placeholder: "Buscar produto por nome ou SKU…",
    options: produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }),
    allowClear: true,
    // Ao escolher um produto (clique numa opção ou Enter numa sugestão
    // filtrada — o que um leitor de código de barras faz sozinho), NÃO
    // adiciona direto no carrinho: o foco pula pro campo de Quantidade, já
    // com o valor "1" selecionado, pronto pra digitar por cima. O usuário
    // confirma com Enter ali (keydown mais abaixo) ou clicando em
    // "+ Adicionar". Assim o item já entra na grid com a quantidade certa,
    // em vez de precisar corrigir depois direto na tabela.
    onChange: (value) => {
      if (!value) return;
      qtdInput.value = 1;
      qtdInput.focus();
      qtdInput.select();
    },
  });

  if (prefill?.produtoId) {
    const produto = produtosOptions.find((p) => p.id === prefill.produtoId);
    if (produto) cart.push({ produto_id: produto.id, nome: produto.nome, quantidade: 1, preco_unitario: produto.preco });
    else showToast("Produto do atendimento não encontrado no catálogo de vendas.", "error");
  } else if (prefill?.itens?.length) {
    // Vindo de uma proposta aprovada: preço pode ter sido negociado (diferente
    // do preço de tabela), por isso usa o preço da proposta, não o do catálogo.
    prefill.itens.forEach((item) => {
      const produto = produtosOptions.find((p) => p.id === item.produto_id);
      if (produto) cart.push({ produto_id: produto.id, nome: produto.nome, quantidade: item.quantidade, preco_unitario: item.preco_unitario });
      else showToast(`Produto "${item.nome}" da proposta não encontrado no catálogo de vendas.`, "error");
    });
  }

  function renderCart() {
    if (cart.length === 0) {
      cartBody.innerHTML = `<tr><td colspan="5" class="empty-state" style="padding: 1.5rem;">Nenhum item adicionado ainda.</td></tr>`;
    } else {
      cartBody.innerHTML = cart.map((item, idx) => `
        <tr>
          <td>${escapeHtml(item.nome)}</td>
          <td class="cell-num">
            <input type="number" class="input" data-qty="${idx}" min="1" step="1" value="${item.quantidade}" style="width: 64px; text-align:right; padding: 0.35rem 0.5rem; font-family: var(--font-mono);" />
          </td>
          <td class="cell-num">${formatCurrency(item.preco_unitario)}</td>
          <td class="cell-num">${formatCurrency(item.quantidade * item.preco_unitario)}</td>
          <td class="cell-actions"><button type="button" class="icon-btn" data-remove="${idx}" aria-label="Remover">&times;</button></td>
        </tr>
      `).join("");
      cartBody.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
          cart.splice(Number(btn.dataset.remove), 1);
          renderCart();
        });
      });
      // Corrige a quantidade de um item já no carrinho sem precisar remover
      // e readicionar — antes só dava pra ajustar assim.
      cartBody.querySelectorAll("[data-qty]").forEach((input) => {
        input.addEventListener("change", () => {
          const idx = Number(input.dataset.qty);
          cart[idx].quantidade = Math.max(Math.floor(Number(input.value || 0)), 1);
          renderCart();
        });
      });
    }
    updateTotals();
  }

  function updateTotals() {
    const subtotal = cart.reduce((sum, item) => sum + item.quantidade * item.preco_unitario, 0);
    const desconto = Number(descontoInput.value || 0);
    content.querySelector("#r-subtotal").textContent = formatCurrency(subtotal);
    content.querySelector("#r-total").textContent = formatCurrency(Math.max(subtotal - desconto, 0));
  }

  descontoInput.addEventListener("input", updateTotals);

  function addItem() {
    const produtoId = produtoSelect.getValue();
    const produto = produtosOptions.find((p) => p.id === produtoId);
    const quantidade = Number(qtdInput.value || 0);

    if (!produto || quantidade <= 0) return;

    const existing = cart.find((item) => item.produto_id === produto.id);
    if (existing) existing.quantidade += quantidade;
    else cart.push({ produto_id: produto.id, nome: produto.nome, quantidade, preco_unitario: produto.preco });

    qtdInput.value = 1;
    produtoSelect.reset();
    produtoSelect.focusInput();
    renderCart();
  }

  content.querySelector("#v-add-item").addEventListener("click", addItem);
  qtdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addItem();
    }
  });

  content.querySelector("#v-finalizar").addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
    const errorEl = content.querySelector("#v-error");
    errorEl.innerHTML = "";

    if (cart.length === 0) {
      errorEl.innerHTML = `<div class="form-error">Adicione ao menos um item antes de finalizar.</div>`;
      return;
    }

    if (admin && !empresaSelect.getValue()) {
      errorEl.innerHTML = `<div class="form-error">Selecione uma empresa.</div>`;
      return;
    }

    const clienteId = clienteSelect.getValue() || null;
    const numeroParcelas = parcelarCheckbox.checked ? Number(content.querySelector("#v-num-parcelas").value || 0) : null;
    if (parcelarCheckbox.checked) {
      if (!clienteId) {
        errorEl.innerHTML = `<div class="form-error">Venda parcelada precisa de um cliente identificado.</div>`;
        return;
      }
      if (!numeroParcelas || numeroParcelas < 2) {
        errorEl.innerHTML = `<div class="form-error">Informe um número de parcelas válido (mínimo 2).</div>`;
        return;
      }
    }

    const payload = {
      p_cliente_id: clienteId,
      p_data_venda: content.querySelector("#v-data").value || null,
      p_observacoes: content.querySelector("#v-obs").value || null,
      p_desconto: Number(descontoInput.value || 0),
      p_itens: cart.map((item) => ({ produto_id: item.produto_id, quantidade: item.quantidade, preco_unitario: item.preco_unitario })),
    };
    if (admin) payload.p_empresa_id = empresaSelect.getValue();
    // Preço negociado na proposta de origem (se houver) — criar_venda
    // resolve o valor sozinha a partir do id da proposta; o preco_unitario
    // que vai em p_itens é só o que aparece na tela, nunca o que é cobrado.
    if (propostaOrigemId) payload.p_proposta_id = propostaOrigemId;

    const formaPagamento = paytiles.getValue();

    if (formaPagamento === "Stripe") {
      await iniciarPagamentoStripe(payload, errorEl);
      return;
    }

    if (numeroParcelas) payload.p_numero_parcelas = numeroParcelas;

    const { data: novaVendaId, error } = await supabase.rpc("criar_venda", { ...payload, p_forma_pagamento: formaPagamento });

    if (error) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(friendlyPgError(error))}</div>`;
      return;
    }

    await finalizarComSucesso(novaVendaId);
  }));

  // Fluxo Stripe: a venda só é criada (e só fecha) depois do pagamento —
  // ver iniciarPagamentoStripe/mostrarModalStripe abaixo. `agendamentoOrigemId`/
  // `propostaOrigemId` e `cart` seguem em memória durante todo o processo, por
  // isso finalizarComSucesso lê essas variáveis do escopo de renderNovaVenda.
  async function finalizarComSucesso(vendaId, mensagemBase = "Venda registrada com sucesso.") {
    dispararConfirmacaoNegocio("venda", vendaId);

    if (agendamentoOrigemId) {
      const { error: agError } = await supabase.from("agendamentos").update({ status: "atendido" }).eq("id", agendamentoOrigemId);
      showToast(agError ? "Venda registrada, mas não foi possível confirmar o atendimento na agenda." : "Venda registrada e atendimento confirmado.", agError ? "error" : "success");
    } else if (propostaOrigemId) {
      // Só marca a proposta como convertida DEPOIS da venda existir de fato —
      // nunca antes, senão um pagamento Stripe abandonado (ou uma falha aqui)
      // deixaria a proposta "convertida" sem venda nenhuma por trás.
      const { error: propError } = await supabase
        .from("propostas")
        .update({ venda_id: vendaId, convertida_em: new Date().toISOString() })
        .eq("id", propostaOrigemId);

      // Proposta mista (produto + serviço): depois da venda, continua o
      // encadeamento pra Matrículas com o(s) item(ns) de serviço que
      // ficaram de fora do carrinho — ver iniciarConversaoProposta em
      // crm.js. Sem isso o vendedor teria que abrir Matrículas na mão e
      // digitar tudo de novo.
      if (!propError && pendingServicosOrigem) {
        const [primeiro, ...resto] = pendingServicosOrigem.itens;
        setMatriculaPrefill({
          propostaId: pendingServicosOrigem.propostaId,
          propostaNumero: pendingServicosOrigem.propostaNumero,
          clienteId: pendingServicosOrigem.clienteId,
          clienteNome: pendingServicosOrigem.clienteNome,
          empresaId: pendingServicosOrigem.empresaId,
          produtoId: primeiro.produto_id,
          precoUnitario: primeiro.preco_unitario,
          desconto: pendingServicosOrigem.desconto,
          observacoes: pendingServicosOrigem.observacoes,
          pendingServicos: resto,
        });
        showToast("Venda registrada. Agora finalize a matrícula do(s) item(ns) de serviço da mesma proposta.");
        agendamentoOrigemId = null;
        propostaOrigemId = null;
        pendingServicosOrigem = null;
        cart = [];
        window.location.hash = "#/matriculas";
        return;
      }

      showToast(propError ? "Venda registrada, mas não foi possível marcar a proposta como convertida." : "Venda registrada e proposta marcada como convertida.", propError ? "error" : "success");
    } else {
      showToast(mensagemBase);
    }

    agendamentoOrigemId = null;
    propostaOrigemId = null;
    pendingServicosOrigem = null;
    cart = [];
    produtosOptions = await loadProdutosVendaveis();
    renderNovaVenda(content);
  }

  async function iniciarPagamentoStripe(payload, errorEl) {
    // Base do próprio index.html do appvendas (funciona local ou em qualquer
    // domínio de deploy) — as páginas de retorno vivem ao lado dele.
    const baseUrl = new URL(".", window.location.href).href;

    let data;
    try {
      data = await chamarCriarCheckoutStripe({
        ...payload,
        success_url: `${baseUrl}pagamento-confirmado.html`,
        cancel_url: `${baseUrl}pagamento-cancelado.html`,
      });
    } catch (err) {
      errorEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
      return;
    }

    await mostrarModalStripe({
      title: `Pagamento via Stripe — Venda #${data.numero}`,
      id: data.venda_id,
      table: "vendas",
      successStatus: "confirmada",
      checkoutUrl: data.url,
      onConfirmada: () => finalizarComSucesso(data.venda_id, "Pagamento confirmado. Venda registrada."),
    });
  }

  renderCart();

  // Atualiza silenciosamente os catálogos de cliente/produto (estoque, novos
  // cadastros) sem perder o carrinho em andamento nem fechar os campos de busca.
  registerAutoRefresh(async () => {
    const [nextClientes, nextProdutos] = await Promise.all([loadClientesAtivos(), loadProdutosVendaveis()]);
    clientesOptions = nextClientes;
    produtosOptions = nextProdutos;
    clienteSelect.setOptions(clienteSearchOptions(clientesOptions));
    produtoSelect.setOptions(produtoSearchOptions(produtosOptions, { meta: produtoMetaPrecoEstoque }));
  }, 15000);
}

const HISTORICO_PAGE_SIZE = 50;
// Teto de segurança pra exportação, mesmo padrão de FETCH_CAP em
// financeiro.js/contas-pagar.js — histórico de vendas não tem filtro de
// período (é uma lista só paginada por número), então sem isso "Exportar
// CSV" poderia tentar puxar anos de vendas de uma vez.
const EXPORT_CAP = 5000;

async function exportarHistoricoCsv() {
  const { data, error } = await supabase
    .from("vendas")
    .select("numero, data_venda, status, total, forma_pagamento, cliente:clientes(nome)")
    .order("numero", { ascending: false })
    .limit(EXPORT_CAP);

  if (error) {
    showToast(friendlyPgError(error), "error");
    return;
  }

  exportCsv(
    "vendas.csv",
    ["Nº", "Data", "Cliente", "Forma de pagamento", "Total", "Status"],
    (data || []).map((v) => [v.numero, v.data_venda, v.cliente?.nome || "", v.forma_pagamento || "", Number(v.total || 0).toFixed(2).replace(".", ","), statusLabel(v.status)]),
  );
}

async function renderHistorico(content) {
  content.innerHTML = `<div class="card"><div class="table-wrap" id="vendas-table">${'<div class="empty-state">Carregando…</div>'}</div></div><div id="vendas-pagination"></div>`;

  const state = { page: 0 };
  await loadHistorico(content, state);

  registerAutoRefresh(() => loadHistorico(content, state, { silent: true }), 15000);
}

async function loadHistorico(content, state, opts = {}) {
  const { silent = false } = opts;
  const tableWrap = content.querySelector("#vendas-table");
  if (!silent) tableWrap.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const from = state.page * HISTORICO_PAGE_SIZE;
  const { data, error, count } = await supabase
    .from("vendas")
    .select("id, numero, data_venda, status, total, forma_pagamento, cliente:clientes(nome)", { count: "exact" })
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
    tableWrap.innerHTML = `<div class="empty-state"><p class="empty-state__title">Nenhuma venda registrada ainda</p></div>`;
    content.querySelector("#vendas-pagination").innerHTML = "";
    return;
  }

  tableWrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Pagamento</th><th style="text-align:right">Total</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        ${data.map((v) => `
          <tr>
            <td class="cell-num">#${v.numero}</td>
            <td>${formatDate(v.data_venda)}</td>
            <td>${escapeHtml(v.cliente?.nome || "Sem cliente")}</td>
            <td class="cell-muted">${escapeHtml(v.forma_pagamento || "—")}</td>
            <td class="cell-num">${formatCurrency(v.total)}</td>
            <td><span class="status status--${v.status}">${statusLabel(v.status)}</span></td>
            <td class="cell-actions">
              <button type="button" class="btn btn--ghost btn--sm" data-detail="${v.id}">Detalhes</button>
              ${v.status !== "cancelada" ? `<button type="button" class="btn btn--danger btn--sm" data-cancel="${v.id}">Cancelar</button>` : ""}
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  tableWrap.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", () => showDetail(btn.dataset.detail));
  });

  tableWrap.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmDialog("Cancelar esta venda? O estoque dos itens será devolvido.", { confirmLabel: "Cancelar venda" });
      if (!ok) return;
      const { error: cancelError } = await supabase.rpc("cancelar_venda", { p_venda_id: btn.dataset.cancel });
      if (cancelError) {
        showToast(friendlyPgError(cancelError), "error");
        return;
      }
      showToast("Venda cancelada e estoque devolvido.");
      loadHistorico(content, state);
    });
  });

  renderHistoricoPagination(content, state, count);
}

function renderHistoricoPagination(content, state, count) {
  const el = content.querySelector("#vendas-pagination");
  const totalPages = Math.max(1, Math.ceil(count / HISTORICO_PAGE_SIZE));

  if (totalPages <= 1) {
    el.innerHTML = "";
    return;
  }

  el.innerHTML = `
    <div class="pagination">
      <button type="button" class="btn btn--ghost btn--sm" id="vendas-page-prev" ${state.page === 0 ? "disabled" : ""}>‹ Anterior</button>
      <span class="pagination__label">Página ${state.page + 1} de ${totalPages}</span>
      <button type="button" class="btn btn--ghost btn--sm" id="vendas-page-next" ${state.page >= totalPages - 1 ? "disabled" : ""}>Próxima ›</button>
    </div>
  `;

  el.querySelector("#vendas-page-prev").addEventListener("click", () => {
    state.page = Math.max(0, state.page - 1);
    loadHistorico(content, state);
  });
  el.querySelector("#vendas-page-next").addEventListener("click", () => {
    state.page += 1;
    loadHistorico(content, state);
  });
}

function statusLabel(status) {
  return {
    confirmada: "Confirmada",
    orcamento: "Orçamento",
    cancelada: "Cancelada",
    aguardando_pagamento: "Aguardando pagamento",
  }[status] || status;
}

async function showDetail(vendaId) {
  const body = openModal("Detalhes da venda");
  body.innerHTML = `<div class="empty-state">Carregando…</div>`;

  const [{ data: venda, error: vendaError }, { data: itens }, { data: propostaOrigem }, { data: parcelas }] = await Promise.all([
    supabase.from("vendas").select("*, cliente:clientes(nome), usuario:usuarios(nome)").eq("id", vendaId).single(),
    supabase.from("venda_itens").select("*, produto:produtos(nome)").eq("venda_id", vendaId),
    supabase.from("propostas").select("numero").eq("venda_id", vendaId).maybeSingle(),
    supabase.from("venda_parcelas").select("*").eq("venda_id", vendaId).order("numero_parcela", { ascending: true }),
  ]);

  if (!venda) {
    body.innerHTML = vendaError
      ? `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar a venda</p><p class="empty-state__hint">${escapeHtml(friendlyPgError(vendaError))}</p></div>`
      : `<div class="empty-state">Venda não encontrada.</div>`;
    return;
  }

  body.innerHTML = `
    <div class="receipt" style="padding: 0;">
      <div class="receipt__row"><span>Nº da venda</span><span>#${venda.numero}</span></div>
      ${propostaOrigem ? `<div class="receipt__row"><span>Origem</span><span>Proposta #${propostaOrigem.numero} (CRM)</span></div>` : ""}
      <div class="receipt__row"><span>Data</span><span>${formatDate(venda.data_venda)}</span></div>
      <div class="receipt__row"><span>Cliente</span><span>${escapeHtml(venda.cliente?.nome || "Sem cliente")}</span></div>
      <div class="receipt__row"><span>Pagamento</span><span>${escapeHtml(venda.forma_pagamento || "—")}</span></div>
      <div class="receipt__row"><span>Vendedor</span><span>${escapeHtml(venda.usuario?.nome || "—")}</span></div>
      <div class="receipt__row"><span>Status</span><span class="status status--${venda.status}">${statusLabel(venda.status)}</span></div>
      ${venda.observacoes ? `<div class="receipt__row"><span>Obs.</span><span>${escapeHtml(venda.observacoes)}</span></div>` : ""}
      <div class="receipt__tear"></div>
      ${(itens || []).map((item) => `
        <div class="receipt__row">
          <span>${item.quantidade}x ${escapeHtml(item.produto?.nome || "Produto")}</span>
          <span>${formatCurrency(item.subtotal)}</span>
        </div>
      `).join("")}
      <div class="receipt__tear"></div>
      <div class="receipt__row"><span>Subtotal</span><span>${formatCurrency(venda.subtotal)}</span></div>
      <div class="receipt__row"><span>Desconto</span><span>${formatCurrency(venda.desconto)}</span></div>
      <div class="receipt__total"><span>Total</span><span>${formatCurrency(venda.total)}</span></div>
      <p class="cell-muted" style="font-size: 0.75rem; margin-top: 1rem;">Registrada em ${formatDateTime(venda.created_at)}</p>
    </div>
    ${(parcelas || []).length > 0 ? `
      <div class="receipt" style="padding: 0; margin-top: 1.2rem;">
        <p class="section-title" style="margin-bottom: 0.6rem;">Parcelas</p>
        ${parcelas.map((p) => `
          <div class="receipt__row">
            <span>${p.numero_parcela}ª · vence ${formatDate(p.data_vencimento)}${p.status === "pago" ? ` · pago ${formatDate(p.data_pagamento)}` : ""}</span>
            <span style="display:flex; align-items:center; gap:0.5rem;">
              ${formatCurrency(p.valor)}
              <span class="status status--${p.status === "pago" ? "ativo" : p.status === "cancelado" ? "inativo" : "pendente"}">${p.status === "pago" ? "Pago" : p.status === "cancelado" ? "Cancelada" : "Pendente"}</span>
              ${p.status === "pendente" ? `<button type="button" class="btn btn--ghost btn--sm" data-baixar-parcela="${p.id}">Baixar</button>` : ""}
            </span>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;

  body.querySelectorAll("[data-baixar-parcela]").forEach((btn) => {
    btn.addEventListener("click", (e) => withButtonLock(e.currentTarget, async () => {
      const { error } = await supabase.rpc("registrar_pagamento_parcela_venda", { p_parcela_id: btn.dataset.baixarParcela });
      if (error) {
        showToast(friendlyPgError(error), "error");
        return;
      }
      showToast("Parcela baixada.");
      await showDetail(vendaId);
    }));
  });
}
