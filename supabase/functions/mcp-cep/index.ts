// Servidor MCP (Model Context Protocol) remoto, via Streamable HTTP.
// Expõe a ferramenta `consultar_cep`, que reaproveita a lógica de cep.js
// (consulta ao ViaCEP) para que outras soluções (agentes, MCPs clients,
// etc.) possam resolver CEPs brasileiros sem reimplementar a integração.
//
// Endpoint público, sem autenticação (mesma decisão de share-report).
const PROTOCOL_VERSION = "2025-06-18";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOOL_NAME = "consultar_cep";

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Consulta um CEP brasileiro e retorna o endereço correspondente " +
    "(logradouro, bairro, cidade, UF, código IBGE, DDD) usando o ViaCEP.",
  inputSchema: {
    type: "object",
    properties: {
      cep: {
        type: "string",
        description:
          "CEP com 8 dígitos, com ou sem formatação (ex: \"01001000\" ou \"01001-000\").",
      },
    },
    required: ["cep"],
  },
};

function normalizeCep(input: unknown): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length !== 8) {
    throw new Error(`CEP inválido: "${input}". Informe 8 dígitos, ex: 01001000 ou 01001-000.`);
  }
  return digits;
}

async function consultarCep(cepInput: unknown): Promise<Record<string, unknown>> {
  const cep = normalizeCep(cepInput);
  const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
  if (!res.ok) {
    throw new Error(`Falha na requisição ao ViaCEP (status ${res.status}).`);
  }
  const data = await res.json();
  if (data.erro) {
    throw new Error(`CEP ${cep} não encontrado.`);
  }
  return data;
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(message: Record<string, unknown>) {
  const { id, method, params } = message as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-cep", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null; // notificação, sem resposta

    case "tools/list":
      return jsonRpcResult(id, { tools: [TOOL_DEFINITION] });

    case "tools/call": {
      const toolName = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      if (toolName !== TOOL_NAME) {
        return jsonRpcError(id, -32602, `Ferramenta desconhecida: "${toolName}".`);
      }

      try {
        const endereco = await consultarCep(args.cep);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(endereco, null, 2) }],
          isError: false,
        });
      } catch (err) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }

    case "ping":
      return jsonRpcResult(id, {});

    default:
      return jsonRpcError(id, -32601, `Método não suportado: "${method}".`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify(jsonRpcError(null, -32700, "Parse error: corpo JSON inválido.")),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const response = await handleRequest(body as Record<string, unknown>);

  if (response === null) {
    // Notificação (sem id): nada a responder.
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
