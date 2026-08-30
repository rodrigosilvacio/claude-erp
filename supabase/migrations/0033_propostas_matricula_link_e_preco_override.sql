-- CRM → Matrículas: mesma lógica de propostas.venda_id (migration 0032),
-- mas para o destino "serviço" — uma proposta aprovada com item de serviço
-- vira Matrícula, não Venda (Loja só vende produto físico). Como uma
-- proposta pode gerar mais de uma matrícula (N produtos de serviço
-- diferentes), esta coluna aponta pra última criada nessa conversão — as
-- demais continuam rastreáveis pelo texto "Convertida da proposta #N" nas
-- observações de cada matrícula (crm.js/matriculas.js).
alter table public.propostas
  add column matricula_id uuid references public.matriculas(id) on delete set null;

create index propostas_matricula_id_idx on public.propostas (matricula_id);

-- criar_matricula: aceita um valor de serviço "negociado" (da proposta),
-- em vez de sempre usar o preço de catálogo do produto. Parâmetro novo no
-- fim, com default null (nenhuma chamada existente muda de comportamento) —
-- mesmo racional de venda_itens.preco_unitario em criar_venda, que já é
-- controlado pelo chamador em vez de travado no preço de tabela.
--
-- Nota: como isto adiciona um parâmetro (muda a lista de tipos), `create or
-- replace` NÃO substitui a função de 10 parâmetros — cria um overload novo
-- ao lado dela. A função antiga foi derrubada manualmente após aplicar esta
-- migration (ver sessão) para não deixar duas versões soltas; quem reaplicar
-- este arquivo do zero num banco novo não passa por esse estado
-- intermediário (só existe uma função `criar_matricula`, com 11 parâmetros).
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

  if p_valor_servico_override is not null then
    v_preco := greatest(p_valor_servico_override, 0);
  end if;

  v_data_matricula := coalesce(p_data_matricula, current_date);
  -- Duração (meses) é informativa — não entra nesta conta. O valor cobrado é
  -- o preço do produto (serviço) — ou o valor negociado, se informado —,
  -- descontado o desconto informado.
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

-- Estado intermediário só neste banco (ver nota acima) — não afeta um banco
-- novo, onde só a versão de 11 parâmetros é criada.
drop function if exists public.criar_matricula(uuid, uuid, integer, integer, text, date, numeric, text, uuid, text);
