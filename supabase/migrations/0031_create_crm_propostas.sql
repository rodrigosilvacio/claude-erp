-- AppVendas — módulo CRM: cadastro de Propostas (orçamentos para lead ou
-- cliente, com múltiplos produtos, valor total, ciclo de status e envio por
-- e-mail). Mesmo padrão multiempresa das demais tabelas de movimentação
-- (vendas, matriculas): `empresa_id` + RLS via is_admin()/current_empresa_id()
-- (ver migration 0005/0020).
--
-- Diferente de uma venda, uma proposta é só um orçamento — criar/editar/
-- cancelar uma proposta NUNCA mexe em estoque. A baixa de estoque só
-- acontece quando (e se) a proposta virar uma venda de verdade, pela tela
-- de Vendas já existente.

-- ── Propostas (cabeçalho) ────────────────────────────────────────────────
create table public.propostas (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  empresa_id uuid not null references public.empresas(id) on delete restrict,

  -- Lead (campo livre, sem cadastro) ou Cliente (vínculo com o cadastro).
  tipo_contato text not null check (tipo_contato in ('lead', 'cliente')),
  cliente_id uuid references public.clientes(id) on delete restrict,
  lead_nome text,
  -- Telefone/e-mail: para cliente, é o dado buscado do cadastro (preenchido
  -- pelo front); para lead, é digitado livremente — a coluna é a mesma nos
  -- dois casos para simplificar o envio por e-mail e a impressão.
  contato_telefone text,
  contato_email text,
  check (
    (tipo_contato = 'cliente' and cliente_id is not null and lead_nome is null)
    or
    (tipo_contato = 'lead' and lead_nome is not null and lead_nome <> '' and cliente_id is null)
  ),

  vendedor_id uuid references public.usuarios(id) on delete set null,
  data_proposta date not null default current_date,
  -- Data-limite de validade do orçamento — campo comum em toda proposta
  -- comercial, ausente do pedido original mas essencial (sem isso não dá
  -- pra saber até quando o preço ofertado vale).
  validade_ate date,
  condicoes_pagamento text,
  prazo_entrega text,
  observacoes text,

  -- Draft/Enviado/Reprovado vieram do pedido; "aprovada" foi adicionado
  -- (ver README) — sem um status de "ganhou", não dá pra medir taxa de
  -- conversão de propostas nem filtrar as que viraram venda.
  status text not null default 'draft' check (status in ('draft', 'enviada', 'aprovada', 'reprovada')),
  -- Motivo: obrigatório só quando reprovada (ex.: preço, prazo, concorrência).
  motivo text,
  check (status <> 'reprovada' or (motivo is not null and motivo <> '')),

  subtotal numeric(12,2) not null default 0,
  desconto numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,

  enviada_em timestamptz,
  respondida_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index propostas_empresa_id_idx on public.propostas (empresa_id);
create index propostas_cliente_id_idx on public.propostas (cliente_id);
create index propostas_status_idx on public.propostas (status);
create index propostas_data_proposta_idx on public.propostas (data_proposta desc);

create trigger propostas_set_updated_at
  before update on public.propostas
  for each row execute function public.set_updated_at();

-- ── Itens da proposta (produtos a oferecer) ─────────────────────────────
create table public.proposta_itens (
  id uuid primary key default gen_random_uuid(),
  proposta_id uuid not null references public.propostas(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  quantidade integer not null check (quantidade > 0),
  preco_unitario numeric(12,2) not null,
  subtotal numeric(12,2) not null,
  observacao text,
  created_at timestamptz not null default now()
);

create index proposta_itens_proposta_id_idx on public.proposta_itens (proposta_id);
create index proposta_itens_produto_id_idx on public.proposta_itens (produto_id);

-- ── RLS: mesmo padrão multiempresa de vendas/matriculas (0020) ─────────
alter table public.propostas enable row level security;
alter table public.proposta_itens enable row level security;

create policy "propostas_authenticated" on public.propostas
  for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- proposta_itens não tem empresa_id próprio — mesmo padrão de venda_itens:
-- a checagem passa pela proposta pai.
create policy "proposta_itens_authenticated" on public.proposta_itens
  for all to authenticated
  using (
    is_usuario_ativo() and exists (
      select 1 from public.propostas p
      where p.id = proposta_itens.proposta_id
        and (is_admin() or p.empresa_id = current_empresa_id())
    )
  )
  with check (
    is_usuario_ativo() and exists (
      select 1 from public.propostas p
      where p.id = proposta_itens.proposta_id
        and (is_admin() or p.empresa_id = current_empresa_id())
    )
  );

-- ── criar_proposta: cria o cabeçalho + itens de forma atômica. Nunca mexe
-- em estoque — proposta é só orçamento (ver nota no topo do arquivo).
create or replace function public.criar_proposta(
  p_tipo_contato text,
  p_cliente_id uuid,
  p_lead_nome text,
  p_contato_telefone text,
  p_contato_email text,
  p_data_proposta date,
  p_validade_ate date,
  p_condicoes_pagamento text,
  p_prazo_entrega text,
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
  v_proposta_id uuid;
  v_empresa_id uuid;
  v_subtotal numeric(12,2) := 0;
  v_item jsonb;
  v_produto_id uuid;
  v_quantidade integer;
  v_preco_unitario numeric(12,2);
  v_item_subtotal numeric(12,2);
begin
  if p_tipo_contato not in ('lead', 'cliente') then
    raise exception 'Tipo de contato inválido: %', p_tipo_contato;
  end if;

  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    raise exception 'A proposta precisa ter ao menos um produto';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa da proposta.';
  end if;

  if p_tipo_contato = 'cliente' then
    if p_cliente_id is null then
      raise exception 'Selecione um cliente.';
    end if;
    if not exists (select 1 from public.clientes where id = p_cliente_id and empresa_id = v_empresa_id) then
      raise exception 'Cliente não encontrado nesta empresa.';
    end if;
  else
    if p_lead_nome is null or trim(p_lead_nome) = '' then
      raise exception 'Informe o nome do lead.';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_item_subtotal := (v_item->>'quantidade')::integer * (v_item->>'preco_unitario')::numeric;
    v_subtotal := v_subtotal + v_item_subtotal;
  end loop;

  insert into public.propostas (
    empresa_id, tipo_contato, cliente_id, lead_nome, contato_telefone, contato_email,
    vendedor_id, data_proposta, validade_ate, condicoes_pagamento, prazo_entrega, observacoes,
    subtotal, desconto, total, status
  )
  values (
    v_empresa_id,
    p_tipo_contato,
    case when p_tipo_contato = 'cliente' then p_cliente_id else null end,
    case when p_tipo_contato = 'lead' then trim(p_lead_nome) else null end,
    nullif(trim(coalesce(p_contato_telefone, '')), ''),
    nullif(trim(coalesce(p_contato_email, '')), ''),
    auth.uid(),
    coalesce(p_data_proposta, current_date),
    p_validade_ate,
    p_condicoes_pagamento,
    p_prazo_entrega,
    p_observacoes,
    v_subtotal,
    coalesce(p_desconto, 0),
    greatest(v_subtotal - coalesce(p_desconto, 0), 0),
    'draft'
  )
  returning id into v_proposta_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;
    v_preco_unitario := (v_item->>'preco_unitario')::numeric;

    if not exists (select 1 from public.produtos where id = v_produto_id and empresa_id = v_empresa_id) then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    insert into public.proposta_itens (proposta_id, produto_id, quantidade, preco_unitario, subtotal, observacao)
    values (v_proposta_id, v_produto_id, v_quantidade, v_preco_unitario, v_quantidade * v_preco_unitario, v_item->>'observacao');
  end loop;

  return v_proposta_id;
end;
$$;

grant execute on function public.criar_proposta(text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, uuid) to authenticated;
-- Toda função nova em public é criada com EXECUTE liberado para `anon` por
-- padrão neste projeto (mesma pegadinha corrigida em 0006/0012 para as
-- funções anteriores) — revoga explicitamente, já que o grant acima só
-- concede a `authenticated`.
revoke execute on function public.criar_proposta(text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, uuid) from anon;

-- ── atualizar_proposta: só permitido enquanto a proposta está em rascunho
-- (depois de enviada, o conteúdo já pode ter chegado ao cliente — mudar os
-- itens por baixo geraria uma proposta diferente da que a pessoa recebeu).
-- Recria os itens do zero, mesmo padrão de "substituir tudo" usado por
-- outras telas de edição em lote deste app.
create or replace function public.atualizar_proposta(
  p_proposta_id uuid,
  p_tipo_contato text,
  p_cliente_id uuid,
  p_lead_nome text,
  p_contato_telefone text,
  p_contato_email text,
  p_data_proposta date,
  p_validade_ate date,
  p_condicoes_pagamento text,
  p_prazo_entrega text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_status text;
  v_subtotal numeric(12,2) := 0;
  v_item jsonb;
  v_produto_id uuid;
  v_quantidade integer;
  v_preco_unitario numeric(12,2);
  v_item_subtotal numeric(12,2);
begin
  select empresa_id, status into v_empresa_id, v_status from public.propostas where id = p_proposta_id;

  if v_empresa_id is null then
    raise exception 'Proposta não encontrada.';
  end if;
  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para editar esta proposta.';
  end if;
  if v_status <> 'draft' then
    raise exception 'Só é possível editar propostas em rascunho.';
  end if;

  if p_tipo_contato not in ('lead', 'cliente') then
    raise exception 'Tipo de contato inválido: %', p_tipo_contato;
  end if;
  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    raise exception 'A proposta precisa ter ao menos um produto';
  end if;

  if p_tipo_contato = 'cliente' then
    if p_cliente_id is null then
      raise exception 'Selecione um cliente.';
    end if;
    if not exists (select 1 from public.clientes where id = p_cliente_id and empresa_id = v_empresa_id) then
      raise exception 'Cliente não encontrado nesta empresa.';
    end if;
  else
    if p_lead_nome is null or trim(p_lead_nome) = '' then
      raise exception 'Informe o nome do lead.';
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_item_subtotal := (v_item->>'quantidade')::integer * (v_item->>'preco_unitario')::numeric;
    v_subtotal := v_subtotal + v_item_subtotal;
  end loop;

  update public.propostas set
    tipo_contato = p_tipo_contato,
    cliente_id = case when p_tipo_contato = 'cliente' then p_cliente_id else null end,
    lead_nome = case when p_tipo_contato = 'lead' then trim(p_lead_nome) else null end,
    contato_telefone = nullif(trim(coalesce(p_contato_telefone, '')), ''),
    contato_email = nullif(trim(coalesce(p_contato_email, '')), ''),
    data_proposta = coalesce(p_data_proposta, current_date),
    validade_ate = p_validade_ate,
    condicoes_pagamento = p_condicoes_pagamento,
    prazo_entrega = p_prazo_entrega,
    observacoes = p_observacoes,
    subtotal = v_subtotal,
    desconto = coalesce(p_desconto, 0),
    total = greatest(v_subtotal - coalesce(p_desconto, 0), 0)
  where id = p_proposta_id;

  delete from public.proposta_itens where proposta_id = p_proposta_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;
    v_preco_unitario := (v_item->>'preco_unitario')::numeric;

    if not exists (select 1 from public.produtos where id = v_produto_id and empresa_id = v_empresa_id) then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    insert into public.proposta_itens (proposta_id, produto_id, quantidade, preco_unitario, subtotal, observacao)
    values (p_proposta_id, v_produto_id, v_quantidade, v_preco_unitario, v_quantidade * v_preco_unitario, v_item->>'observacao');
  end loop;
end;
$$;

grant execute on function public.atualizar_proposta(uuid, text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb) to authenticated;
revoke execute on function public.atualizar_proposta(uuid, text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb) from anon;

-- ── atualizar_status_proposta: move a proposta pelo ciclo Draft → Enviada
-- → Aprovada/Reprovada. Sem matriz rígida de transição (o pedido não
-- descreveu um fluxo travado, e forçar uma matriz cedo demais só atrapalha
-- quem precisa corrigir um status errado) — a única regra de negócio dura é
-- exigir motivo ao reprovar, que a própria coluna já garante via check
-- constraint; aqui só validamos e traduzimos a mensagem de erro.
create or replace function public.atualizar_status_proposta(
  p_proposta_id uuid,
  p_status text,
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_status_atual text;
begin
  if p_status not in ('draft', 'enviada', 'aprovada', 'reprovada') then
    raise exception 'Status inválido: %', p_status;
  end if;
  if p_status = 'reprovada' and (p_motivo is null or trim(p_motivo) = '') then
    raise exception 'Informe o motivo da reprovação.';
  end if;

  select empresa_id, status into v_empresa_id, v_status_atual from public.propostas where id = p_proposta_id;

  if v_empresa_id is null then
    raise exception 'Proposta não encontrada.';
  end if;
  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para alterar esta proposta.';
  end if;

  update public.propostas set
    status = p_status,
    motivo = case when p_status = 'reprovada' then trim(p_motivo) else motivo end,
    enviada_em = case when p_status = 'enviada' and enviada_em is null then now() else enviada_em end,
    respondida_em = case when p_status in ('aprovada', 'reprovada') then now() else respondida_em end
  where id = p_proposta_id;
end;
$$;

grant execute on function public.atualizar_status_proposta(uuid, text, text) to authenticated;
revoke execute on function public.atualizar_status_proposta(uuid, text, text) from anon;
