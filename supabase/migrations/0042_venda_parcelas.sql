-- Vendas de produto não suportavam parcelamento — matriculas já tinha
-- matricula_parcelas completo (parcela/vencimento/pagamento), vendas não
-- tinha equivalente, então uma venda a prazo simplesmente não cabia no
-- modelo. venda_parcelas espelha matricula_parcelas (mesmo formato,
-- mesma RLS, mesmo racional de cobrança).

create table public.venda_parcelas (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references public.vendas(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id) on delete restrict,
  cliente_id uuid references public.clientes(id) on delete set null,
  numero_parcela integer not null,
  valor numeric(12,2) not null,
  data_vencimento date not null,
  data_pagamento date,
  forma_pagamento text,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'cancelado')),
  cobranca_enviada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.venda_parcelas is 'Parcelas de uma venda de produto vendida a prazo (opção "Parcelado" em criar_venda) — mesmo formato de matricula_parcelas, para reaproveitar fluxo de caixa projetado e cobrança de vencidos (appvendas-lembretes).';

create index idx_venda_parcelas_venda_id on public.venda_parcelas(venda_id);
create index idx_venda_parcelas_empresa_status on public.venda_parcelas(empresa_id, status, data_vencimento);

alter table public.venda_parcelas enable row level security;

create policy venda_parcelas_authenticated on public.venda_parcelas
  for all
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create trigger set_updated_at_venda_parcelas before update on public.venda_parcelas
  for each row execute function public.set_updated_at();

-- criar_venda ganha p_numero_parcelas (novo parâmetro trailing muda a
-- assinatura — precisa DROP explícito, senão vira um overload novo e
-- deixa a versão de 8 parâmetros órfã, ainda executável).
drop function if exists public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text);

create function public.criar_venda(
  p_cliente_id uuid,
  p_data_venda date,
  p_forma_pagamento text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb,
  p_empresa_id uuid default null,
  p_status text default 'confirmada',
  p_numero_parcelas integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_venda_id uuid;
  v_subtotal numeric(12,2) := 0;
  v_item jsonb;
  v_produto_id uuid;
  v_quantidade integer;
  v_preco_unitario numeric(12,2);
  v_estoque_atual integer;
  v_produto_tipo text;
  v_item_subtotal numeric(12,2);
  v_empresa_id uuid;
  v_total numeric(12,2);
  v_valor_parcela numeric(12,2);
  v_soma_parcelas numeric(12,2) := 0;
  v_valor_desta_parcela numeric(12,2);
  i integer;
begin
  if p_status not in ('confirmada', 'aguardando_pagamento') then
    raise exception 'Status inicial de venda inválido: %', p_status;
  end if;

  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    raise exception 'A venda precisa ter ao menos um item';
  end if;

  if p_numero_parcelas is not null and p_numero_parcelas > 1 then
    if p_cliente_id is null then
      raise exception 'Venda parcelada precisa de um cliente identificado.';
    end if;
    if p_status <> 'confirmada' then
      raise exception 'Só é possível parcelar uma venda confirmada.';
    end if;
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa da venda.';
  end if;

  if p_cliente_id is not null then
    if not exists (select 1 from public.clientes where id = p_cliente_id and empresa_id = v_empresa_id) then
      raise exception 'Cliente não encontrado nesta empresa.';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_item_subtotal := (v_item->>'quantidade')::integer * (v_item->>'preco_unitario')::numeric;
    v_subtotal := v_subtotal + v_item_subtotal;
  end loop;

  v_total := greatest(v_subtotal - coalesce(p_desconto, 0), 0);

  insert into public.vendas (empresa_id, cliente_id, data_venda, forma_pagamento, observacoes, subtotal, desconto, total, status, usuario_id)
  values (
    v_empresa_id, p_cliente_id, coalesce(p_data_venda, current_date), p_forma_pagamento, p_observacoes,
    v_subtotal, coalesce(p_desconto, 0), v_total, p_status, auth.uid()
  )
  returning id into v_venda_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;
    v_preco_unitario := (v_item->>'preco_unitario')::numeric;

    select estoque, tipo into v_estoque_atual, v_produto_tipo from public.produtos where id = v_produto_id and empresa_id = v_empresa_id for update;

    if v_produto_tipo is null then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    if v_produto_tipo = 'produto' and v_estoque_atual < v_quantidade then
      raise exception 'Estoque insuficiente para o produto %: disponível %, solicitado %', v_produto_id, v_estoque_atual, v_quantidade;
    end if;

    insert into public.venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    values (v_venda_id, v_produto_id, v_quantidade, v_preco_unitario, v_quantidade * v_preco_unitario);

    if p_status = 'confirmada' and v_produto_tipo = 'produto' then
      update public.produtos set estoque = estoque - v_quantidade where id = v_produto_id;
    end if;
  end loop;

  -- Parcelamento: todas as parcelas nascem pendentes com vencimento mensal
  -- a partir de 1 mês da venda (i=1..n) — ao contrário de matriculas (onde
  -- a 1ª parcela costuma ser a taxa de matrícula já paga na hora), aqui é
  -- uma venda a prazo genuína, nada foi pago ainda além do que já entrou
  -- em "vendas" como valor total.
  if p_numero_parcelas is not null and p_numero_parcelas > 1 then
    v_valor_parcela := round(v_total / p_numero_parcelas, 2);
    for i in 1..p_numero_parcelas loop
      v_valor_desta_parcela := case when i = p_numero_parcelas then v_total - v_soma_parcelas else v_valor_parcela end;

      insert into public.venda_parcelas (venda_id, empresa_id, cliente_id, numero_parcela, valor, data_vencimento, forma_pagamento, status)
      values (
        v_venda_id, v_empresa_id, p_cliente_id, i,
        v_valor_desta_parcela,
        public.add_months_clamped(coalesce(p_data_venda, current_date), i),
        p_forma_pagamento,
        'pendente'
      );

      v_soma_parcelas := v_soma_parcelas + v_valor_parcela;
    end loop;
  end if;

  return v_venda_id;
end;
$function$;

grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer) to authenticated;
revoke execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer) from anon;

