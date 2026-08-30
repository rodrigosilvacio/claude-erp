-- Produtos ganham um `tipo` (produto físico vs. serviço). Hoje qualquer
-- produto podia ser vendido pela Loja (dando baixa de estoque, inclusive em
-- cursos/serviços que não têm estoque físico) ou selecionado em Matrículas
-- (inclusive um produto físico, sem sentido nenhum de parcelamento). O
-- frontend passa a filtrar os seletores por tipo; aqui é a rede de segurança
-- no servidor — nenhuma baixa/devolução de estoque acontece para tipo
-- 'servico', não importa por qual tela o item chegou.
--
-- Aproveita a migration pra corrigir criar_venda: total = subtotal -
-- desconto não tinha clamp, então um desconto maior que o subtotal deixava
-- o total negativo no banco (a tela só escondia isso mostrando "R$ 0,00").

alter table public.produtos add column tipo text not null default 'produto' check (tipo in ('produto', 'servico'));
comment on column public.produtos.tipo is 'produto = item físico com controle de estoque; servico = curso/serviço vendido em Matrículas, nunca dá baixa de estoque.';

-- ── criar_venda: pula checagem/baixa de estoque pra tipo=servico; clamp do
-- total em >= 0 (mesmo racional de criar_matricula) ────────────────────────
create or replace function public.criar_venda(
  p_cliente_id uuid,
  p_data_venda date,
  p_forma_pagamento text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb,
  p_empresa_id uuid default null,
  p_status text default 'confirmada'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if p_status not in ('confirmada', 'aguardando_pagamento') then
    raise exception 'Status inicial de venda inválido: %', p_status;
  end if;

  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    raise exception 'A venda precisa ter ao menos um item';
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

  insert into public.vendas (empresa_id, cliente_id, data_venda, forma_pagamento, observacoes, subtotal, desconto, total, status)
  values (
    v_empresa_id, p_cliente_id, coalesce(p_data_venda, current_date), p_forma_pagamento, p_observacoes,
    v_subtotal, coalesce(p_desconto, 0), greatest(v_subtotal - coalesce(p_desconto, 0), 0), p_status
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

  return v_venda_id;
end;
$$;

revoke all on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text) from public;
grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text) to authenticated;

-- ── cancelar_venda: só devolve estoque de itens tipo=produto ────────────
create or replace function public.cancelar_venda(p_venda_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$$;

-- ── confirmar_pagamento_stripe: idem, baixa só itens tipo=produto ───────
create or replace function public.confirmar_pagamento_stripe(
  p_venda_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_item record;
  v_estoque_atual integer;
begin
  select status into v_status from public.vendas where id = p_venda_id for update;

  if v_status is null then
    raise exception 'Venda % não encontrada', p_venda_id;
  end if;

  if v_status = 'confirmada' then
    return;
  end if;

  if v_status <> 'aguardando_pagamento' then
    raise exception 'Venda % não está aguardando pagamento (status atual: %)', p_venda_id, v_status;
  end if;

  for v_item in
    select vi.produto_id, vi.quantidade, p.tipo
    from public.venda_itens vi
    join public.produtos p on p.id = vi.produto_id
    where vi.venda_id = p_venda_id
  loop
    if v_item.tipo <> 'produto' then
      continue;
    end if;

    select estoque into v_estoque_atual from public.produtos where id = v_item.produto_id for update;

    if v_estoque_atual is null or v_estoque_atual < v_item.quantidade then
      raise warning 'Estoque insuficiente para o produto % ao confirmar pagamento da venda % — pagamento já capturado, requer reconciliação manual', v_item.produto_id, p_venda_id;
    end if;

    update public.produtos set estoque = estoque - v_item.quantidade where id = v_item.produto_id;
  end loop;

  update public.vendas
  set status = 'confirmada',
      stripe_checkout_session_id = p_stripe_checkout_session_id,
      stripe_payment_intent_id = p_stripe_payment_intent_id
  where id = p_venda_id;
end;
$$;

-- ── criar_recebimento_manual / cancelar_recebimento_manual: mesmo ajuste
-- pro fluxo de recebimento avulso (Financeiro > Contas a Receber) ────────
create or replace function public.criar_recebimento_manual(
  p_produto_id uuid,
  p_quantidade integer,
  p_valor numeric,
  p_cliente_id uuid default null,
  p_forma_pagamento text default null,
  p_data_recebimento date default null,
  p_observacoes text default null,
  p_empresa_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recebimento_id uuid;
  v_empresa_id uuid;
  v_estoque_atual integer;
  v_produto_tipo text;
begin
  if p_produto_id is null then
    raise exception 'Selecione um produto para o recebimento.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Informe uma quantidade válida.';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa do recebimento.';
  end if;

  if p_cliente_id is not null then
    if not exists (select 1 from public.clientes where id = p_cliente_id and empresa_id = v_empresa_id) then
      raise exception 'Cliente não encontrado nesta empresa.';
    end if;
  end if;

  select estoque, tipo into v_estoque_atual, v_produto_tipo from public.produtos where id = p_produto_id and empresa_id = v_empresa_id for update;

  if v_produto_tipo is null then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  if v_produto_tipo = 'produto' and v_estoque_atual < p_quantidade then
    raise exception 'Estoque insuficiente para este produto: disponível %, solicitado %', v_estoque_atual, p_quantidade;
  end if;

  insert into public.recebimentos (empresa_id, cliente_id, produto_id, quantidade, valor, forma_pagamento, data_recebimento, observacoes, status)
  values (
    v_empresa_id, p_cliente_id, p_produto_id, p_quantidade, p_valor, p_forma_pagamento,
    coalesce(p_data_recebimento, current_date), p_observacoes, 'recebido'
  )
  returning id into v_recebimento_id;

  if v_produto_tipo = 'produto' then
    update public.produtos set estoque = estoque - p_quantidade where id = p_produto_id;
  end if;

  return v_recebimento_id;
end;
$$;

create or replace function public.cancelar_recebimento_manual(p_recebimento_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_empresa_id uuid;
  v_produto_id uuid;
  v_quantidade integer;
  v_produto_tipo text;
begin
  select r.status, r.empresa_id, r.produto_id, r.quantidade, p.tipo
    into v_status, v_empresa_id, v_produto_id, v_quantidade, v_produto_tipo
    from public.recebimentos r
    join public.produtos p on p.id = r.produto_id
    where r.id = p_recebimento_id for update;

  if v_status is null then
    raise exception 'Recebimento % não encontrado', p_recebimento_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para cancelar este recebimento.';
  end if;

  if v_status = 'cancelado' then
    return;
  end if;

  if v_produto_tipo = 'produto' then
    update public.produtos set estoque = estoque + v_quantidade where id = v_produto_id;
  end if;

  update public.recebimentos set status = 'cancelado' where id = p_recebimento_id;
end;
$$;
