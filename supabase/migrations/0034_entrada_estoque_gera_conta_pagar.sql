-- Roadmap Fase 1 — item 1: entrada de estoque pode gerar a conta a pagar
-- correspondente na hora, em vez de exigir que o operador digite fornecedor/
-- valor/vencimento de novo em Contas a Pagar logo em seguida. Opcional
-- (`p_gerar_conta_pagar`) — quem só quer registrar a entrada sem lançar
-- financeiro nenhum continua podendo.

alter table public.entradas_estoque
  add column conta_pagar_id uuid references public.contas_pagar(id) on delete set null;

create index entradas_estoque_conta_pagar_id_idx on public.entradas_estoque (conta_pagar_id);

-- Nota: como isto adiciona parâmetros (muda a lista de tipos), `create or
-- replace` não substitui a função de 5 parâmetros — cria um overload novo ao
-- lado dela (mesma pegadinha de criar_matricula, migration 0033). A função
-- antiga é derrubada no fim deste arquivo.
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
set search_path = public
as $$
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

  -- Lock na linha do produto: evita duas entradas simultâneas do mesmo
  -- produto perderem uma atualização de estoque (mesmo cuidado de
  -- criar_venda/confirmar_pagamento_stripe).
  select empresa_id, nome into v_produto_empresa_id, v_produto_nome from public.produtos where id = p_produto_id for update;

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

  -- criar_conta_pagar já revalida fornecedor/empresa e é security definer —
  -- chamado direto (não via RPC HTTP), mesmo padrão de uma função chamando
  -- outra dentro do mesmo módulo.
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
$$;

-- Estado intermediário só neste banco (ver nota acima) — não afeta um banco
-- novo, onde só a versão de 9 parâmetros é criada.
drop function if exists public.registrar_entrada_estoque(uuid, integer, date, text, uuid);
