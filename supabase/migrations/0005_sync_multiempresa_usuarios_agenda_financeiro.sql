-- Reconstrução, a partir de introspecção ao vivo do banco de produção em
-- 2026-07-14, das mudanças de schema que foram aplicadas diretamente no
-- projeto Supabase (via painel/MCP) e nunca chegaram a ser commitadas neste
-- repositório. Este arquivo NÃO é uma reprodução literal de cada migração
-- histórica abaixo — é um snapshot consolidado do estado final do schema
-- resultante delas, reconstruído via pg_get_functiondef/pg_policies/
-- pg_indexes/information_schema. As 14 migrações reais, na ordem em que
-- rodaram contra o banco (ver `list_migrations`), foram:
--
--   20260711202417  create_appvendas_schema                       (= 0004 já commitado)
--   20260711223610  appvendas_usuarios_e_rls
--   20260711223629  appvendas_lock_function_execute_grants
--   20260711233615  appvendas_pre_cadastro_clientes
--   20260711235203  appvendas_clientes_cep
--   20260711235234  appvendas_drop_old_pre_cadastro_overload
--   20260712000822  appvendas_agendamentos
--   20260714015439  multiempresas_empresas_table_and_scoping
--   20260714015512  drop_stale_criar_venda_overload
--   20260714020022  fix_pre_cadastro_cliente_empresa_id
--   20260714020034  drop_stale_pre_cadastro_cliente_overload
--   20260714020047  index_empresa_id_columns
--   20260714115254  create_recebimentos_manuais
--   20260714115340  restrict_recebimentos_manuais_rpc_to_authenticated
--
-- A partir daqui, todo schema do AppVendas deve evoluir por migração
-- versionada neste diretório — nada de mudança direta em produção.
--
-- Este arquivo captura o estado ANTES das correções de 2026-07-14 aplicadas
-- em 0006/0007 (índices únicos globais em vez de por empresa, grant de
-- anon reaberto em criar_venda) — propositalmente, para que o histórico de
-- migrações do repo reflita a mesma sequência de bug → fix que aconteceu de
-- fato em produção.

-- ── Empresas (multiempresa) ─────────────────────────────────────────────
create table public.empresas (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  nome_fantasia text not null,
  razao_social text not null,
  cep text,
  endereco text,
  cidade text,
  uf text,
  telefone text,
  email text,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger empresas_set_updated_at
  before update on public.empresas
  for each row execute function public.set_updated_at();

-- ── Usuários (login interno + papéis + empresa) ─────────────────────────
create table public.usuarios (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null,
  login text not null unique,
  role text not null default 'caixa' check (role in ('admin', 'caixa')),
  ativo boolean not null default true,
  empresa_id uuid references public.empresas(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index usuarios_empresa_id_idx on public.usuarios (empresa_id);

create trigger usuarios_set_updated_at
  before update on public.usuarios
  for each row execute function public.set_updated_at();

-- ── Funções auxiliares usadas nas policies de RLS ───────────────────────
create or replace function public.is_usuario_ativo()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid() and u.ativo = true
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid() and u.role = 'admin' and u.ativo = true
  );
$$;

create or replace function public.current_empresa_id()
returns uuid
language sql
stable security definer
set search_path = public
as $$
  select empresa_id from public.usuarios where id = auth.uid();
$$;

create or replace function public.set_empresa_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.empresa_id is null then
    new.empresa_id := public.current_empresa_id();
  end if;
  return new;
end;
$$;

-- ── empresa_id nas tabelas de negócio + RLS multiempresa ────────────────
alter table public.clientes add column empresa_id uuid references public.empresas(id);
alter table public.produtos add column empresa_id uuid references public.empresas(id);
alter table public.fornecedores add column empresa_id uuid references public.empresas(id);
alter table public.vendas add column empresa_id uuid references public.empresas(id);
-- (agendamentos ganha empresa_id na própria criação da tabela, mais abaixo)

alter table public.clientes alter column empresa_id set not null;
alter table public.produtos alter column empresa_id set not null;
alter table public.fornecedores alter column empresa_id set not null;
alter table public.vendas alter column empresa_id set not null;

create trigger clientes_set_empresa_id before insert on public.clientes for each row execute function public.set_empresa_id();
create trigger produtos_set_empresa_id before insert on public.produtos for each row execute function public.set_empresa_id();
create trigger fornecedores_set_empresa_id before insert on public.fornecedores for each row execute function public.set_empresa_id();
create trigger vendas_set_empresa_id before insert on public.vendas for each row execute function public.set_empresa_id();

drop policy "Public full access" on public.clientes;
drop policy "Public full access" on public.produtos;
drop policy "Public full access" on public.fornecedores;
drop policy "Public full access" on public.vendas;
drop policy "Public full access" on public.venda_itens;

create policy "clientes_authenticated" on public.clientes for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create policy "produtos_authenticated" on public.produtos for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create policy "fornecedores_authenticated" on public.fornecedores for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create policy "vendas_authenticated" on public.vendas for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create policy "venda_itens_authenticated" on public.venda_itens for all to authenticated
  using (is_usuario_ativo() and exists (
    select 1 from public.vendas v where v.id = venda_itens.venda_id and (is_admin() or v.empresa_id = current_empresa_id())
  ))
  with check (is_usuario_ativo() and exists (
    select 1 from public.vendas v where v.id = venda_itens.venda_id and (is_admin() or v.empresa_id = current_empresa_id())
  ));

alter table public.usuarios enable row level security;
create policy "usuarios_select" on public.usuarios for select to authenticated
  using (id = auth.uid() or is_admin());
create policy "usuarios_update_admin" on public.usuarios for update to authenticated
  using (is_admin()) with check (is_admin());

alter table public.empresas enable row level security;
create policy "empresas_select" on public.empresas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or id = current_empresa_id()));
create policy "empresas_admin_write" on public.empresas for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── Clientes: pré-cadastro público + CEP ─────────────────────────────────
alter table public.clientes add column status_cadastro text not null default 'aprovado'
  check (status_cadastro in ('pendente', 'aprovado', 'reprovado'));
