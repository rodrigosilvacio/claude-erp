// Versão exata pinada (mesmo motivo de manage-usuarios/oraculo-webhook): uma
// release nova do supabase-js não deve entrar em produção sem passar por um
// commit e revisão.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.5";

// AppVendas — comunicação proativa com o aluno (faixa roxa do roadmap):
// lembrete de aula no dia anterior e cobrança de parcela de matrícula
// vencida. Sem isso, o app era 100% reativo — nada avisava o aluno nem a
// equipe fora de alguém abrir o painel.
//
// Reaproveita a MESMA infra de WhatsApp/E-mail já usada pelo agente Oráculo
// (Z-API + Resend, ver oraculo-webhook) — não são secrets novas, é o mesmo
// número de WhatsApp conectado. Isso foi uma escolha deliberada (o
// roadmap já descrevia essa infra como "pronta, ociosa" para o AppVendas),
// não uma obrigação: se fizer mais sentido operacionalmente ter um número
// de WhatsApp Business dedicado ao AppVendas (separado do Oráculo, que dá
// conselhos pessoais), basta apontar ZAPI_INSTANCE_ID/ZAPI_TOKEN para uma
// instância própria — o código não assume nada além do que está nas secrets.
//
// Não tem cron embutido: esta function só processa o que encontrar quando é
// chamada. Precisa ser agendada por fora (Supabase Cron/pg_cron ou um
// scheduler externo apontando pra cá 1x por dia) — ver README, seção
// AppVendas, "Lembretes e cobranças (appvendas-lembretes)".
//
// Endpoint sem sessão de usuário (deploy com --no-verify-jwt, quem chama é o
// scheduler, não um cliente Supabase autenticado) — protegido só pelo
// `?secret=` na query string, mesmo padrão do oraculo-webhook.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ZAPI_INSTANCE_ID = Deno.env.get("ZAPI_INSTANCE_ID")!;
const ZAPI_TOKEN = Deno.env.get("ZAPI_TOKEN")!;
const ZAPI_CLIENT_TOKEN = Deno.env.get("ZAPI_CLIENT_TOKEN")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const APPVENDAS_LEMBRETES_SECRET = Deno.env.get("APPVENDAS_LEMBRETES_SECRET")!;

// Precisa ser um endereço de um domínio verificado no SEU Resend — o
// endereço sandbox onboarding@resend.dev só entrega de fato para o e-mail
// dono da conta Resend, então todo lembrete/cobrança para um cliente ou
// aluno real falharia com 403 (validation_error). Configure com
// `supabase secrets set RESEND_FROM_ADDRESS=notificacoes@seudominio.com`
// (ver scripts/README.md).
const RESEND_SANDBOX_ADDRESS = Deno.env.get("RESEND_FROM_ADDRESS") || "onboarding@resend.dev";
const RESEND_FROM_PADRAO = "ERPConnect";

// Bug corrigido: o nome de exibição do remetente era fixo ("BjjConnect",
// resquício de quando este app era mono-tenant) — todo e-mail automático
// chegava com esse nome, não importa a empresa. Agora cada rotina resolve o
// nome_aplicacao/nome_fantasia da empresa (mesma lógica já usada no
// assunto/corpo dos e-mails) e passa como remetente aqui.
function nomeRemetente(nome: string | null | undefined): string {
  const limpo = (nome || RESEND_FROM_PADRAO).replace(/[<>"]/g, "").trim();
  return limpo || RESEND_FROM_PADRAO;
}

// Uma parcela vencida só é cobrada de novo depois desse intervalo — evita
// mandar a mesma cobrança toda vez que o scheduler rodar (ex.: se agendado
// de hora em hora em vez de 1x por dia).
const COBRANCA_INTERVALO_DIAS = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function normalizarTelefone(input: unknown): string {
  return String(input ?? "").replace(/\D/g, "");
}

// Mesmo limiar usado implicitamente pelo Oráculo (DDI+DDD+número) — abaixo
// disso, é mais provável ser um telefone fixo incompleto ou lixo de
// cadastro do que um WhatsApp válido, então cai para e-mail (ou é ignorado).
const TELEFONE_MIN_DIGITOS = 10;

function formatCurrencyBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString("pt-BR");
}

function escapeHtml(str: unknown): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c] as string));
}

