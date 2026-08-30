-- Faixa roxa do roadmap AppVendas: comunicação proativa com o aluno
-- (lembrete de aula, cobrança de parcela vencida) e check-in de presença
-- independente de cobrança.
--
-- Colunas de controle de envio (evitam reenviar o mesmo lembrete/cobrança
-- toda vez que a function `appvendas-lembretes` rodar): um agendamento só
-- recebe lembrete uma vez; uma parcela vencida só é cobrada de novo depois
-- de um intervalo mínimo (ver AVISO_REPETICAO_DIAS na function).
alter table public.agendamentos add column lembrete_enviado_em timestamptz;
alter table public.matricula_parcelas add column cobranca_enviada_em timestamptz;

comment on column public.agendamentos.lembrete_enviado_em is 'Preenchido pela edge function appvendas-lembretes quando o lembrete de aula (véspera) é enviado — evita reenviar para o mesmo agendamento.';
comment on column public.matricula_parcelas.cobranca_enviada_em is 'Última vez que uma cobrança de parcela vencida foi enviada pela edge function appvendas-lembretes — permite reenviar após um intervalo mínimo, sem repetir a cada execução.';

-- Check-in de presença: registro de frequência independente do status
-- agendado/atendido/cancelado, que hoje está atrelado a gerar uma venda ou
-- matrícula (ver agenda.js). Um aluno pode ter comparecido à aula mesmo sem
-- nenhuma cobrança associada àquele horário específico.
alter table public.agendamentos add column presenca_confirmada boolean not null default false;
alter table public.agendamentos add column presenca_confirmada_em timestamptz;

comment on column public.agendamentos.presenca_confirmada is 'Check-in de frequência do aluno na aula, independente de o agendamento ter virado venda/matrícula (status agendado/atendido) — controla presença, não cobrança.';
