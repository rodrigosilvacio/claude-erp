-- AppVendas: cadastros (clientes, produtos, fornecedores) e movimentação de vendas.
-- Mesmo padrão do restante do repo: acesso público (anon key), sem login,
-- pensado para piloto interno (ver 0003_disable_auth_requirement.sql para o
-- mesmo racional aplicado ao Reports Panel).

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── Clientes ────────────────────────────────────────────────────────────
create table public.clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  documento text,
  email text,
  telefone text,
  endereco text,
  cidade text,
  uf text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clientes_nome_idx on public.clientes (nome);

create trigger clientes_set_updated_at
  before update on public.clientes
  for each row execute function public.set_updated_at();

-- ── Fornecedores ────────────────────────────────────────────────────────
create table public.fornecedores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  documento text,
  email text,
  telefone text,
  endereco text,
  cidade text,
  uf text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fornecedores_nome_idx on public.fornecedores (nome);

create trigger fornecedores_set_updated_at
  before update on public.fornecedores
  for each row execute function public.set_updated_at();

-- ── Produtos ────────────────────────────────────────────────────────────
create table public.produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  sku text,
  categoria text,
  descricao text,
  preco numeric(12,2) not null default 0,
  custo numeric(12,2) not null default 0,
  estoque integer not null default 0,
  estoque_minimo integer not null default 0,
  fornecedor_id uuid references public.fornecedores(id) on delete set null,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index produtos_sku_idx on public.produtos (sku) where sku is not null and sku <> '';
create index produtos_nome_idx on public.produtos (nome);
create index produtos_fornecedor_id_idx on public.produtos (fornecedor_id);

create trigger produtos_set_updated_at
  before update on public.produtos
  for each row execute function public.set_updated_at();

-- ── Vendas (cabeçalho) ──────────────────────────────────────────────────
create table public.vendas (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  cliente_id uuid references public.clientes(id) on delete restrict,
  data_venda date not null default current_date,
  status text not null default 'confirmada' check (status in ('orcamento', 'confirmada', 'cancelada')),
  forma_pagamento text,
  observacoes text,
  subtotal numeric(12,2) not null default 0,
  desconto numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index vendas_cliente_id_idx on public.vendas (cliente_id);
create index vendas_data_venda_idx on public.vendas (data_venda desc);
create index vendas_status_idx on public.vendas (status);

create trigger vendas_set_updated_at
  before update on public.vendas
  for each row execute function public.set_updated_at();

-- ── Itens da venda (movimentação de estoque) ───────────────────────────
create table public.venda_itens (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references public.vendas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  quantidade integer not null check (quantidade > 0),
  preco_unitario numeric(12,2) not null,
  subtotal numeric(12,2) not null,
  created_at timestamptz not null default now()
);

create index venda_itens_venda_id_idx on public.venda_itens (venda_id);
create index venda_itens_produto_id_idx on public.venda_itens (produto_id);

-- ── RLS: acesso público (anon), mesmo racional da migration 0003 ───────
alter table public.clientes enable row level security;
alter table public.fornecedores enable row level security;
alter table public.produtos enable row level security;
alter table public.vendas enable row level security;
alter table public.venda_itens enable row level security;

create policy "Public full access" on public.clientes for all to public using (true) with check (true);
create policy "Public full access" on public.fornecedores for all to public using (true) with check (true);
create policy "Public full access" on public.produtos for all to public using (true) with check (true);
create policy "Public full access" on public.vendas for all to public using (true) with check (true);
create policy "Public full access" on public.venda_itens for all to public using (true) with check (true);

-- ── criar_venda: cria a venda + itens e dá baixa no estoque de forma
-- atômica (tudo dentro da mesma transação da função). Lança exceção e
-- desfaz tudo se algum produto não tiver estoque suficiente.
create or replace function public.criar_venda(
  p_cliente_id uuid,
  p_data_venda date,
  p_forma_pagamento text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb
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
begin
  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    raise exception 'A venda precisa ter ao menos um item';
  end if;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_item_subtotal := (v_item->>'quantidade')::integer * (v_item->>'preco_unitario')::numeric;
    v_subtotal := v_subtotal + v_item_subtotal;
  end loop;

  insert into public.vendas (cliente_id, data_venda, forma_pagamento, observacoes, subtotal, desconto, total, status)
  values (
    p_cliente_id,
    coalesce(p_data_venda, current_date),
    p_forma_pagamento,
    p_observacoes,
    v_subtotal,
    coalesce(p_desconto, 0),
    v_subtotal - coalesce(p_desconto, 0),
    'confirmada'
  )
  returning id into v_venda_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;
    v_preco_unitario := (v_item->>'preco_unitario')::numeric;

    select estoque into v_estoque_atual from public.produtos where id = v_produto_id for update;

    if v_estoque_atual is null then
      raise exception 'Produto % não encontrado', v_produto_id;
    end if;

    if v_estoque_atual < v_quantidade then
      raise exception 'Estoque insuficiente para o produto %: disponível %, solicitado %', v_produto_id, v_estoque_atual, v_quantidade;
    end if;

    insert into public.venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    values (v_venda_id, v_produto_id, v_quantidade, v_preco_unitario, v_quantidade * v_preco_unitario);

    update public.produtos set estoque = estoque - v_quantidade where id = v_produto_id;
  end loop;

  return v_venda_id;
end;
$$;

grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb) to anon, authenticated;

-- ── cancelar_venda: marca a venda como cancelada e devolve o estoque
-- reservado por ela. Idempotente: não faz nada se já estiver cancelada.
create or replace function public.cancelar_venda(p_venda_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_item record;
begin
  select status into v_status from public.vendas where id = p_venda_id for update;

  if v_status is null then
    raise exception 'Venda % não encontrada', p_venda_id;
  end if;

  if v_status = 'cancelada' then
    return;
  end if;

  for v_item in select produto_id, quantidade from public.venda_itens where venda_id = p_venda_id
  loop
    update public.produtos set estoque = estoque + v_item.quantidade where id = v_item.produto_id;
  end loop;

  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$$;

grant execute on function public.cancelar_venda(uuid) to anon, authenticated;
