-- Corrige dois bugs introduzidos pela migração de multiempresas (0005),
-- reconstruídos a partir do estado ao vivo do banco (migração real
-- 20260714133400 / fix_multiempresa_unique_constraints_and_grants):
--
-- 1. Índices únicos globais em vez de por empresa: um horário de
--    agendamento ou um SKU de produto usado por uma empresa ficava
--    indisponível para as demais.
-- 2. Recriar `criar_venda` com uma assinatura nova (p_empresa_id) reabriu o
--    EXECUTE padrão para `anon`/`public`, quando só `authenticated` deveria
--    poder chamar a função.

-- ── Slot de agendamento único por empresa ───────────────────────────────
drop index if exists public.agendamentos_slot_unico_idx;
create unique index agendamentos_slot_unico_idx on public.agendamentos (empresa_id, data_agendamento, horario);

-- ── SKU de produto único por empresa ────────────────────────────────────
drop index if exists public.produtos_sku_idx;
create unique index produtos_sku_idx on public.produtos (empresa_id, sku)
  where sku is not null and sku <> '';

-- ── Fechar EXECUTE de criar_venda para anon/public ──────────────────────
revoke execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid) from public;
revoke execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid) from anon;
grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid) to authenticated;
