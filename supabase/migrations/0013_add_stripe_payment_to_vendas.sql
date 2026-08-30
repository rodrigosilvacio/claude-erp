-- Pagamento via Stripe Checkout como forma de pagamento de vendas: fluxo
-- "link/QR" — o app gera uma Checkout Session, o cliente paga pelo próprio
-- celular (não coleta dados de cartão no app) e a venda só vira 'confirmada'
-- quando o webhook do Stripe confirma o pagamento. Diferente das outras
-- formas de pagamento (Dinheiro/Pix/Cartão/Boleto), que são só etiquetas —
-- aqui o dinheiro passa de fato pelo app, então o estoque só é baixado na
-- confirmação (não na criação), evitando reservar estoque de um pagamento
-- que pode nunca se concretizar.

alter table public.vendas drop constraint vendas_status_check;
alter table public.vendas add constraint vendas_status_check
  check (status in ('orcamento', 'confirmada', 'cancelada', 'aguardando_pagamento'));

alter table public.vendas add column stripe_checkout_session_id text;
alter table public.vendas add column stripe_payment_intent_id text;

comment on column public.vendas.stripe_checkout_session_id is 'Preenchido só na confirmação do pagamento (evento checkout.session.completed) — não existe enquanto a venda está aguardando_pagamento.';
comment on column public.vendas.stripe_payment_intent_id is 'Payment Intent do Stripe associado, preenchido junto com stripe_checkout_session_id.';

-- ── criar_venda: novo p_status ('confirmada' padrão, ou 'aguardando_pagamento'
-- para o fluxo Stripe) ───────────────────────────────────────────────────
-- Assinatura muda (8 params) — precisa dropar a de 7 explicitamente, senão
-- vira overload e chamadas antigas (sem p_status) ficam ambíguas entre as
-- duas versões. Mesmo problema já visto ao acrescentar p_empresa_id (ver
-- 0005/0006) — e a mesma correção: revoke de public/anon logo depois de
-- recriar, porque toda função nova nasce com EXECUTE liberado para PUBLIC.
drop function if exists public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid);

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
    v_subtotal, coalesce(p_desconto, 0), v_subtotal - coalesce(p_desconto, 0), p_status
  )
  returning id into v_venda_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;
    v_preco_unitario := (v_item->>'preco_unitario')::numeric;

    select estoque into v_estoque_atual from public.produtos where id = v_produto_id and empresa_id = v_empresa_id for update;

    if v_estoque_atual is null then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    if v_estoque_atual < v_quantidade then
      raise exception 'Estoque insuficiente para o produto %: disponível %, solicitado %', v_produto_id, v_estoque_atual, v_quantidade;
    end if;

    insert into public.venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    values (v_venda_id, v_produto_id, v_quantidade, v_preco_unitario, v_quantidade * v_preco_unitario);

    -- Pagamento Stripe pendente: reserva-se só a validação de estoque acima
    -- (barra checkout de um item já sem saldo). A baixa de fato só acontece
    -- em confirmar_pagamento_stripe, quando o pagamento é confirmado de
    -- verdade — do contrário um QR nunca escaneado deixaria estoque preso.
    if p_status = 'confirmada' then
      update public.produtos set estoque = estoque - v_quantidade where id = v_produto_id;
    end if;
  end loop;

  return v_venda_id;
end;
$$;

revoke all on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text) from public;
grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text) to authenticated;

-- ── cancelar_venda: só devolve estoque se ele foi de fato baixado ───────
-- Antes desta migration toda venda não-cancelada tinha vindo de criar_venda
-- com baixa imediata, então sempre devolver fazia sentido. Agora uma venda
-- 'aguardando_pagamento' pode ser cancelada (ex.: QR do Stripe expirou, ou
-- o operador desistiu) sem nunca ter baixado estoque — devolver nesse caso
-- inflaria o estoque incorretamente.
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
    for v_item in select produto_id, quantidade from public.venda_itens where venda_id = p_venda_id
    loop
      update public.produtos set estoque = estoque + v_item.quantidade where id = v_item.produto_id;
    end loop;
  end if;

  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$$;

-- ── confirmar_pagamento_stripe / marcar_stripe_pagamento_falhou ─────────
-- Chamadas só pelo webhook (edge function stripe-webhook), autenticado com
-- a service role — nunca pelo cliente, porque a única checagem de "o
-- pagamento realmente aconteceu" é ter chegado até aqui vindo do webhook
-- com assinatura do Stripe validada. Por isso EXECUTE vai só para
-- service_role, ao contrário de criar_venda/cancelar_venda.
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

  -- Idempotente: o Stripe pode reentregar o mesmo evento de webhook.
  if v_status = 'confirmada' then
    return;
  end if;

  if v_status <> 'aguardando_pagamento' then
    raise exception 'Venda % não está aguardando pagamento (status atual: %)', p_venda_id, v_status;
  end if;

  for v_item in select produto_id, quantidade from public.venda_itens where venda_id = p_venda_id
  loop
    select estoque into v_estoque_atual from public.produtos where id = v_item.produto_id for update;

    if v_estoque_atual is null or v_estoque_atual < v_item.quantidade then
      -- Caso raro: estoque acabou entre a criação do checkout e a confirmação
      -- do pagamento. O dinheiro já foi capturado pelo Stripe — fica
      -- registrado como confirmada mesmo assim (o item some do estoque,
      -- ficando negativo) para não perder o pagamento; exige reconciliação
      -- manual (estorno ou reposição), não há tentativa automática aqui.
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

revoke all on function public.confirmar_pagamento_stripe(uuid, text, text) from public;
grant execute on function public.confirmar_pagamento_stripe(uuid, text, text) to service_role;

create or replace function public.marcar_stripe_pagamento_falhou(p_venda_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.vendas where id = p_venda_id for update;

  if v_status is null then
    raise exception 'Venda % não encontrada', p_venda_id;
  end if;

  -- Idempotente / já resolvida por outro caminho (ex.: operador cancelou
  -- manualmente, ou outro evento do webhook já tratou) — não faz nada.
  if v_status <> 'aguardando_pagamento' then
    return;
  end if;

  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$$;

revoke all on function public.marcar_stripe_pagamento_falhou(uuid) from public;
grant execute on function public.marcar_stripe_pagamento_falhou(uuid) to service_role;
