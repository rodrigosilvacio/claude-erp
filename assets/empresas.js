import { renderCadastro } from "./cadastro.js";

export async function render(view, actionsEl) {
  await renderCadastro(view, actionsEl, {
    table: "empresas",
    titleSingular: "Empresa",
    searchPlaceholder: "Buscar por código, nome fantasia ou cidade…",
    searchColumns: ["codigo", "nome_fantasia", "razao_social", "cidade"],
    orderBy: "nome_fantasia",
    columns: [
      { key: "codigo", label: "Código" },
      { key: "nome_fantasia", label: "Nome Fantasia" },
      { key: "cidade", label: "Cidade" },
      { key: "telefone", label: "Telefone" },
      {
        key: "ativo",
        label: "Status",
        render: (row) => `<span class="status status--${row.ativo ? "ativo" : "inativo"}">${row.ativo ? "Ativo" : "Inativo"}</span>`,
      },
    ],
    fields: [
      { key: "codigo", label: "Código da empresa", required: true },
      { key: "nome_fantasia", label: "Nome Fantasia", required: true },
      { key: "razao_social", label: "Razão Social", required: true, full: true },
      { key: "cep", label: "CEP", type: "cep", autofillMap: { logradouro: "endereco", localidade: "cidade", uf: "uf" } },
      { key: "endereco", label: "Endereço", full: true },
      { key: "cidade", label: "Cidade" },
      { key: "uf", label: "UF" },
      { key: "telefone", label: "Telefone" },
      { key: "email", label: "E-mail", type: "email" },
      { key: "ativo", label: "Empresa ativa", type: "checkbox", default: true, full: true },
    ],
  });
}
