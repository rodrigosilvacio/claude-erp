// ERPConnect — shell: roteamento por hash + utilitários compartilhados
// (toast, modal, confirmação, formatação). Cada módulo de tela expõe
// `render(view)` e monta seu próprio HTML dentro do container recebido.

import { initAuth, isLoggedIn, isAdmin, isGlobalAdmin, getCurrentUsuario, refreshCurrentUsuario, signOut, onAuthChange } from "./auth.js";
import { supabase } from "./supabaseClient.js";

// Usados como fallback quando a empresa do usuário logado não tem
// `nome_aplicacao` configurado (ou quando o usuário é admin global, sem
// empresa vinculada). A tela de login sempre mostra este nome — antes de
// autenticar não há como saber a qual empresa a pessoa pertence.
export const DEFAULT_APP_NAME = "ERPConnect";
const DEFAULT_APP_MARK = "EC";

// Chaves em ROUTES que representam itens de menu operacionais que podem ser
// escondidos por empresa (configurável em Administração > Configurações).
// Início e o grupo Administração nunca entram nessa lista.
const CONFIGURABLE_MENU_KEYS = ["clientes", "produtos", "fornecedores", "crm", "vendas", "agenda", "estoques", "matriculas", "contas-receber", "contas-pagar", "relatorios"];

// Atualize este timestamp a cada mudança em app.js — é como a sidebar mostra
// se o navegador está com uma cópia antiga em cache (ver #sidebar-build
// abaixo). Só isso é versionado manualmente: o <script> de entrada em
// index.html NÃO pode ganhar um "?v=" — todo o resto do app importa
// "./app.js" sem versão, e um especificador diferente no entry point faz o
// ES modules carregar duas instâncias do módulo (hashchange listener e
// boot() duplicados). Ver commit e4f8448 (correção original) e 3659424/
// e75bd3a (reintrodução e reversão do bug).
export const APP_BUILD = "2026-08-30 16:00 -03";

const ROUTES = {
  home: {
    breadcrumb: "Início",
    title: "Painel do dia",
    load: () => import("./home.js"),
  },
  clientes: {
    breadcrumb: "Cadastros",
    title: "Clientes",
    load: () => import("./clientes.js"),
  },
  produtos: {
    breadcrumb: "Cadastros",
    title: "Produtos",
    load: () => import("./produtos.js"),
  },
  fornecedores: {
    breadcrumb: "Cadastros",
    title: "Fornecedores",
    load: () => import("./fornecedores.js"),
  },
  crm: {
    breadcrumb: "Movimentações",
    title: "CRM · Propostas",
    load: () => import("./crm.js"),
  },
  vendas: {
    breadcrumb: "Movimentações",
    title: "Loja",
    load: () => import("./vendas.js"),
  },
  agenda: {
    breadcrumb: "Movimentações",
    title: "Agenda",
    load: () => import("./agenda.js"),
  },
  estoques: {
    breadcrumb: "Movimentações",
    title: "Estoques",
    load: () => import("./estoques.js"),
  },
  matriculas: {
    breadcrumb: "Movimentações",
    title: "Matrículas",
    load: () => import("./matriculas.js"),
  },
  "contas-receber": {
    breadcrumb: "Financeiro",
    title: "Contas a Receber",
    load: () => import("./financeiro.js"),
  },
  "contas-pagar": {
    breadcrumb: "Financeiro",
    title: "Contas a Pagar",
    load: () => import("./contas-pagar.js"),
  },
  relatorios: {
    breadcrumb: "Relatórios",
    title: "Visão geral",
    load: () => import("./relatorios.js"),
  },
  empresas: {
    breadcrumb: "Administração",
    title: "Empresas",
    load: () => import("./empresas.js"),
    adminOnly: true,
    // Gestão de empresas (criar, editar cadastro de outras empresas) é
    // exclusiva de admin global desde a migration 0020 — um admin de
    // empresa que chegasse aqui só veria a própria empresa e teria
    // qualquer tentativa de salvar rejeitada pela RLS. Mesmo racional de
    // "configuracoes" abaixo.
    globalAdminOnly: true,
  },
  usuarios: {
    breadcrumb: "Administração",
    title: "Usuários",
    load: () => import("./usuarios.js"),
    adminOnly: true,
  },
  configuracoes: {
    breadcrumb: "Administração",
    title: "Configurações",
    load: () => import("./configuracoes.js"),
    adminOnly: true,
    globalAdminOnly: true,
  },
};

