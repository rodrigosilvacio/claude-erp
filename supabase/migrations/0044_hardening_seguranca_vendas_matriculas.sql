-- Revisão de segurança do appvendas — fecha 3 achados:
--
-- 1) criar_venda/criar_matricula confiavam no preço/valor enviado pelo
--    cliente (venda_itens.preco_unitario vinha direto de p_itens; o
--    "valor negociado" de uma matrícula vinha de p_valor_servico_override,
--    um numeric solto). Qualquer usuário autenticado podia chamar a RPC (ou
--    o checkout Stripe, que só repassa esses valores) com um preço
--    arbitrário — ex.: comprar um produto de verdade por R$0,01. Agora o
--    preço é sempre resolvido no servidor: preço de catálogo (produtos.preco)
--    por padrão, ou o preço negociado numa proposta do CRM já aprovada — e
--    só quando o item realmente pertence àquela proposta —, nunca um valor
--    vindo solto do chamador.
--
-- 2) criar_matricula (11 parâmetros, migration 0033) e
--    registrar_entrada_estoque (9 parâmetros, migration 0034) ficaram sem o
--    revoke de anon/public de que toda função nova (ou que ganhou parâmetro
--    novo) precisa neste projeto — ver 0006/0012/0023/0042. Hoje isso não é
--    explorável (current_empresa_id() é nulo para anon, então as duas
--    funções sempre rejeitam por "empresa não determinada"), mas é uma
--    bomba-relógio se essa resolução de empresa mudar. criar_matricula já
--    ganha grants corretos por já estar sendo recriada no item 1; aqui só
--    fecha o de registrar_entrada_estoque, que não muda de assinatura.
--
-- 3) Nenhuma tabela transacional/financeira (vendas, contas_pagar,
--    matrículas, estoque, propostas, parcelas) diferenciava admin de
--    "caixa" na RLS — qualquer usuário ativo da empresa tinha INSERT/
--    UPDATE/DELETE direto nessas tabelas via API, contornando as regras de
--    negócio (baixa de estoque, máquina de estados, consistência) que só
--    as RPCs aplicam. O front-end nunca escreve direto nessas tabelas (só
--    via RPC, que é SECURITY DEFINER e não é afetada por RLS), então
--    restringir a escrita direta a admin não muda nenhum fluxo existente —
--    só fecha o desvio das RPCs.
--
-- Fora de escopo aqui de propósito (não pedido nesta rodada): o uso de
-- is_admin() em vez de is_global_admin() nessas mesmas policies/RPCs, que
-- deixa um admin vinculado a uma única empresa ler/escrever dados de
-- qualquer outra (mesma falha que 0020 corrigiu só para usuarios/empresas).
-- Preservado tal como estava — só a separação admin/caixa foi adicionada.

-- ═══════════════════════════════════════════════════════════════════════
-- 1a) criar_venda: preço sempre resolvido no servidor
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer);

create function public.criar_venda(
  p_cliente_id uuid,
  p_data_venda date,
  p_forma_pagamento text,
  p_observacoes text,
  p_desconto numeric,
  p_itens jsonb,
  p_empresa_id uuid default null,
  p_status text default 'confirmada',
  p_numero_parcelas integer default null,
  p_proposta_id uuid default null
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
  v_preco_negociado numeric(12,2);
  v_estoque_atual integer;
  v_produto_tipo text;
  v_item_subtotal numeric(12,2);
  v_empresa_id uuid;
  v_total numeric(12,2);
  v_valor_parcela numeric(12,2);
  v_soma_parcelas numeric(12,2) := 0;
  v_valor_desta_parcela numeric(12,2);
  v_proposta_empresa_id uuid;
  v_proposta_status text;
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

  -- p_proposta_id: honra o preço negociado numa proposta do CRM já
  -- aprovada (fluxo Converter proposta em venda, crm.js/vendas.js). Só é
  -- aceito se a proposta existir, for desta empresa e estiver aprovada —
  -- caso contrário é ignorado silenciosamente e cai no preço de catálogo,
  -- igual a uma venda avulsa.
  if p_proposta_id is not null then
    select empresa_id, status into v_proposta_empresa_id, v_proposta_status
    from public.propostas where id = p_proposta_id;

    if v_proposta_empresa_id is null or v_proposta_empresa_id <> v_empresa_id or v_proposta_status <> 'aprovada' then
      p_proposta_id := null;
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::integer;

    select preco into v_preco_unitario from public.produtos where id = v_produto_id and empresa_id = v_empresa_id;
    if v_preco_unitario is null then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    if p_proposta_id is not null then
      select preco_unitario into v_preco_negociado
      from public.proposta_itens
      where proposta_id = p_proposta_id and produto_id = v_produto_id
      order by created_at asc limit 1;
      if v_preco_negociado is not null then
        v_preco_unitario := v_preco_negociado;
      end if;
    end if;

    v_item_subtotal := v_quantidade * v_preco_unitario;
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

    select estoque, tipo, preco into v_estoque_atual, v_produto_tipo, v_preco_unitario
    from public.produtos where id = v_produto_id and empresa_id = v_empresa_id for update;

    if v_produto_tipo is null then
      raise exception 'Produto % não encontrado nesta empresa', v_produto_id;
    end if;

    if p_proposta_id is not null then
      select preco_unitario into v_preco_negociado
      from public.proposta_itens
      where proposta_id = p_proposta_id and produto_id = v_produto_id
      order by created_at asc limit 1;
      if v_preco_negociado is not null then
        v_preco_unitario := v_preco_negociado;
      end if;
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

revoke execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer, uuid) from public;
revoke execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer, uuid) from anon;
grant execute on function public.criar_venda(uuid, date, text, text, numeric, jsonb, uuid, text, integer, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 1b) criar_matricula: troca p_valor_servico_override (numeric livre) por
--     p_proposta_id — o preço negociado passa a ser resolvido no servidor,
--     nunca aceito como número solto vindo do cliente.
-- ═══════════════════════════════════════════════════════════════════════