async function enviarMensagemZapi(phone: string, message: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
        body: JSON.stringify({ phone, message }),
      },
    );
    if (!res.ok) {
      console.error("Z-API send-text error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Falha ao chamar Z-API send-text:", err);
    return false;
  }
}

async function enviarEmail(to: string, subject: string, html: string, fromName = RESEND_FROM_PADRAO): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({ from: `${nomeRemetente(fromName)} <${RESEND_SANDBOX_ADDRESS}>`, to: [to], subject, html }),
    });
    if (!res.ok) {
      console.error("Resend error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Falha ao chamar Resend:", err);
    return false;
  }
}

// Manda por WhatsApp se houver telefone válido; senão por e-mail se houver
// e-mail; senão não manda nada. Retorna o canal usado (ou null) para o
// resumo da execução — não lança erro: falha de envio não deve interromper
// o processamento das próximas linhas.
async function notificar(
  telefone: string | null | undefined,
  email: string | null | undefined,
  mensagemWhatsapp: string,
  assuntoEmail: string,
  htmlEmail: string,
  fromName?: string,
): Promise<"whatsapp" | "email" | null> {
  const tel = normalizarTelefone(telefone);
  if (tel.length >= TELEFONE_MIN_DIGITOS) {
    const ok = await enviarMensagemZapi(tel, mensagemWhatsapp);
    if (ok) return "whatsapp";
  }
  if (email) {
    const ok = await enviarEmail(email, assuntoEmail, htmlEmail, fromName);
    if (ok) return "email";
  }
  return null;
}

type AgendamentoLembrete = {
  id: string;
  data_agendamento: string;
  horario: string;
  cliente: { nome: string; telefone: string | null; email: string | null } | null;
  produto: { nome: string } | null;
  empresa: { nome_fantasia: string; nome_aplicacao: string | null } | null;
};

async function processarLembretesDeAula(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ processados: number; enviados: number }> {
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  const amanhaKey = amanha.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("agendamentos")
    .select(
      "id, data_agendamento, horario, cliente:clientes(nome, telefone, email), produto:produtos(nome), empresa:empresas(nome_fantasia, nome_aplicacao)",
    )
    .eq("status", "agendado")
    .eq("data_agendamento", amanhaKey)
    .is("lembrete_enviado_em", null)
    .not("cliente_id", "is", null);

  if (error) {
    console.error("Erro ao buscar agendamentos para lembrete:", error);
    return { processados: 0, enviados: 0 };
  }

  const rows = (data ?? []) as AgendamentoLembrete[];
  let enviados = 0;

  for (const ag of rows) {
    const nome = ag.cliente?.nome ?? "aluno(a)";
    const academia = ag.empresa?.nome_aplicacao || ag.empresa?.nome_fantasia || RESEND_FROM_PADRAO;
    const produto = ag.produto?.nome ?? "sua aula";
    const hora = ag.horario.slice(0, 5);

    const mensagem =
      `Oi ${nome}! Lembrete da ${academia}: você tem ${produto} agendado(a) para amanhã ` +
      `(${formatDateBR(ag.data_agendamento)}) às ${hora}. Te esperamos! 🥋`;
    const htmlEmail = `<p>Oi ${nome}!</p><p>Lembrete da <strong>${academia}</strong>: você tem <strong>${produto}</strong> agendado(a) para amanhã (${
      formatDateBR(ag.data_agendamento)
    }) às <strong>${hora}</strong>.</p><p>Te esperamos!</p>`;

    const canal = await notificar(
      ag.cliente?.telefone,
      ag.cliente?.email,
      mensagem,
      `Lembrete: aula amanhã às ${hora}`,
      htmlEmail,
      academia,
    );
    if (canal) enviados++;

    // Marca como processado mesmo sem canal de contato disponível — sem
    // isso, um agendamento sem telefone/e-mail entraria de novo em toda
    // execução até a data passar.
    await supabase.from("agendamentos").update({ lembrete_enviado_em: new Date().toISOString() }).eq("id", ag.id);
  }

  return { processados: rows.length, enviados };
}

