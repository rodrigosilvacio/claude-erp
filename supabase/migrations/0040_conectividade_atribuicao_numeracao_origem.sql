-- Fecha lacunas de conectividade encontradas na auditoria do modelo de dados:
--  1) vendas/matrículas/ajustes/entradas de estoque não tinham responsável
--     (só propostas.vendedor_id existia) — impossibilita ranking de
--     vendedor e accountability de quem lançou o quê.
--  2) agendamentos não linkava com matriculas — Agenda e Matrículas eram
--     dois módulos sem conexão além do nome do cliente.
--  3) numero de propostas/vendas/matrículas era "generated always as
--     identity" GLOBAL (compartilhado entre todas as empresas) — não fica
--     profissional uma empresa branca ver sua 1ª proposta nascer como "#847"
--     porque outra empresa já gerou 846.
--  4) sem campo de origem/canal em propostas/clientes — pergunta básica de
--     CRM ("de onde vêm nossos leads") sem resposta possível.

-- ═══════════════════════════════════════════════════════════════════════
-- Parte 1 — usuario_id (responsável) em vendas/matrículas/ajustes/entradas
-- ═══════════════════════════════════════════════════════════════════════

alter table public.vendas add column usuario_id uuid references public.usuarios(id) on delete set null;
alter table public.matriculas add column usuario_id uuid references public.usuarios(id) on delete set null;
alter table public.ajustes_estoque add column usuario_id uuid references public.usuarios(id) on delete set null;
alter table public.entradas_estoque add column usuario_id uuid references public.usuarios(id) on delete set null;

comment on column public.vendas.usuario_id is 'Usuário logado que registrou a venda (auth.uid() capturado em criar_venda) — histórico não é retroativo. Usado em ranking de vendedores.';
comment on column public.matriculas.usuario_id is 'Usuário logado que registrou a matrícula (auth.uid() capturado em criar_matricula).';
comment on column public.ajustes_estoque.usuario_id is 'Usuário logado que registrou o ajuste (auth.uid() capturado em registrar_ajuste_estoque).';
comment on column public.entradas_estoque.usuario_id is 'Usuário logado que registrou a entrada (auth.uid() capturado em registrar_entrada_estoque).';

create index idx_vendas_usuario_id on public.vendas(usuario_id);
create index idx_matriculas_usuario_id on public.matriculas(usuario_id);

