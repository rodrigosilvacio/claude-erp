-- Roadmap Fase 3 — "Alerta de proposta parada ou vencida": validade_ate é
-- cadastrado desde a migration 0031 e nunca checado por nada — uma proposta
-- pode passar da validade sem ninguém saber. Mesmo racional de
-- contas_pagar.lembrete_enviado_em (migration 0035): controla que cada
-- proposta só gera um alerta, não um por execução do scheduler.
alter table public.propostas
  add column lembrete_enviado_em timestamptz;

comment on column public.propostas.lembrete_enviado_em is 'Marcado quando o alerta de proposta vencida/parada (appvendas-lembretes) já foi enviado para esta proposta — evita reenvio a cada execução do scheduler.';
