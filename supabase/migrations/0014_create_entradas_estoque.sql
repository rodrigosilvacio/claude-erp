-- Movimentações > Estoques: entrada de estoque como lançamento auditável
-- (produto + quantidade + data), em vez de editar o número de "Estoque
-- atual" direto no cadastro do Produto (perdia o histórico de quando/quanto
-- entrou). O saldo em produtos.estoque continua sendo a soma corrente —
-- só passa a ser ajustado por aqui (e pela baixa de vendas confirmadas),
-- nunca mais digitado à mão.

create table public.entradas_estoque (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  produto_id uuid not null references public.produtos(id),
  quantidade integer not null check (quantidade > 0),
  data_entrada date not null default current_date,
  observacoes text,
  created_at timestamptz not null default now()
);

create index entradas_estoque_empresa_data_idx on public.entradas_estoque (empresa_id, data_entrada);
create index entradas_estoque_produto_id_idx on public.entradas_estoque (produto_id);

create trigger entradas_estoque_set_empresa_id
  before insert on public.entradas_estoque
  for each row execute function public.set_empresa_id();

alter table public.entradas_estoque enable row level security;

-- Mesmo padrão de vendas/contas_pagar: RLS isola por empresa, a validação
-- de negócio (produto pertence à empresa, quantidade > 0, baixa no saldo)
-- fica nas RPCs abaixo — o cliente sempre passa por elas.
create policy "entradas_estoque_authenticated" on public.entradas_estoque for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── registrar_entrada_estoque ────────────────────────────────────────────
create or replace function public.registrar_entrada_estoque(
  p_produto_id uuid,
  p_quantidade integer,
  p_data_entrada date default null,
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
  v_produto_empresa_id uuid;
  v_entrada_id uuid;
begin
  if p_produto_id is null then
    raise exception 'Selecione um produto.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Informe uma quantidade válida (maior que zero).';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa desta entrada.';
  end if;

  -- Lock na linha do produto: evita duas entradas simultâneas do mesmo
  -- produto perderem uma atualização de estoque (mesmo cuidado de
  -- criar_venda/confirmar_pagamento_stripe).
  select empresa_id into v_produto_empresa_id from public.produtos where id = p_produto_id for update;

  if v_produto_empresa_id is null then
    raise exception 'Produto não encontrado.';
  end if;

  if v_produto_empresa_id <> v_empresa_id then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  insert into public.entradas_estoque (empresa_id, produto_id, quantidade, data_entrada, observacoes)
  values (v_empresa_id, p_produto_id, p_quantidade, coalesce(p_data_entrada, current_date), nullif(trim(p_observacoes), ''))
  returning id into v_entrada_id;

  update public.produtos set estoque = estoque + p_quantidade where id = p_produto_id;

  return v_entrada_id;
end;
$$;

revoke all on function public.registrar_entrada_estoque(uuid, integer, date, text, uuid) from public;
grant execute on function public.registrar_entrada_estoque(uuid, integer, date, text, uuid) to authenticated;

-- ── excluir_entrada_estoque: reverte a baixa no saldo antes de remover ──
-- Corrige lançamento errado (produto/quantidade digitados errado) sem
-- deixar o saldo do produto inflado pela entrada removida.
create or replace function public.excluir_entrada_estoque(p_entrada_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_produto_id uuid;
  v_quantidade integer;
begin
  select empresa_id, produto_id, quantidade into v_empresa_id, v_produto_id, v_quantidade
  from public.entradas_estoque where id = p_entrada_id for update;

  if v_produto_id is null then
    raise exception 'Entrada de estoque não encontrada.';
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para excluir esta entrada.';
  end if;

  update public.produtos set estoque = estoque - v_quantidade where id = v_produto_id;
  delete from public.entradas_estoque where id = p_entrada_id;
end;
$$;

revoke all on function public.excluir_entrada_estoque(uuid) from public;
grant execute on function public.excluir_entrada_estoque(uuid) to authenticated;