-- cancelar_venda passa a cancelar também as parcelas pendentes (mesmo
-- racional de cancelar_matricula).
create or replace function public.cancelar_venda(p_venda_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
  v_empresa_id uuid;
  v_item record;
begin
  select status, empresa_id into v_status, v_empresa_id from public.vendas where id = p_venda_id for update;

  if v_status is null then
    raise exception 'Venda % não encontrada', p_venda_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para cancelar esta venda.';
  end if;

  if v_status = 'cancelada' then
    return;
  end if;

  if v_status = 'confirmada' then
    for v_item in
      select vi.produto_id, vi.quantidade, p.tipo
      from public.venda_itens vi
      join public.produtos p on p.id = vi.produto_id
      where vi.venda_id = p_venda_id
    loop
      if v_item.tipo = 'produto' then
        update public.produtos set estoque = estoque + v_item.quantidade where id = v_item.produto_id;
      end if;
    end loop;
  end if;

  update public.venda_parcelas set status = 'cancelado' where venda_id = p_venda_id and status = 'pendente';
  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$function$;

-- registrar_pagamento_parcela_venda: baixa manual de uma parcela de venda,
-- espelhando o que já existe para matricula_parcelas na tela Financeiro.
create or replace function public.registrar_pagamento_parcela_venda(p_parcela_id uuid, p_forma_pagamento text default null, p_data_pagamento date default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_status text;
begin
  select empresa_id, status into v_empresa_id, v_status from public.venda_parcelas where id = p_parcela_id for update;

  if v_empresa_id is null then
    raise exception 'Parcela não encontrada.';
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para baixar esta parcela.';
  end if;

  if v_status = 'pago' then
    return;
  end if;

  if v_status = 'cancelado' then
    raise exception 'Esta parcela foi cancelada e não pode ser paga.';
  end if;

  update public.venda_parcelas
  set status = 'pago',
      data_pagamento = coalesce(p_data_pagamento, current_date),
      forma_pagamento = coalesce(p_forma_pagamento, forma_pagamento)
  where id = p_parcela_id;
end;
$function$;

grant execute on function public.registrar_pagamento_parcela_venda(uuid, text, date) to authenticated;
revoke execute on function public.registrar_pagamento_parcela_venda(uuid, text, date) from anon;