alter table public.clientes add column cep text;
alter table public.clientes alter column ativo set default true;

create unique index clientes_documento_normalizado_idx on public.clientes
  (regexp_replace(documento, '\D', '', 'g'))
  where documento is not null and documento <> '';

create or replace function public.pre_cadastro_cliente(
  p_nome text,
  p_documento text,
  p_email text default null,
  p_telefone text default null,
  p_cep text default null,
  p_cidade text default null,
  p_uf text default null,
  p_endereco text default null,
  p_empresa_codigo text default null
)
returns table(id uuid, nome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := trim(p_nome);
  v_documento text := trim(p_documento);
  v_id uuid;
  v_empresa_id uuid;
  v_ja_existe_msg text := 'Já existe um cadastro com este CPF/CNPJ em nossa base. Se você acredita que isso é um engano, fale com a nossa equipe.';
begin
  if v_nome = '' then
    raise exception 'Informe seu nome.';
  end if;

  if v_documento = '' then
    raise exception 'Informe seu CPF ou CNPJ.';
  end if;

  if p_empresa_codigo is not null and trim(p_empresa_codigo) <> '' then
    select id into v_empresa_id from public.empresas where upper(codigo) = upper(trim(p_empresa_codigo)) and ativo = true;
    if v_empresa_id is null then
      raise exception 'Link de cadastro inválido.';
    end if;
  else
    select id into v_empresa_id from public.empresas where codigo = 'MATRIZ';
  end if;

  if exists (
    select 1 from public.clientes c
    where regexp_replace(c.documento, '\D', '', 'g') = regexp_replace(v_documento, '\D', '', 'g')
  ) then
    raise exception '%', v_ja_existe_msg;
  end if;

  begin
    insert into public.clientes (empresa_id, nome, documento, email, telefone, cep, cidade, uf, endereco, ativo, status_cadastro)
    values (
      v_empresa_id, v_nome, v_documento,
      nullif(trim(p_email), ''), nullif(trim(p_telefone), ''), nullif(trim(p_cep), ''),
      nullif(trim(p_cidade), ''), nullif(trim(p_uf), ''), nullif(trim(p_endereco), ''),
      false, 'pendente'
    )
    returning clientes.id into v_id;
  exception when unique_violation then
    raise exception '%', v_ja_existe_msg;
  end;

  return query select v_id, v_nome;
end;
$$;

grant execute on function public.pre_cadastro_cliente(text, text, text, text, text, text, text, text, text) to anon, authenticated;

-- ── Agendamentos ──────────────────────────────────────────────────────
create table public.agendamentos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid references public.clientes(id),
  produto_id uuid not null references public.produtos(id),
  data_agendamento date not null,
  horario time not null,
  status text not null default 'agendado' check (status in ('agendado', 'atendido')),
  observacoes text,
  empresa_id uuid not null references public.empresas(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Bug histórico (corrigido em 0006): faltava empresa_id neste índice, então
-- um horário usado por uma empresa ficava indisponível para as demais.
create unique index agendamentos_slot_unico_idx on public.agendamentos (data_agendamento, horario);
create index agendamentos_data_idx on public.agendamentos (data_agendamento);
create index agendamentos_empresa_id_idx on public.agendamentos (empresa_id);

create trigger agendamentos_set_updated_at before update on public.agendamentos for each row execute function public.set_updated_at();
create trigger agendamentos_set_empresa_id before insert on public.agendamentos for each row execute function public.set_empresa_id();

alter table public.agendamentos enable row level security;
create policy "agendamentos_authenticated" on public.agendamentos for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── criar_venda / cancelar_venda: versão com p_empresa_id ───────────────
-- Bug histórico (corrigido em 0006): recriar a função com uma assinatura
-- nova reabriu o EXECUTE padrão para o papel `anon`.
--
-- A assinatura de 6 argumentos criada em 0004 precisa ser removida
-- explicitamente: como o novo p_empresa_id tem default, "create or replace"
-- não substitui a versão antiga — cria uma segunda função sobrecarregada, e
-- chamadas com 6 argumentos passam a ser ambíguas (foi exatamente isso que
-- a migração real "drop_stale_criar_venda_overload" corrigiu em produção).
drop function if exists public.criar_venda(uuid, date, text, text, numeric, jsonb);

create or replace function public.criar_venda(
  p_cliente_id uuid,
  p_data_venda date,
  p_forma_pagamento text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb,
  p_empresa_id uuid default null
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
    v_subtotal, coalesce(p_desconto, 0), v_subtotal - coalesce(p_desconto, 0), 'confirmada'
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

    update public.produtos set estoque = estoque - v_quantidade where id = v_produto_id;
  end loop;

  return v_venda_id;
end;
$$;

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

  for v_item in select produto_id, quantidade from public.venda_itens where venda_id = p_venda_id
  loop
    update public.produtos set estoque = estoque + v_item.quantidade where id = v_item.produto_id;
  end loop;

  update public.vendas set status = 'cancelada' where id = p_venda_id;
end;
$$;

grant execute on function public.cancelar_venda(uuid) to authenticated;

-- ── Índices por empresa_id (index_empresa_id_columns) ────────────────────
create index clientes_empresa_id_idx on public.clientes (empresa_id);
create index produtos_empresa_id_idx on public.produtos (empresa_id);
create index fornecedores_empresa_id_idx on public.fornecedores (empresa_id);
create index vendas_empresa_id_idx on public.vendas (empresa_id);

-- (produtos_sku_idx já existe desde 0004, sem empresa_id — bug histórico
-- corrigido em 0006, que dropa e recria o índice; nada a fazer aqui)

-- ── Recebimentos manuais (Financeiro > Contas a Receber) ────────────────
create table public.recebimentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  cliente_id uuid references public.clientes(id),
  produto_id uuid not null references public.produtos(id),
  quantidade integer not null check (quantidade > 0),
  valor numeric(12,2) not null check (valor >= 0),
  forma_pagamento text,
  data_recebimento date not null default current_date,
  observacoes text,
  status text not null default 'recebido' check (status in ('recebido', 'cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recebimentos_empresa_data_idx on public.recebimentos (empresa_id, data_recebimento);

create trigger recebimentos_set_updated_at before update on public.recebimentos for each row execute function public.set_updated_at();
create trigger recebimentos_set_empresa_id before insert on public.recebimentos for each row execute function public.set_empresa_id();

alter table public.recebimentos enable row level security;
-- Bug histórico (corrigido em 0007): registrada para {public} em vez de
-- {authenticated}, divergindo do padrão das demais tabelas.
create policy "recebimentos_authenticated" on public.recebimentos for all to public
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

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

  select estoque into v_estoque_atual from public.produtos where id = p_produto_id and empresa_id = v_empresa_id for update;

  if v_estoque_atual is null then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  if v_estoque_atual < p_quantidade then
    raise exception 'Estoque insuficiente para este produto: disponível %, solicitado %', v_estoque_atual, p_quantidade;
  end if;

  insert into public.recebimentos (empresa_id, cliente_id, produto_id, quantidade, valor, forma_pagamento, data_recebimento, observacoes, status)
  values (
    v_empresa_id, p_cliente_id, p_produto_id, p_quantidade, p_valor, p_forma_pagamento,
    coalesce(p_data_recebimento, current_date), p_observacoes, 'recebido'
  )
  returning id into v_recebimento_id;

  update public.produtos set estoque = estoque - p_quantidade where id = p_produto_id;

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
begin
  select status, empresa_id, produto_id, quantidade
    into v_status, v_empresa_id, v_produto_id, v_quantidade
    from public.recebimentos where id = p_recebimento_id for update;

  if v_status is null then
    raise exception 'Recebimento % não encontrado', p_recebimento_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para cancelar este recebimento.';
  end if;

  if v_status = 'cancelado' then
    return;
  end if;

  update public.produtos set estoque = estoque + v_quantidade where id = v_produto_id;
  update public.recebimentos set status = 'cancelado' where id = p_recebimento_id;
end;
$$;

grant execute on function public.criar_recebimento_manual(uuid, integer, numeric, uuid, text, date, text, uuid) to authenticated;
grant execute on function public.cancelar_recebimento_manual(uuid) to authenticated;
