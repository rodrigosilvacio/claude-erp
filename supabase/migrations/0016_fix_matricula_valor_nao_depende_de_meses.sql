-- Fix: duração do curso (meses) é só informativa — não deve multiplicar o
-- valor da matrícula. Quem define o valor é o preço do produto (serviço)
-- escolhido; meses continua salvo só pra registro (aparece no formulário e
-- no detalhe da matrícula), sem efeito em valor_total nem no valor de cada
-- parcela.
--
-- Renomeia valor_mensalidade -> valor_servico: o nome antigo sugeria "preço
-- por mês", o que deixa de fazer sentido agora que meses não entra na
-- conta — é só o snapshot do preço do produto no momento da matrícula.
alter table public.matriculas rename column valor_mensalidade to valor_servico;

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
  p_status text default 'ativa'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  v_data_matricula := coalesce(p_data_matricula, current_date);
  -- Duração (meses) é informativa — não entra nesta conta. O valor cobrado é
  -- o preço do produto (serviço), descontado o desconto informado.
  v_valor_total := greatest(v_preco - coalesce(p_desconto, 0), 0);
  v_valor_parcela := round(v_valor_total / p_numero_parcelas, 2);

  insert into public.matriculas (
    empresa_id, cliente_id, produto_id, data_matricula, meses, numero_parcelas,
    valor_servico, desconto, valor_total, forma_pagamento, observacoes, status
  )
  values (
    v_empresa_id, p_cliente_id, p_produto_id, v_data_matricula, p_meses, p_numero_parcelas,
    v_preco, coalesce(p_desconto, 0), v_valor_total, p_forma_pagamento, p_observacoes, p_status
  )
  returning id into v_matricula_id;

  for i in 1..p_numero_parcelas loop
    -- Última parcela absorve o resto do arredondamento das anteriores, pra
    -- soma das parcelas bater exatamente com valor_total.
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
$$;

revoke all on function public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text) from public;
grant execute on function public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text) to authenticated;