drop function if exists public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text, numeric);

create function public.criar_matricula(
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
  p_proposta_id uuid default null
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
  v_preco_negociado numeric(12,2);
  v_proposta_empresa_id uuid;
  v_proposta_status text;
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

  -- Preço negociado numa proposta do CRM: só é aceito se a proposta existir,
  -- for desta empresa, já estiver aprovada e tiver um item deste mesmo
  -- produto — nunca um valor solto vindo do cliente (era exatamente essa a
  -- falha do antigo p_valor_servico_override numérico).
  if p_proposta_id is not null then
    select empresa_id, status into v_proposta_empresa_id, v_proposta_status
    from public.propostas where id = p_proposta_id;

    if v_proposta_empresa_id = v_empresa_id and v_proposta_status = 'aprovada' then
      select preco_unitario into v_preco_negociado
      from public.proposta_itens
      where proposta_id = p_proposta_id and produto_id = p_produto_id
      order by created_at asc limit 1;

      if v_preco_negociado is not null then
        v_preco := v_preco_negociado;
      end if;
    end if;
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

revoke execute on function public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text, uuid) from public;
revoke execute on function public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text, uuid) from anon;
grant execute on function public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) registrar_entrada_estoque: fecha o EXECUTE de anon/public que ficou
--    aberto desde a migration 0034 (mesma assinatura, só grants).
-- ═══════════════════════════════════════════════════════════════════════

revoke execute on function public.registrar_entrada_estoque(uuid, integer, date, text, uuid, boolean, uuid, numeric, date) from public;
revoke execute on function public.registrar_entrada_estoque(uuid, integer, date, text, uuid, boolean, uuid, numeric, date) from anon;
grant execute on function public.registrar_entrada_estoque(uuid, integer, date, text, uuid, boolean, uuid, numeric, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) RLS: separa leitura (qualquer usuário ativo da empresa) de escrita
--    direta (só admin) nas tabelas transacionais/financeiras. O front-end
--    só escreve nelas via RPC (security definer, não passa por RLS) — isto
--    só fecha o desvio de bater direto na tabela pela API.
-- ═══════════════════════════════════════════════════════════════════════

-- vendas / venda_itens
drop policy "vendas_authenticated" on public.vendas;
create policy "vendas_select" on public.vendas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "vendas_admin_write" on public.vendas for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

drop policy "venda_itens_authenticated" on public.venda_itens;
create policy "venda_itens_select" on public.venda_itens for select to authenticated
  using (is_usuario_ativo() and exists (
    select 1 from public.vendas v where v.id = venda_itens.venda_id and (is_admin() or v.empresa_id = current_empresa_id())
  ));
create policy "venda_itens_admin_write" on public.venda_itens for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- venda_parcelas
drop policy "venda_parcelas_authenticated" on public.venda_parcelas;
create policy "venda_parcelas_select" on public.venda_parcelas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "venda_parcelas_admin_write" on public.venda_parcelas for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- contas_pagar
drop policy "contas_pagar_authenticated" on public.contas_pagar;
create policy "contas_pagar_select" on public.contas_pagar for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "contas_pagar_admin_write" on public.contas_pagar for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- recebimentos
drop policy "recebimentos_authenticated" on public.recebimentos;
create policy "recebimentos_select" on public.recebimentos for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "recebimentos_admin_write" on public.recebimentos for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- entradas_estoque
drop policy "entradas_estoque_authenticated" on public.entradas_estoque;
create policy "entradas_estoque_select" on public.entradas_estoque for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "entradas_estoque_admin_write" on public.entradas_estoque for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- ajustes_estoque
drop policy "ajustes_estoque_authenticated" on public.ajustes_estoque;
create policy "ajustes_estoque_select" on public.ajustes_estoque for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "ajustes_estoque_admin_write" on public.ajustes_estoque for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- matriculas / matricula_parcelas
drop policy "matriculas_authenticated" on public.matriculas;
create policy "matriculas_select" on public.matriculas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "matriculas_admin_write" on public.matriculas for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

drop policy "matricula_parcelas_authenticated" on public.matricula_parcelas;
create policy "matricula_parcelas_select" on public.matricula_parcelas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "matricula_parcelas_admin_write" on public.matricula_parcelas for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

-- propostas / proposta_itens
drop policy "propostas_authenticated" on public.propostas;
create policy "propostas_select" on public.propostas for select to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));
create policy "propostas_admin_write" on public.propostas for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());

drop policy "proposta_itens_authenticated" on public.proposta_itens;
create policy "proposta_itens_select" on public.proposta_itens for select to authenticated
  using (is_usuario_ativo() and exists (
    select 1 from public.propostas p
    where p.id = proposta_itens.proposta_id
      and (is_admin() or p.empresa_id = current_empresa_id())
  ));
create policy "proposta_itens_admin_write" on public.proposta_itens for all to authenticated
  using (is_usuario_ativo() and is_admin())
  with check (is_usuario_ativo() and is_admin());
