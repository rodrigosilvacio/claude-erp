-- Roadmap Fase 1 — item 4: lembrete de conta a pagar vencendo, mesmo
-- racional de agendamentos.lembrete_enviado_em (migration 0021) — controla
-- que cada conta só recebe um lembrete, não um por execução do scheduler.
alter table public.contas_pagar
  add column lembrete_enviado_em timestamptz;
