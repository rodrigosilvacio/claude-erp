// ERPConnect — carregamento de catálogo (clientes ativos, produtos ativos,
// empresas) e mapeamento para o combo de busca (createSearchSelect). Extraído
// de vendas.js/financeiro.js/agenda.js, que reimplementavam a mesma consulta
// e o mesmo mapeamento de forma quase idêntica em cada tela.

import { supabase } from "./supabaseClient.js";
import { isAdmin } from "./auth.js";
import { formatCurrency, showToast, friendlyPgError } from "./app.js";

// Estas listas alimentam os combos de busca de 5 telas (Vendas, Agenda,
// Financeiro, Contas a Pagar, Matrículas) — antes uma falha de rede ou de
// RLS aqui fazia o combo aparecer vazio sem nenhum aviso, como se
// simplesmente não houvesse cadastro. Agora qualquer erro vira um toast, e
// a tela continua funcionando com a lista vazia (comportamento anterior),
// só que o operador sabe que algo deu errado em vez de estranhar o combo
// vazio.
function avisarErro(error) {
  if (error) showToast(friendlyPgError(error), "error");
}

export async function loadClientesAtivos() {
  const { data, error } = await supabase
    .from("clientes")
    .select("id, nome, documento, telefone, email")
    .eq("ativo", true)
    .eq("status_cadastro", "aprovado")
    .order("nome", { ascending: true });
  avisarErro(error);
  return data || [];
}

export async function loadProdutosAtivos(columns = "id, nome, sku, preco, estoque, tipo") {
  const { data, error } = await supabase.from("produtos").select(columns).eq("ativo", true).order("nome", { ascending: true });
  avisarErro(error);
  return data || [];
}

// Loja (vendas/entradas de estoque/recebimento manual) só deve oferecer
// produto físico — "serviço" não tem estoque e é vendido/parcelado só pela
// tela de Matrículas. Ver migration 0017 (produtos.tipo).
export async function loadProdutosVendaveis(columns) {
  return (await loadProdutosAtivos(columns)).filter((p) => p.tipo !== "servico");
}

// Matrículas só deve oferecer produto do tipo "serviço" — vender um produto
// físico parcelado por aqui não faz sentido (ele nunca dá baixa de estoque
// nesse fluxo).
export async function loadProdutosServicos(columns) {
  return (await loadProdutosAtivos(columns)).filter((p) => p.tipo === "servico");
}

// Só admins enxergam empresas de fora da própria — quem não é admin nem
// precisa da lista, já está implicitamente restrito à sua empresa.
export async function loadEmpresasAtivas() {
  if (!isAdmin()) return [];
  const { data, error } = await supabase.from("empresas").select("id, nome_fantasia, codigo").eq("ativo", true).order("nome_fantasia", { ascending: true });
  avisarErro(error);
  return data || [];
}

// Fornecedores não têm um dono único fixo por tela (Produtos filtra pelo
// formulário; Contas a Pagar filtra pelo período) — por isso recebe o
// empresa_id explícito em vez de resolver isAdmin()/getCurrentEmpresaId()
// sozinho, do jeito que loadEmpresasAtivas faz.
export async function loadFornecedoresPorEmpresa(empresaId) {
  if (!empresaId) return [];
  const { data, error } = await supabase
    .from("fornecedores")
    .select("id, nome")
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .order("nome", { ascending: true });
  avisarErro(error);
  return data || [];
}

export function fornecedorSearchOptions(fornecedores) {
  return fornecedores.map((f) => ({ value: f.id, label: f.nome }));
}

export function clienteSearchOptions(clientes) {
  return clientes.map((c) => ({ value: c.id, label: c.nome, meta: c.documento || "" }));
}

export function empresaSearchOptions(empresas) {
  return empresas.map((e) => ({ value: e.id, label: e.nome_fantasia, meta: e.codigo }));
}

// `meta` deixa cada tela decidir o que mostrar de complementar (Vendas e
// Financeiro mostram preço/estoque; Agenda só precisa do SKU).
export function produtoSearchOptions(produtos, { meta } = {}) {
  return produtos.map((p) => ({
    value: p.id,
    label: p.nome,
    meta: meta ? meta(p) : (p.sku || ""),
  }));
}

export const produtoMetaPrecoEstoque = (p) => `${formatCurrency(p.preco)} · estoque ${p.estoque}`;

// Matrículas vendem serviço (mensalidade), não produto físico — mostrar
// "estoque" ali confundiria o operador, por isso um meta só com o preço.
export const produtoMetaPreco = (p) => formatCurrency(p.preco);