const DEFAULT_ROUTE = "home";

const viewEl = document.getElementById("view");
const breadcrumbEl = document.getElementById("breadcrumb");
const titleEl = document.getElementById("page-title");
const topbarActionsEl = document.getElementById("topbar-actions");
const navLinks = Array.from(document.querySelectorAll(".nav-link"));
const navUsuarios = document.getElementById("nav-usuarios");
const navEmpresas = document.getElementById("nav-empresas");
const navConfiguracoes = document.getElementById("nav-configuracoes");
const sidebarBrandMark = document.getElementById("sidebar-brand-mark");
const sidebarBrandName = document.getElementById("sidebar-brand-name");
const userChipAvatar = document.getElementById("user-chip-avatar");
const userChipName = document.getElementById("user-chip-name");
const userChipMeta = document.getElementById("user-chip-meta");
const logoutBtn = document.getElementById("logout-btn");
const navBadgeEstoques = document.getElementById("nav-badge-estoques");

// Diagnóstico de cache: se este build não bater com o timestamp do último
// commit em app.js, o navegador está servindo uma cópia antiga em cache —
// mesmo padrão usado em reports/index.html. Ver nota em APP_BUILD acima.
const sidebarBuildEl = document.getElementById("sidebar-build");
if (sidebarBuildEl) sidebarBuildEl.textContent = `build ${APP_BUILD}`;