type ParcelaCobranca = {
  id: string;
  numero_parcela: number;
  valor: number;
  data_vencimento: string;
  cliente: { nome: string; telefone: string | null; email: string | null } | null;
  matricula: { numero: number; numero_parcelas: number; produto: { nome: string } | null } | null;
  empresa: { nome_fantasia: string; nome_aplicacao: string | null } | null;
};

async function processarCobrancasDeParcela(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ processados: number; enviados: number }> {
  const hoje = new Date().toISOString().slice(0, 10);
  const limiteReenvio = new Date(Date.now() - COBRANCA_INTERVALO_DIAS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("matricula_parcelas")
    .select(
      "id, numero_parcela, valor, data_vencimento, cliente:clientes(nome, telefone, email), matricula:matriculas(numero, numero_parcelas, produto:produtos(nome)), empresa:empresas(nome_fantasia, nome_aplicacao)",
    )
    .eq("status", "pendente")
    .lt("data_vencimento", hoje)
    .or(`cobranca_enviada_em.is.null,cobranca_enviada_em.lt.${limiteReenvio}`);

  if (error) {
    console.error("Erro ao buscar parcelas vencidas para cobrança:", error);
    return { processados: 0, enviados: 0 };
  }

  const rows = (data ?? []) as ParcelaCobranca[];
  let enviados = 0;

  for (const p of rows) {
    const nome = p.cliente?.nome ?? "aluno(a)";
    const academia = p.empresa?.nome_aplicacao || p.empresa?.nome_fantasia || RESEND_FROM_PADRAO;
    const produto = p.matricula?.produto?.nome ?? "sua matrícula";
    const totalParcelas = p.matricula?.numero_parcelas ?? "?";
    const valor = formatCurrencyBRL(Number(p.valor || 0));
    const vencimento = formatDateBR(p.data_vencimento);

    const mensagem =
      `Oi ${nome}! A parcela ${p.numero_parcela}/${totalParcelas} de ${produto} (${academia}), no valor de ${valor}, ` +
      `venceu em ${vencimento} e ainda está em aberto. Você pode regularizar na recepção — qualquer dúvida, é só chamar!`;
    const htmlEmail = `<p>Oi ${nome}!</p><p>A parcela <strong>${p.numero_parcela}/${totalParcelas}</strong> de <strong>${produto}</strong> (${academia}), no valor de <strong>${valor}</strong>, venceu em ${vencimento} e ainda está em aberto.</p><p>Você pode regularizar na recepção — qualquer dúvida, é só chamar!</p>`;

    const canal = await notificar(
      p.cliente?.telefone,
      p.cliente?.email,
      mensagem,
      `Parcela em aberto — vencimento ${vencimento}`,
      htmlEmail,
      academia,
    );
    if (canal) enviados++;

    await supabase.from("matricula_parcelas").update({ cobranca_enviada_em: new Date().toISOString() }).eq("id", p.id);
  }

  return { processados: rows.length, enviados };
}

// Roadmap conectividade — item 8: vendas de produto agora podem ser
// parceladas (venda_parcelas, migration 0042), que até então não tinha
// nenhuma cobrança automática de vencido — só matriculas tinha. Mesmo
// racional de processarCobrancasDeParcela, mudando só a tabela/join.
type ParcelaVendaCobranca = {
  id: string;
  numero_parcela: number;
  valor: number;
  data_vencimento: string;
  cliente: { nome: string; telefone: string | null; email: string | null } | null;
  venda: { numero: number } | null;
  empresa: { nome_fantasia: string; nome_aplicacao: string | null } | null;
};

async function processarCobrancasDeParcelaVenda(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ processados: number; enviados: number }> {
  const hoje = new Date().toISOString().slice(0, 10);
  const limiteReenvio = new Date(Date.now() - COBRANCA_INTERVALO_DIAS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("venda_parcelas")
    .select(
      "id, numero_parcela, valor, data_vencimento, cliente:clientes(nome, telefone, email), venda:vendas(numero), empresa:empresas(nome_fantasia, nome_aplicacao)",
    )
    .eq("status", "pendente")
    .lt("data_vencimento", hoje)
    .or(`cobranca_enviada_em.is.null,cobranca_enviada_em.lt.${limiteReenvio}`);

  if (error) {
    console.error("Erro ao buscar parcelas de venda vencidas para cobrança:", error);
    return { processados: 0, enviados: 0 };
  }

  const rows = (data ?? []) as ParcelaVendaCobranca[];
  let enviados = 0;

  for (const p of rows) {
    const nome = p.cliente?.nome ?? "cliente";
    const empresaNome = p.empresa?.nome_aplicacao || p.empresa?.nome_fantasia || RESEND_FROM_PADRAO;
    const numeroVenda = p.venda?.numero ?? "?";
    const valor = formatCurrencyBRL(Number(p.valor || 0));
    const vencimento = formatDateBR(p.data_vencimento);

    const mensagem =
      `Oi ${nome}! A parcela ${p.numero_parcela} da venda #${numeroVenda} (${empresaNome}), no valor de ${valor}, ` +
      `venceu em ${vencimento} e ainda está em aberto. Você pode regularizar — qualquer dúvida, é só chamar!`;
    const htmlEmail = `<p>Oi ${nome}!</p><p>A parcela <strong>${p.numero_parcela}</strong> da venda <strong>#${numeroVenda}</strong> (${empresaNome}), no valor de <strong>${valor}</strong>, venceu em ${vencimento} e ainda está em aberto.</p><p>Você pode regularizar — qualquer dúvida, é só chamar!</p>`;

    const canal = await notificar(
      p.cliente?.telefone,
      p.cliente?.email,
      mensagem,
      `Parcela em aberto — vencimento ${vencimento}`,
      htmlEmail,
      empresaNome,
    );
    if (canal) enviados++;

    await supabase.from("venda_parcelas").update({ cobranca_enviada_em: new Date().toISOString() }).eq("id", p.id);
  }

  return { processados: rows.length, enviados };
}

// Roadmap Fase 1 — item 4: mesmo racional de processarLembretesDeAula (dia
// anterior, marca como processado mesmo sem canal de envio), mas o
// destinatário aqui é a própria empresa (empresas.email), não um cliente —
// não faz sentido avisar o fornecedor que a empresa vai pagar ele. Várias
// contas vencendo amanhã na mesma empresa viram um e-mail só, agrupado.
type ContaPagarLembrete = {
  id: string;
  descricao: string;
  valor: number;
  data_vencimento: string;
  fornecedor: { nome: string } | null;
  empresa: { id: string; email: string | null; nome_fantasia: string; nome_aplicacao: string | null; dias_lembrete_vencimento: number | null } | null;
};

// "Dias de antecedência" (empresas.dias_lembrete_vencimento, configurável em
// Administração > Configurações) varia por empresa — não dá mais pra
// resolver com um único ".eq(data_vencimento, amanhã)". Em vez disso, busca
// uma janela ampla o bastante pra cobrir qualquer valor configurado
// razoável e filtra linha a linha pelo prazo de cada empresa.
const JANELA_MAX_DIAS_LEMBRETE = 30;

async function processarLembretesContasPagar(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ processados: number; enviados: number }> {
  const hoje = new Date();
  const hojeKey = hoje.toISOString().slice(0, 10);
  const limiteJanela = new Date(hoje);
  limiteJanela.setDate(limiteJanela.getDate() + JANELA_MAX_DIAS_LEMBRETE);
  const limiteJanelaKey = limiteJanela.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("contas_pagar")
    .select(
      "id, descricao, valor, data_vencimento, fornecedor:fornecedores(nome), empresa:empresas(id, email, nome_fantasia, nome_aplicacao, dias_lembrete_vencimento)",
    )
    .eq("status", "pendente")
    .gt("data_vencimento", hojeKey)
    .lte("data_vencimento", limiteJanelaKey)
    .is("lembrete_enviado_em", null);

  if (error) {
    console.error("Erro ao buscar contas a pagar para lembrete:", error);
    return { processados: 0, enviados: 0 };
  }

  const diasAte = (dataIso: string) =>
    Math.round((new Date(`${dataIso}T00:00:00`).getTime() - new Date(`${hojeKey}T00:00:00`).getTime()) / 86_400_000);

  const rows = ((data ?? []) as ContaPagarLembrete[])
    .filter((row) => diasAte(row.data_vencimento) === (row.empresa?.dias_lembrete_vencimento ?? 1));

  if (rows.length === 0) return { processados: 0, enviados: 0 };

  const porEmpresa = new Map<string, { empresa: ContaPagarLembrete["empresa"]; contas: ContaPagarLembrete[] }>();
  for (const row of rows) {
    const empresaId = row.empresa?.id;
    if (!empresaId) continue;
    if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, { empresa: row.empresa, contas: [] });
    porEmpresa.get(empresaId)!.contas.push(row);
  }

  let enviados = 0;

  for (const { empresa, contas } of porEmpresa.values()) {
    const nomeEmpresa = empresa?.nome_aplicacao || empresa?.nome_fantasia || RESEND_FROM_PADRAO;

    if (empresa?.email) {
      const dias = empresa.dias_lembrete_vencimento ?? 1;
      const prazo = dias === 1 ? "amanhã" : `em ${dias} dias`;
      const total = contas.reduce((soma, c) => soma + Number(c.valor || 0), 0);
      const linhas = contas
        .map((c) => `<li>${escapeHtml(c.descricao)} — ${escapeHtml(c.fornecedor?.nome || "Fornecedor")} — ${formatCurrencyBRL(Number(c.valor || 0))}</li>`)
        .join("");
      const html = `<p>Olá!</p><p>${contas.length === 1 ? "1 conta vence" : `${contas.length} contas vencem`} ${prazo} (${
        formatDateBR(contas[0].data_vencimento)
      }), totalizando <strong>${formatCurrencyBRL(total)}</strong>:</p><ul>${linhas}</ul><p>Confira em Financeiro → Contas a Pagar.</p>`;

      const ok = await enviarEmail(empresa.email, `Contas a pagar vencendo ${prazo} — ${nomeEmpresa}`, html, nomeEmpresa);
      if (ok) enviados += contas.length;
    }

    // Marca como processado mesmo sem e-mail cadastrado na empresa — sem
    // isso, entraria de novo em toda execução até a data passar (mesmo
    // racional das outras duas rotinas acima).
    await supabase.from("contas_pagar").update({ lembrete_enviado_em: new Date().toISOString() }).in("id", contas.map((c) => c.id));
  }

  return { processados: rows.length, enviados };
}

// Roadmap Fase 3 — "Alerta de proposta parada ou vencida": validade_ate é
// cadastrado desde a migration 0031 e nunca foi checado por nada — uma
// proposta podia passar da validade sem ninguém saber. Mesmo padrão de
// agrupamento por empresa de processarLembretesContasPagar; destinatário é
// a própria empresa (empresas.email), não o cliente/lead — é um alerta de
// gestão comercial, não uma cobrança.
//
// Dois motivos disparam o alerta, cada proposta só uma vez
// (lembrete_enviado_em):
//  - "vencida": tem validade_ate cadastrada e ela já passou, sem ter sido
//    aprovada nem reprovada.
//  - "parada": nunca chegou a ser enviada ao contato (ainda em rascunho)
//    depois de DIAS_PROPOSTA_PARADA dias — provavelmente esquecida.
const DIAS_PROPOSTA_PARADA = 15;

type PropostaAlerta = {
  id: string;
  numero: number;
  tipo_contato: string;
  lead_nome: string | null;
  data_proposta: string;
  validade_ate: string | null;
  status: string;
  total: number;
  cliente: { nome: string } | null;
  empresa: { id: string; email: string | null; nome_fantasia: string; nome_aplicacao: string | null } | null;
};

async function processarAlertaPropostas(
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<{ processados: number; enviados: number }> {
  const hoje = new Date();
  const hojeKey = hoje.toISOString().slice(0, 10);
  const limiteParada = new Date(hoje);
  limiteParada.setDate(limiteParada.getDate() - DIAS_PROPOSTA_PARADA);
  const limiteParadaKey = limiteParada.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("propostas")
    .select(
      "id, numero, tipo_contato, lead_nome, data_proposta, validade_ate, status, total, cliente:clientes(nome), empresa:empresas(id, email, nome_fantasia, nome_aplicacao)",
    )
    .in("status", ["draft", "enviada"])
    .is("lembrete_enviado_em", null)
    .limit(1000);

  if (error) {
    console.error("Erro ao buscar propostas para alerta:", error);
    return { processados: 0, enviados: 0 };
  }

  const comMotivo = ((data ?? []) as PropostaAlerta[])
    .map((p) => {
      const vencida = Boolean(p.validade_ate) && (p.validade_ate as string) < hojeKey;
      const parada = p.status === "draft" && p.data_proposta < limiteParadaKey;
      return { p, motivo: vencida ? "vencida" as const : parada ? "parada" as const : null };
    })
    .filter((x): x is { p: PropostaAlerta; motivo: "vencida" | "parada" } => x.motivo !== null);

  if (comMotivo.length === 0) return { processados: 0, enviados: 0 };

  const porEmpresa = new Map<string, { empresa: PropostaAlerta["empresa"]; itens: { p: PropostaAlerta; motivo: "vencida" | "parada" }[] }>();
  for (const item of comMotivo) {
    const empresaId = item.p.empresa?.id;
    if (!empresaId) continue;
    if (!porEmpresa.has(empresaId)) porEmpresa.set(empresaId, { empresa: item.p.empresa, itens: [] });
    porEmpresa.get(empresaId)!.itens.push(item);
  }

  let enviados = 0;

  for (const { empresa, itens } of porEmpresa.values()) {
    const nomeEmpresa = empresa?.nome_aplicacao || empresa?.nome_fantasia || RESEND_FROM_PADRAO;

    if (empresa?.email) {
      const linhas = itens
        .map(({ p, motivo }) => {
          const contato = p.tipo_contato === "cliente" ? (p.cliente?.nome || "Cliente") : (p.lead_nome || "Lead");
          const detalhe = motivo === "vencida"
            ? `venceu em ${formatDateBR(p.validade_ate!)}`
            : `em rascunho desde ${formatDateBR(p.data_proposta)}, nunca enviada`;
          return `<li>Proposta #${p.numero} — ${escapeHtml(contato)} — ${formatCurrencyBRL(Number(p.total || 0))} — ${detalhe}</li>`;
        })
        .join("");
      const html = `<p>Olá!</p><p>${itens.length === 1 ? "1 proposta precisa" : `${itens.length} propostas precisam`} de atenção:</p><ul>${linhas}</ul><p>Confira em Movimentações → CRM.</p>`;

      const ok = await enviarEmail(empresa.email, `Propostas paradas/vencidas — ${nomeEmpresa}`, html, nomeEmpresa);
      if (ok) enviados += itens.length;
    }

    // Marca como processado mesmo sem e-mail cadastrado na empresa — sem
    // isso, entraria de novo em toda execução até a proposta mudar de
    // status (mesmo racional das outras rotinas acima).
    await supabase.from("propostas").update({ lembrete_enviado_em: new Date().toISOString() }).in("id", itens.map(({ p }) => p.id));
  }

  return { processados: comMotivo.length, enviados };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== APPVENDAS_LEMBRETES_SECRET) {
    return json({ error: "Não autorizado." }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const [lembretes, cobrancas, cobrancasVenda, contasPagar, propostas] = await Promise.all([
    processarLembretesDeAula(supabase),
    processarCobrancasDeParcela(supabase),
    processarCobrancasDeParcelaVenda(supabase),
    processarLembretesContasPagar(supabase),
    processarAlertaPropostas(supabase),
  ]);

  return json({
    ok: true,
    lembretes_de_aula: lembretes,
    cobrancas_de_parcela: cobrancas,
    cobrancas_de_parcela_venda: cobrancasVenda,
    lembretes_de_contas_a_pagar: contasPagar,
    alertas_de_propostas: propostas,
  });
});
