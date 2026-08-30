// Consulta de CEP via o servidor MCP remoto (mcp-cep), que reaproveita o
// ViaCEP. Chamado tanto pelo cadastro de clientes (autenticado) quanto pela
// tela pública de pré-cadastro — por isso fica num módulo próprio, sem
// depender de app.js/auth.js (só de SUPABASE_URL, pra apontar pro projeto
// certo sem precisar hardcodar o domínio de novo aqui).

import { SUPABASE_URL } from "./supabaseClient.js";

const MCP_CEP_URL = `${SUPABASE_URL}/functions/v1/mcp-cep`;

export async function consultarCep(cepRaw) {
  const cep = String(cepRaw ?? "").replace(/\D/g, "");
  if (cep.length !== 8) {
    throw new Error("CEP deve ter 8 dígitos.");
  }

  const res = await fetch(MCP_CEP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "consultar_cep", arguments: { cep } },
    }),
  });

  if (!res.ok) {
    throw new Error("Não foi possível consultar o CEP agora. Tente novamente.");
  }

  const payload = await res.json();
  const result = payload.result;
  const text = result?.content?.[0]?.text;

  if (!text) {
    throw new Error("Não foi possível consultar o CEP agora. Tente novamente.");
  }

  if (result.isError) {
    throw new Error(text);
  }

  return JSON.parse(text);
}