function initials(nome) {
  const parts = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "–";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

// ── Badge de pendência no menu (faixa roxa do roadmap) ────────────────
//
// Antes, estoque baixo só aparecia abrindo o painel Início — o app era 100%
// reativo. Este badge fica visível no menu o tempo todo (contado a cada
// minuto), independente de qual tela está aberta. Fica escondido (não
// zerado) enquanto ninguém está logado.
//
// Havia um badge igual em Contas a Receber (parcelas de matrícula vencidas)
// — removido a pedido: o número sem rótulo ao lado do item de menu lia como
// ruído, não como aviso. O dado continua disponível dentro da própria tela
// de Contas a Receber.

function setNavBadge(el, count) {
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? "99+" : String(count);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function hidePendencyBadges() {
  setNavBadge(navBadgeEstoques, 0);
}

async function refreshPendencyBadges() {
  const { data, error } = await supabase.from("produtos").select("estoque, estoque_minimo, tipo").eq("ativo", true);

  if (error) {
    console.error("Falha ao atualizar badge de estoque baixo:", error);
    return;
  }
  // Serviço (tipo="servico") nunca recebe entrada de estoque — mesma
  // exclusão de home.js/estoques.js/relatorios.js, senão o badge fica
  // aceso pra sempre por causa de um curso/mensalidade.
  setNavBadge(navBadgeEstoques, (data || []).filter((p) => p.tipo === "produto" && p.estoque <= p.estoque_minimo).length);
}

let badgeRefreshTimer = null;

function startBadgeRefresh() {
  stopBadgeRefresh();
  refreshPendencyBadges();
  badgeRefreshTimer = setInterval(refreshPendencyBadges, 60000);
}

function stopBadgeRefresh() {
  if (badgeRefreshTimer) {
    clearInterval(badgeRefreshTimer);
    badgeRefreshTimer = null;
  }
}

function updateAuthUI() {
  const usuario = getCurrentUsuario();
  const logged = isLoggedIn();

  appShell.classList.toggle("is-locked", !logged);
  navUsuarios.hidden = !isAdmin();
  navEmpresas.hidden = !isGlobalAdmin();
  navConfiguracoes.hidden = !isGlobalAdmin();

  if (logged) startBadgeRefresh();
  else {
    stopBadgeRefresh();
    hidePendencyBadges();
  }

  if (usuario) {
    userChipAvatar.textContent = initials(usuario.nome);
    userChipName.textContent = usuario.nome;
    userChipMeta.textContent = usuario.role === "admin" ? "Administrador" : "Caixa";
  } else {
    userChipAvatar.textContent = "–";
    userChipName.textContent = "—";
    userChipMeta.textContent = "—";
  }

  applyBranding(usuario);
  applyMenuVisibility(usuario);
}

// Nome/mark customizados valem só depois do login, pra usuários vinculados a
// uma empresa com `nome_aplicacao` preenchido — admins globais (sem empresa)
// e a tela de login sempre usam o padrão, já que antes de autenticar não dá
// pra saber de qual empresa é o usuário.
// Cor de destaque por empresa (Configurações > Identidade): sobrescreve a
// paleta padrão via custom property, nas mesmas variáveis que styles.css já
// usa para os elementos de destaque (sidebar ativa, botões primários…).
// Nula/ausente = remove o override e volta ao valor definido em styles.css.
const CORES_APLICADAS = ["--accent", "--accent-deep", "--accent-soft"];

function misturarHex(hex, alvoRgb, fator) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return `#${rgb.map((c, i) => Math.round(c + (alvoRgb[i] - c) * fator).toString(16).padStart(2, "0")).join("")}`;
}

function applyCorPrimaria(cor) {
  const valida = cor && /^#[0-9a-fA-F]{6}$/.test(cor);
  if (!valida) {
    CORES_APLICADAS.forEach((v) => document.documentElement.style.removeProperty(v));
    return;
  }
  document.documentElement.style.setProperty("--accent", cor);
  document.documentElement.style.setProperty("--accent-deep", misturarHex(cor, [0, 0, 0], 0.22));
  document.documentElement.style.setProperty("--accent-soft", misturarHex(cor, [255, 255, 255], 0.86));
}

function applyBranding(usuario) {
  const custom = usuario?.empresa?.nome_aplicacao?.trim();
  const nome = custom || DEFAULT_APP_NAME;
  document.title = nome;
  sidebarBrandName.textContent = nome;
  sidebarBrandMark.textContent = custom
    ? custom.replace(/\s+/g, "").slice(0, 2).toUpperCase() || DEFAULT_APP_MARK
    : DEFAULT_APP_MARK;
  applyCorPrimaria(usuario?.empresa?.cor_primaria);
}

function menusHabilitadosDe(usuario) {
  return usuario?.empresa?.menus_habilitados || {};
}

// Admin global (sem empresa) não tem `usuario.empresa`, então o mapa fica
// vazio e nada é escondido — condiz com o fato de esse papel enxergar dados
// de todas as empresas nas próprias telas (RLS libera por is_admin()).
function applyMenuVisibility(usuario) {
  const menus = menusHabilitadosDe(usuario);
  CONFIGURABLE_MENU_KEYS.forEach((key) => {
    const link = document.querySelector(`.nav-link[data-route="${key}"]`);
    if (link) link.hidden = menus[key] === false;
  });
}

logoutBtn.addEventListener("click", async () => {
  await signOut();
});

// Se uma navegação nova começar antes de uma anterior terminar de carregar
// seu módulo (ex.: login concluído e o usuário já clica em outro link antes
// da Home acabar de montar), a chamada antiga não pode mais escrever no
// DOM — senão as duas rodam `render()` em cima do mesmo container e
// duplicam elementos (ex.: botões da toolbar aparecendo repetidos).
let renderToken = 0;

async function renderRoute() {
  const myToken = ++renderToken;

  if (!isLoggedIn()) {
    stopAutoRefresh();
    breadcrumbEl.textContent = "";
    titleEl.textContent = "Entrar";
    topbarActionsEl.innerHTML = "";
    closeNavDrawer();
    const mod = await import("./login.js");
    if (myToken !== renderToken) return;
    mod.render(viewEl);
    return;
  }

  const hash = window.location.hash.replace(/^#\//, "").split("?")[0];
  let routeKey = ROUTES[hash] ? hash : DEFAULT_ROUTE;
  let menus = menusHabilitadosDe(getCurrentUsuario());
  let blocked = (ROUTES[routeKey].adminOnly && !isAdmin())
    || (ROUTES[routeKey].globalAdminOnly && !isGlobalAdmin())
    || menus[routeKey] === false;
  if (blocked) {
    // Papel/empresa do usuário pode ter mudado (por exemplo, alguém te
    // promoveu a admin global) enquanto esta aba já estava aberta — a única
    // releitura periódica (ativoWatch) só confere se a conta segue ativa,
    // não papel/empresa/menus. Antes de bloquear de vez, revalida contra o
    // banco uma única vez: sem isso, a rota simplesmente não abria até um F5.
    await refreshCurrentUsuario();
    if (myToken !== renderToken) return;
    menus = menusHabilitadosDe(getCurrentUsuario());
    blocked = (ROUTES[routeKey].adminOnly && !isAdmin())
      || (ROUTES[routeKey].globalAdminOnly && !isGlobalAdmin())
      || menus[routeKey] === false;
    // A revalidação acima corrige o CONTEÚDO da rota, mas a sidebar (links
    // de Administração, nome/cor da marca) só era redesenhada por
    // updateAuthUI() no boot()/troca de sessão — nunca depois desta
    // releitura. Resultado: mesmo com a tela liberada, o link
    // "Configurações"/"Empresas" continuava escondido na sidebar até um F5,
    // dando a impressão de que a página "não carregava" sem recarregar.
    updateAuthUI();
  }
  if (blocked) {
    routeKey = DEFAULT_ROUTE;
    // replaceState em vez de mudar window.location.hash: corrige a URL sem
    // disparar um "hashchange" que renderizaria a rota padrão de novo.
    history.replaceState(null, "", `#/${DEFAULT_ROUTE}`);
  }
  const route = ROUTES[routeKey];

  navLinks.forEach((link) => {
    link.classList.toggle("is-active", link.dataset.route === routeKey);
  });

  stopAutoRefresh();
  breadcrumbEl.textContent = route.breadcrumb;
  titleEl.textContent = route.title;
  topbarActionsEl.innerHTML = "";
  closeNavDrawer();

  // O módulo da rota já pinta seu próprio estado inicial (toolbar +
  // skeleton, abas, etc.) assim que carrega — normalmente em microssegundos,
  // já que o import fica em cache do navegador. Só mostramos este skeleton
  // genérico se o carregamento realmente demorar, para não piscar uma tela
  // "errada" por uma fração de segundo antes da tela real aparecer.
  const loadingTimer = setTimeout(() => {
    viewEl.innerHTML = skeletonTable(4);
  }, 150);

  try {
    const mod = await route.load();
    clearTimeout(loadingTimer);
    if (myToken !== renderToken) return;
    await mod.render(viewEl, topbarActionsEl);
  } catch (err) {
    clearTimeout(loadingTimer);
    if (myToken !== renderToken) return;
    console.error(err);
    viewEl.innerHTML = `<div class="empty-state"><p class="empty-state__title">Não foi possível carregar esta tela</p><p class="empty-state__hint">${escapeHtml(err.message || String(err))}</p></div>`;
  }
}

window.addEventListener("hashchange", renderRoute);

async function boot() {
  await initAuth();
  onAuthChange(() => {
    updateAuthUI();
    renderRoute();
  });
  updateAuthUI();
  renderRoute();
}

window.addEventListener("DOMContentLoaded", boot);

// ── Menu responsivo (drawer + scrim) ───────────────────────────────

const appShell = document.getElementById("app-shell");
const menuToggle = document.getElementById("menu-toggle");
const sidebarClose = document.getElementById("sidebar-close");
const sidebarScrim = document.getElementById("sidebar-scrim");

function openNavDrawer() {
  appShell.classList.add("is-nav-open");
}

function closeNavDrawer() {
  appShell.classList.remove("is-nav-open");
}

menuToggle.addEventListener("click", openNavDrawer);
sidebarClose.addEventListener("click", closeNavDrawer);
sidebarScrim.addEventListener("click", closeNavDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeNavDrawer();
});

// ── Skeleton (estado de carregamento) ──────────────────────────────

export function skeletonTable(rows = 4) {
  const widths = ["70%", "45%", "60%", "35%"];
  const line = () => `<td><div class="skeleton-bar" style="width:${widths[Math.floor(Math.random() * widths.length)]}"></div></td>`;
  const row = () => `<tr>${line()}${line()}${line()}${line()}</tr>`;
  return `
    <div class="card">
      <div class="table-wrap">
        <table class="data-table skeleton-table"><tbody>${Array.from({ length: rows }, row).join("")}</tbody></table>
      </div>
    </div>
  `;
}

// ── Toast ───────────────────────────────────────────────────────────

const toastStack = document.getElementById("toast-stack");

export function showToast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Modal ───────────────────────────────────────────────────────────

const modalOverlay = document.getElementById("modal-overlay");
const modalEl = document.getElementById("modal");
const modalTitleEl = document.getElementById("modal-title");
const modalBodyEl = document.getElementById("modal-body");
const modalCloseBtn = document.getElementById("modal-close");

let onModalClose = null;

// `size: "wide"` cobre formulários com tabela embutida (ex.: itens de
// proposta no CRM) que ficam apertados nos 580px padrão — sem opção, todo
// modal do app teria que negociar o mesmo limite estreito.
export function openModal(title, { onClose, size } = {}) {
  modalTitleEl.textContent = title;
  modalBodyEl.innerHTML = "";
  modalOverlay.hidden = false;
  modalEl.classList.toggle("modal--wide", size === "wide");
  onModalClose = onClose || null;
  return modalBodyEl;
}

export function closeModal() {
  modalOverlay.hidden = true;
  modalBodyEl.innerHTML = "";
  modalEl.classList.remove("modal--wide");
  if (onModalClose) onModalClose();
  onModalClose = null;
}

modalCloseBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !modalOverlay.hidden) closeModal();
});

