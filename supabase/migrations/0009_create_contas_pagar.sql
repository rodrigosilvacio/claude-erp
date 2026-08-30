-- Financeiro > Contas a Pagar: complementa o Contas a Receber já existente,
-- dando a Fornecedores uma movimentação financeira (hoje é só cadastro).
-- Mesmo padrão de lançamento manual usado em `recebimentos`/
-- `criar_recebimento_manual`, mas sem baixa de estoque — pagar um
-- fornecedor não é o mesmo evento que vender ou receber um produto.

create table public.contas_pagar (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  fornecedor_id uuid not null references public.fornecedores(id),
  descricao text not null,
  valor numeric(12,2) not null check (valor > 0),
  data_vencimento date not null,
  data_pagamento date,
  forma_pagamento text,
  observacoes text,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contas_pagar_empresa_vencimento_idx on public.contas_pagar (empresa_id, data_vencimento);
create index contas_pagar_fornecedor_id_idx on public.contas_pagar (fornecedor_id);

create trigger contas_pagar_set_updated_at
  before update on public.contas_pagar
  for each row execute function public.set_updated_at();

create trigger contas_pagar_set_empresa_id
  before insert on public.contas_pagar
  for each row execute function public.set_empresa_id();

alter table public.contas_pagar enable row level security;

create policy "contas_pagar_authenticated" on public.contas_pagar for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── criar_conta_pagar ────────────────────────────────────────────────────
create or replace function public.criar_conta_pagar(
  p_fornecedor_id uuid,
  p_descricao text,
  p_valor numeric,
  p_data_vencimento date,
  p_forma_pagamento text default null,
  p_observacoes text default null,
  p_empresa_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_conta_id uuid;
begin
  if p_fornecedor_id is null then
    raise exception 'Selecione um fornecedor.';
  end if;

  if p_descricao is null or trim(p_descricao) = '' then
    raise exception 'Informe uma descrição para esta conta.';
  end if;

  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe um valor válido.';
  end if;

  if p_data_vencimento is null then
    raise exception 'Informe a data de vencimento.';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa desta conta.';
  end if;

  if not exists (select 1 from public.fornecedores where id = p_fornecedor_id and empresa_id = v_empresa_id) then
    raise exception 'Fornecedor não encontrado nesta empresa.';
  end if;

  insert into public.contas_pagar (empresa_id, fornecedor_id, descricao, valor, data_vencimento, forma_pagamento, observacoes, status)
  values (v_empresa_id, p_fornecedor_id, trim(p_descricao), p_valor, p_data_vencimento, p_forma_pagamento, p_observacoes, 'pendente')
  returning id into v_conta_id;

  return v_conta_id;
end;
$$;

grant execute on function public.criar_conta_pagar(uuid, text, numeric, date, text, text, uuid) to authenticated;

-- ── registrar_pagamento_conta_pagar ──────────────────────────────────────
create or replace function public.registrar_pagamento_conta_pagar(
  p_conta_id uuid,
  p_data_pagamento date default null,
  p_forma_pagamento text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_empresa_id uuid;
begin
  select status, empresa_id into v_status, v_empresa_id from public.contas_pagar where id = p_conta_id for update;

  if v_status is null then
    raise exception 'Conta a pagar % não encontrada', p_conta_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para alterar esta conta.';
  end if;

  if v_status <> 'pendente' then
    raise exception 'Esta conta já foi paga ou cancelada.';
  end if;

  update public.contas_pagar
  set status = 'pago',
      data_pagamento = coalesce(p_data_pagamento, current_date),
      forma_pagamento = coalesce(p_forma_pagamento, forma_pagamento)
  where id = p_conta_id;
end;
$$;

grant execute on function public.registrar_pagamento_conta_pagar(uuid, date, text) to authenticated;

-- ── cancelar_conta_pagar: idempotente, mesmo padrão de cancelar_venda ────
create or replace function public.cancelar_conta_pagar(p_conta_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_empresa_id uuid;
begin
  select status, empresa_id into v_status, v_empresa_id from public.contas_pagar where id = p_conta_id for update;

  if v_status is null then
    raise exception 'Conta a pagar % não encontrada', p_conta_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para cancelar esta conta.';
  end if;

  if v_status = 'cancelado' then
    return;
  end if;

  update public.contas_pagar set status = 'cancelado' where id = p_conta_id;
end;
$$;

grant execute on function public.cancelar_conta_pagar(uuid) to authenticated;
