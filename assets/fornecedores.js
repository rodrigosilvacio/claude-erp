import { renderCadastro } from "./cadastro.js";

export async function render(view, actionsEl) {
  await renderCadastro(view, actionsEl, {
    table: "fornecedores",
    titleSingular: "Fornecedor",
    searchPlaceholder: "Buscar por nome, documento ou cidade…",
    searchColumns: ["nome", "documento", "cidade"],
    orderBy: "nome",
    scopeByEmpresa: true,
    columns: [
      { key: "nome", label: "Nome" },
      { key: "documento", label: "CNPJ" },
      { key: "telefone", label: "Telefone" },
      { key: "cidade", label: "Cidade" },
      {
        key: "ativo",
        label: "Status",
        render: (row) => `<span class="status status--${row.ativo ? "ativo" : "inativo"}">${row.ativo ? "Ativo" : "Inativo"}</span>`,
      },
    ],
    fields: [
      { key: "nome", label: "Razão social", required: true, full: true },
      { key: "documento", label: "CNPJ" },
      { key: "email", label: "E-mail", type: "email" },
      { key: "telefone", label: "Telefone" },
      { key: "cidade", label: "Cidade" },
      { key: "uf", label: "UF" },
      { key: "endereco", label: "Endereço", full: true },
      { key: "ativo", label: "Fornecedor ativo", type: "checkbox", default: true, full: true },
    ],
  });
}