-- criar_venda: mesma assinatura, só grava usuario_id = auth.uid() no insert.
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

  insert into public.vendas (empresa_id, cliente_id, data_venda, forma_pagamento, observacoes, subtotal, desconto, total, status, usuario_id)
  values (
    v_empresa_id, p_cliente_id, coalesce(p_data_venda, current_date), p_forma_pagamento, p_observacoes,
    v_subtotal, coalesce(p_desconto, 0), greatest(v_subtotal - coalesce(p_desconto, 0), 0), p_status, auth.uid()
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
$function$;

-- criar_matricula: mesma assinatura, só grava usuario_id = auth.uid() no insert.
create or replace function public.criar_matricula(
  p_cliente_id uuid,
  p_produto_id uuid,
  p_meses integer,
  p_numero_parcelas integer,
  p_forma_pagamento text,
  p_data_matricula date default null,
  p_desconto numeric default 0,
  p_observacoes text default null,
  p_empresa_id uuid default null,
  p_status text default 'ativa',
  p_valor_servico_override numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_matricula_id uuid;
  v_data_matricula date;
  v_preco numeric(12,2);
  v_valor_total numeric(12,2);
  v_valor_parcela numeric(12,2);
  v_soma_parcelas numeric(12,2) := 0;
  v_valor_desta_parcela numeric(12,2);
  i integer;
begin
  if p_status not in ('ativa', 'aguardando_pagamento') then
    raise exception 'Status inicial de matrícula inválido: %', p_status;
  end if;

  if p_cliente_id is null then
    raise exception 'Selecione um cliente.';
  end if;

  if p_produto_id is null then
    raise exception 'Selecione um produto (curso/serviço).';
  end if;

  if p_meses is null or p_meses <= 0 then
    raise exception 'Informe a duração do curso em meses (maior que zero).';
  end if;

  if p_numero_parcelas is null or p_numero_parcelas <= 0 then
    raise exception 'Informe o número de parcelas (maior que zero).';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa desta matrícula.';
  end if;

  if not exists (select 1 from public.clientes where id = p_cliente_id and empresa_id = v_empresa_id) then
    raise exception 'Cliente não encontrado nesta empresa.';
  end if;

  select preco into v_preco from public.produtos where id = p_produto_id and empresa_id = v_empresa_id;
  if v_preco is null then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  if p_valor_servico_override is not null then
    v_preco := greatest(p_valor_servico_override, 0);
  end if;

  v_data_matricula := coalesce(p_data_matricula, current_date);
  v_valor_total := greatest(v_preco - coalesce(p_desconto, 0), 0);
  v_valor_parcela := round(v_valor_total / p_numero_parcelas, 2);

  insert into public.matriculas (
    empresa_id, cliente_id, produto_id, data_matricula, meses, numero_parcelas,
    valor_servico, desconto, valor_total, forma_pagamento, observacoes, status, usuario_id
  )
  values (
    v_empresa_id, p_cliente_id, p_produto_id, v_data_matricula, p_meses, p_numero_parcelas,
    v_preco, coalesce(p_desconto, 0), v_valor_total, p_forma_pagamento, p_observacoes, p_status, auth.uid()
  )
  returning id into v_matricula_id;

  for i in 1..p_numero_parcelas loop
    v_valor_desta_parcela := case when i = p_numero_parcelas then v_valor_total - v_soma_parcelas else v_valor_parcela end;

    insert into public.matricula_parcelas (
      matricula_id, empresa_id, cliente_id, numero_parcela, valor, data_vencimento, forma_pagamento, status, data_pagamento
    )
    values (
      v_matricula_id, v_empresa_id, p_cliente_id, i,
      v_valor_desta_parcela,
      public.add_months_clamped(v_data_matricula, i - 1),
      p_forma_pagamento,
      case when i = 1 and p_status = 'ativa' then 'pago' else 'pendente' end,
      case when i = 1 and p_status = 'ativa' then v_data_matricula else null end
    );

    v_soma_parcelas := v_soma_parcelas + v_valor_parcela;
  end loop;

  return v_matricula_id;
end;
$function$;

-- registrar_ajuste_estoque: mesma assinatura, só grava usuario_id.
create or replace function public.registrar_ajuste_estoque(p_produto_id uuid, p_quantidade integer, p_motivo text, p_empresa_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_produto_empresa_id uuid;
  v_estoque_atual integer;
  v_ajuste_id uuid;
begin
  if p_produto_id is null then
    raise exception 'Selecione um produto.';
  end if;

  if p_quantidade is null or p_quantidade = 0 then
    raise exception 'Informe uma quantidade diferente de zero (positiva para sobra, negativa para perda/quebra).';
  end if;

  if p_motivo is null or trim(p_motivo) = '' then
    raise exception 'Informe o motivo do ajuste.';
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa deste ajuste.';
  end if;

  select empresa_id, estoque into v_produto_empresa_id, v_estoque_atual
  from public.produtos where id = p_produto_id for update;

  if v_produto_empresa_id is null then
    raise exception 'Produto não encontrado.';
  end if;

  if v_produto_empresa_id <> v_empresa_id then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  if v_estoque_atual + p_quantidade < 0 then
    raise exception 'Este ajuste deixaria o estoque negativo (atual: %, ajuste: %).', v_estoque_atual, p_quantidade;
  end if;

  insert into public.ajustes_estoque (empresa_id, produto_id, quantidade, motivo, usuario_id)
  values (v_empresa_id, p_produto_id, p_quantidade, trim(p_motivo), auth.uid())
  returning id into v_ajuste_id;

  update public.produtos set estoque = estoque + p_quantidade where id = p_produto_id;

  return v_ajuste_id;
end;
$function$;

-- registrar_entrada_estoque: mesma assinatura, só grava usuario_id.
create or replace function public.registrar_entrada_estoque(
  p_produto_id uuid,
  p_quantidade integer,
  p_data_entrada date default null,
  p_observacoes text default null,
  p_empresa_id uuid default null,
  p_gerar_conta_pagar boolean default false,
  p_fornecedor_id uuid default null,
  p_valor_conta numeric default null,
  p_vencimento_conta date default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_produto_empresa_id uuid;
  v_produto_nome text;
  v_entrada_id uuid;
  v_conta_id uuid;
begin
  if p_produto_id is null then
    raise exception 'Selecione um produto.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Informe uma quantidade válida (maior que zero).';
  end if;

  if p_gerar_conta_pagar then
    if p_fornecedor_id is null then
      raise exception 'Selecione o fornecedor para gerar a conta a pagar.';
    end if;
    if p_valor_conta is null or p_valor_conta <= 0 then
      raise exception 'Informe o valor da conta a pagar.';
    end if;
  end if;

  if is_admin() then
    v_empresa_id := coalesce(p_empresa_id, current_empresa_id());
  else
    v_empresa_id := current_empresa_id();
  end if;

  if v_empresa_id is null then
    raise exception 'Não foi possível determinar a empresa desta entrada.';
  end if;

  select empresa_id, nome into v_produto_empresa_id, v_produto_nome from public.produtos where id = p_produto_id for update;

  if v_produto_empresa_id is null then
    raise exception 'Produto não encontrado.';
  end if;

  if v_produto_empresa_id <> v_empresa_id then
    raise exception 'Produto não encontrado nesta empresa.';
  end if;

  insert into public.entradas_estoque (empresa_id, produto_id, quantidade, data_entrada, observacoes, usuario_id)
  values (v_empresa_id, p_produto_id, p_quantidade, coalesce(p_data_entrada, current_date), nullif(trim(p_observacoes), ''), auth.uid())
  returning id into v_entrada_id;

  update public.produtos set estoque = estoque + p_quantidade where id = p_produto_id;

  if p_gerar_conta_pagar then
    v_conta_id := public.criar_conta_pagar(
      p_fornecedor_id,
      'Entrada de estoque: ' || coalesce(v_produto_nome, 'produto') || ' (' || p_quantidade || ' un.)',
      p_valor_conta,
      coalesce(p_vencimento_conta, coalesce(p_data_entrada, current_date)),
      null,
      p_observacoes,
      v_empresa_id
    );
    update public.entradas_estoque set conta_pagar_id = v_conta_id where id = v_entrada_id;
  end if;

  return v_entrada_id;
end;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- Parte 2 — Agenda ↔ Matrículas
-- ═══════════════════════════════════════════════════════════════════════

alter table public.agendamentos add column matricula_id uuid references public.matriculas(id) on delete set null;
create index idx_agendamentos_matricula_id on public.agendamentos(matricula_id);
comment on column public.agendamentos.matricula_id is 'Matrícula ativa do cliente para o produto/serviço agendado (resolvida automaticamente no front-end ao agendar, quando existir) — fecha a lacuna entre Agenda e Matrículas: sem isso não dava pra saber se um agendamento correspondia a uma matrícula ativa.';

-- ═══════════════════════════════════════════════════════════════════════
-- Parte 3 — numeração de propostas/vendas/matrículas por empresa
-- ═══════════════════════════════════════════════════════════════════════

alter table public.propostas alter column numero drop identity if exists;
alter table public.vendas alter column numero drop identity if exists;
alter table public.matriculas alter column numero drop identity if exists;

create or replace function public.atribuir_numero_por_empresa()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_max bigint;
begin
  if new.numero is not null then
    return new;
  end if;

  -- Trava por (tabela, empresa) durante a transação — evita dois inserts
  -- concorrentes da mesma empresa calcularem o mesmo max(numero)+1.
  perform pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || new.empresa_id::text, 0));

  execute format('select coalesce(max(numero), 0) from public.%I where empresa_id = $1', TG_TABLE_NAME)
    into v_max using new.empresa_id;

  new.numero := v_max + 1;
  return new;
end;
$function$;

comment on function public.atribuir_numero_por_empresa() is 'Substitui "numero generated always as identity" (contador único global) por numeração sequencial POR EMPRESA — trigger genérica reaproveitada em propostas/vendas/matrículas via TG_TABLE_NAME. Números já emitidos antes desta migration não são renumerados (eram globalmente únicos, continuam válidos).';

create trigger trg_propostas_numero before insert on public.propostas for each row execute function public.atribuir_numero_por_empresa();
create trigger trg_vendas_numero before insert on public.vendas for each row execute function public.atribuir_numero_por_empresa();
create trigger trg_matriculas_numero before insert on public.matriculas for each row execute function public.atribuir_numero_por_empresa();

alter table public.propostas add constraint propostas_empresa_numero_unique unique (empresa_id, numero);
alter table public.vendas add constraint vendas_empresa_numero_unique unique (empresa_id, numero);
alter table public.matriculas add constraint matriculas_empresa_numero_unique unique (empresa_id, numero);

-- ═══════════════════════════════════════════════════════════════════════
-- Parte 4 — origem/canal em propostas e clientes
-- ═══════════════════════════════════════════════════════════════════════

alter table public.propostas add column origem text;
alter table public.clientes add column origem text;
comment on column public.propostas.origem is 'Canal de origem do lead/negociação (indicação, instagram, site, etc.) — lista sugerida no front-end, texto livre no banco.';
comment on column public.clientes.origem is 'Canal de origem do cliente — mesmo racional de propostas.origem.';

-- criar_proposta ganha p_origem (novo parâmetro trailing muda a assinatura —
-- precisa DROP explícito da versão antiga, senão CREATE OR REPLACE cria um
-- overload novo e deixa a função velha órfã, ainda executável).
drop function if exists public.criar_proposta(text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, uuid);

create function public.criar_proposta(
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
  p_empresa_id uuid default null,
  p_origem text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    subtotal, desconto, total, status, origem
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
    'draft',
    nullif(trim(coalesce(p_origem, '')), '')
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
$function$;

grant execute on function public.criar_proposta(text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, uuid, text) to authenticated;
revoke execute on function public.criar_proposta(text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, uuid, text) from anon;

-- atualizar_proposta ganha p_origem (mesmo motivo do DROP acima).
drop function if exists public.atualizar_proposta(uuid, text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb);

create function public.atualizar_proposta(
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
  p_itens jsonb,
  p_origem text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    total = greatest(v_subtotal - coalesce(p_desconto, 0), 0),
    origem = nullif(trim(coalesce(p_origem, '')), '')
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
$function$;

grant execute on function public.atualizar_proposta(uuid, text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, text) to authenticated;
revoke execute on function public.atualizar_proposta(uuid, text, uuid, text, text, text, date, date, text, text, text, numeric, jsonb, text) from anon;