export function confirmDialog(message, { confirmLabel = "Confirmar", danger = true } = {}) {
  return new Promise((resolve) => {
    const body = openModal("Confirmar ação", {
      onClose: () => resolve(false),
    });
    body.innerHTML = `
      <p style="margin: 0 0 1.2rem; color: var(--text);">${escapeHtml(message)}</p>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" data-action="cancel">Cancelar</button>
        <button type="button" class="btn ${danger ? "btn--danger" : "btn--primary"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    body.querySelector('[data-action="cancel"]').addEventListener("click", () => {
      onModalClose = null;
      closeModal();
      resolve(false);
    });
    body.querySelector('[data-action="confirm"]').addEventListener("click", () => {
      onModalClose = null;
      closeModal();
      resolve(true);
    });
  });
}

// ── Busca dinâmica (substitui <select> combo box) ──────────────────
//
// Campo de texto que filtra uma lista de opções em tela, com navegação
// por teclado. Usado em qualquer vínculo entre cadastros (cliente,
// produto, fornecedor) no lugar de um <select> tradicional.

const SS_ICON = '<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

function normalizeForSearch(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function createSearchSelect({
  container,
  placeholder = "Buscar…",
  options = [],
  value = null,
  onChange = () => {},
  allowClear = true,
  emptyText = "Nenhum resultado encontrado",
}) {
  container.classList.add("search-select");
  container.innerHTML = `
    <div class="search-select__control">
      ${SS_ICON}
      <input type="text" class="search-select__input" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" placeholder="${escapeHtml(placeholder)}" />
      <button type="button" class="search-select__clear" hidden aria-label="Limpar seleção">&times;</button>
    </div>
    <div class="search-select__panel" role="listbox" hidden></div>
  `;

  const input = container.querySelector(".search-select__input");
  const clearBtn = container.querySelector(".search-select__clear");
  const panel = container.querySelector(".search-select__panel");

  let allOptions = options;
  let filtered = [];
  let highlighted = -1;
  let selected = null;

  function findOption(v) {
    return allOptions.find((o) => String(o.value) === String(v)) || null;
  }

  function optionMatches(opt, term) {
    const haystack = normalizeForSearch(`${opt.label} ${opt.meta || ""}`);
    return haystack.includes(term);
  }

  function openPanel() {
    const term = normalizeForSearch(input.value);
    filtered = term ? allOptions.filter((o) => optionMatches(o, term)) : allOptions.slice(0, 60);
    highlighted = filtered.length ? 0 : -1;
    renderPanel();
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function renderPanel() {
    if (filtered.length === 0) {
      panel.innerHTML = `<div class="search-select__empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    panel.innerHTML = filtered.map((opt, idx) => `
      <div class="search-select__option ${idx === highlighted ? "is-highlighted" : ""}" role="option" data-idx="${idx}">
        <span class="search-select__option-label">${escapeHtml(opt.label)}</span>
        ${opt.meta ? `<span class="search-select__option-meta">${escapeHtml(opt.meta)}</span>` : ""}
      </div>
    `).join("");
    panel.querySelectorAll(".search-select__option").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(filtered[Number(el.dataset.idx)]);
      });
    });
  }

  function pick(opt, { silent = false } = {}) {
    selected = opt || null;
    input.value = opt ? opt.label : "";
    container.classList.toggle("has-value", Boolean(opt));
    clearBtn.hidden = !allowClear || !opt;
    closePanel();
    if (!silent) onChange(opt ? opt.value : null, opt);
  }

  input.addEventListener("focus", openPanel);
  input.addEventListener("input", () => {
    if (selected) {
      selected = null;
      container.classList.remove("has-value");
      clearBtn.hidden = true;
      onChange(null, null);
    }
    openPanel();
  });

  input.addEventListener("keydown", (e) => {
    if (panel.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      openPanel();
      return;
    }
    if (panel.hidden) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, filtered.length - 1);
      renderPanel();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      renderPanel();
    } else if (e.key === "Enter") {
      if (highlighted >= 0 && filtered[highlighted]) {
        e.preventDefault();
        pick(filtered[highlighted]);
      }
    } else if (e.key === "Escape") {
      closePanel();
    }
  });

  clearBtn.addEventListener("click", () => {
    pick(null);
    input.focus();
  });

  // Sem isso, sair do campo com Tab (em vez de clicar fora ou apertar Esc)
  // deixava o painel de sugestões aberto flutuando sobre o próximo campo —
  // só fechava no clique seguinte em qualquer lugar da página. Não conflita
  // com o clique numa opção: o mousedown do option/clearBtn já usa
  // preventDefault (opção) ou é síncrono antes do reposicionamento do foco
  // (clearBtn), então blur() não interrompe a escolha.
  input.addEventListener("blur", closePanel);

  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) closePanel();
  });

  if (value != null) {
    const initial = findOption(value);
    if (initial) pick(initial, { silent: true });
  }

  return {
    getValue: () => (selected ? selected.value : null),
    setValue: (v) => pick(v == null ? null : findOption(v)),
    reset: () => pick(null),
    setOptions: (next) => {
      allOptions = next;
      if (selected && !findOption(selected.value)) pick(null);
    },
    focusInput: () => input.focus(),
  };
}

// ── Trava de ação em andamento ─────────────────────────────────────
//
// Clique duplo ou rede lenta em ações críticas (finalizar venda, registrar
// recebimento, agendar, salvar um cadastro) podia disparar a mesma chamada
// de rede duas vezes e gerar registros duplicados. Desabilita o botão pelo
// tempo da chamada.
export async function withButtonLock(button, task) {
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    await task();
  } finally {
    button.disabled = false;
  }
}

// ── Atualização automática ───────────────────────────────────────────
//
// Em vez de exigir F5, cada tela registra uma função de recarga que é
// chamada em intervalo e sempre que a aba volta a ficar em foco — pausada
// enquanto um modal está aberto ou o campo de busca está com foco, para
// não atrapalhar quem está digitando.

let stopCurrentAutoRefresh = null;

export function registerAutoRefresh(callback, interval = 15000) {
  stopAutoRefresh();

  const isBusy = () => document.hidden || !modalOverlay.hidden || document.activeElement?.classList.contains("search-select__input");
  const tick = () => {
    if (!isBusy()) callback();
  };
  const onFocus = () => {
    if (!isBusy()) callback();
  };

  const id = setInterval(tick, interval);
  window.addEventListener("focus", onFocus);

  stopCurrentAutoRefresh = () => {
    clearInterval(id);
    window.removeEventListener("focus", onFocus);
  };
}

export function stopAutoRefresh() {
  if (stopCurrentAutoRefresh) {
    stopCurrentAutoRefresh();
    stopCurrentAutoRefresh = null;
  }
}

// ── Transferência Agenda → Vendas/Matrículas ────────────────────────
//
// Quando um atendimento é confirmado na Agenda, a tela de destino abre
// pré-preenchida com os dados desse atendimento — o vínculo some assim
// que é lido (uso único), então voltar a abrir a tela depois não reaplica
// um atendimento antigo. Vendas ou Matrículas: agenda.js decide olhando o
// tipo do produto do agendamento (produto físico → Vendas, serviço →
// Matrículas).

let pendingVendaOrigem = null;

export function setVendaPrefill(data) {
  pendingVendaOrigem = data;
}

export function consumeVendaPrefill() {
  const data = pendingVendaOrigem;
  pendingVendaOrigem = null;
  return data;
}

let pendingMatriculaOrigem = null;

export function setMatriculaPrefill(data) {
  pendingMatriculaOrigem = data;
}

export function consumeMatriculaPrefill() {
  const data = pendingMatriculaOrigem;
  pendingMatriculaOrigem = null;
  return data;
}

// ── Exportação CSV ───────────────────────────────────────────────────
//
// Separador ";" (não ",") de propósito: no Excel em pt-BR a vírgula já é o
// separador decimal, então um CSV com vírgula abre tudo numa coluna só —
// ";" é o que o Excel BR espera nativamente, sem passar por "Texto para
// colunas". O BOM no início faz o Excel reconhecer UTF-8 (senão acentuação
// vem corrompida).

function escapeCsvValue(value) {
  const str = String(value ?? "");
  return /[";\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Número em formato pt-BR (vírgula decimal) para uma célula de CSV — usar
// em vez de formatCurrency porque o CSV não deve carregar o símbolo "R$"
// junto do valor.
export function formatCsvNumber(value) {
  return Number(value || 0).toFixed(2).replace(".", ",");
}

export function exportCsv(filename, headers, rows) {
  const linhas = [headers, ...rows].map((row) => row.map(escapeCsvValue).join(";"));
  const blob = new Blob(["﻿" + linhas.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Formatação ──────────────────────────────────────────────────────

export function formatCurrency(value) {
  const n = Number(value || 0);
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return d.toLocaleDateString("pt-BR");
}

export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR");
}

// ── Erros do Postgres ──────────────────────────────────────────────
//
// A maioria dos módulos renderizava error.message bruto do Postgres direto
// na tela do operador de caixa. Erros levantados pelas próprias RPCs (via
// `raise exception '...'`) já vêm em português e são exibidos como estão;
// este mapa cobre os códigos de erro genéricos do driver que apareceriam
// crus (violação de unicidade, chave estrangeira, RLS) quando ninguém tratou
// o caso especificamente.
const PG_ERROR_MESSAGES = {
  23505: "Já existe um registro com esses dados.",
  23503: "Não é possível concluir: existem registros vinculados a este item.",
  23502: "Preencha todos os campos obrigatórios.",
  42501: "Você não tem permissão para executar esta ação.",
};

export function friendlyPgError(error, overrides = {}) {
  if (!error) return "Ocorreu um erro inesperado.";
  return overrides[error.code] || PG_ERROR_MESSAGES[error.code] || error.message || "Ocorreu um erro inesperado.";
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}
