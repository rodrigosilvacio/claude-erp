-- Excluir um agendamento era um DELETE de verdade — nenhum rastro de quem
-- cancelou o quê nem quando. Passa a ser um novo status 'cancelado' (mesmo
-- padrão de vendas/matrículas/contas), mantendo a linha no banco.
--
-- O índice único de slot (empresa_id, data_agendamento, horario) precisa
-- virar parcial (`where status <> 'cancelado'`): sem isso, cancelar um
-- agendamento não liberaria o horário pra um novo agendamento, porque a
-- linha cancelada continuaria "ocupando" o slot pro índice.

alter table public.agendamentos drop constraint agendamentos_status_check;
alter table public.agendamentos add constraint agendamentos_status_check
  check (status in ('agendado', 'atendido', 'cancelado'));

drop index public.agendamentos_slot_unico_idx;
create unique index agendamentos_slot_unico_idx on public.agendamentos (empresa_id, data_agendamento, horario)
  where status <> 'cancelado';
