-- CRM (Propostas) → Vendas: liga uma proposta aprovada à venda gerada a
-- partir dela, pra nunca existir uma proposta aprovada "solta" sem se saber
-- se virou negócio de fato ou não. `venda_id` nulo = aprovada e ainda não
-- convertida; preenchido = convertida (crm.js mostra os dois estados na
-- mesma pill "Aprovada", sem inventar um status novo pra isso — ver README).
alter table public.propostas
  add column venda_id uuid references public.vendas(id) on delete set null,
  add column convertida_em timestamptz;

create index propostas_venda_id_idx on public.propostas (venda_id);
