-- Movimentações > Matrículas: contratação de um curso/serviço por um
-- cliente, com parcelamento e geração automática de títulos a receber com
-- vencimento futuro (matricula_parcelas). Mesma UX de pagamento da Loja
-- (vendas) — tiles de forma de pagamento, incluindo Stripe — mas sem baixa
-- de estoque: matrícula é serviço, não produto físico.
--
-- Pagamento parcelado + Stripe: uma Checkout Session é cobrança única, não
-- assinatura recorrente. Por isso o Stripe cobra só a 1ª parcela no ato da
-- matrícula (ver create-stripe-checkout); as parcelas seguintes nascem
-- 'pendente' com vencimento futuro e são recebidas manualmente no balcão
-- (registrar_pagamento_parcela_matricula), mês a mês, como um carnê. Para as
-- demais formas de pagamento (Dinheiro/Pix/Cartão/Boleto), a 1ª parcela já
-- nasce paga (dinheiro trocou de mão na hora da matrícula) e as seguintes
-- seguem pendentes do mesmo jeito.

-- ── add_months_clamped: soma meses a uma data "grudando" no último dia do
-- mês de destino quando ele for mais curto (ex.: matrícula em 31/jan + 1 mês
-- vence 28/29 fev, não "estoura" pra março) — evita o comportamento padrão
-- do Postgres de rolar a data pro mês seguinte nesse caso.
create or replace function public.add_months_clamped(p_data date, p_meses integer)
returns date
language sql
immutable
as $$
  select least(
    (date_trunc('month', p_data) + (p_meses || ' months')::interval)::date + (extract(day from p_data)::int - 1),
    ((date_trunc('month', p_data) + (p_meses || ' months')::interval) + interval '1 month' - interval '1 day')::date
  );
$$;

-- ── Matrículas (cabeçalho) ──────────────────────────────────────────────
create table public.matriculas (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  empresa_id uuid not null references public.empresas(id),
  cliente_id uuid not null references public.clientes(id) on delete restrict,
  produto_id uuid not null references public.produtos(id) on delete restrict,
  data_matricula date not null default current_date,
  meses integer not null check (meses > 0),
  numero_parcelas integer not null check (numero_parcelas > 0),
  valor_mensalidade numeric(12,2) not null check (valor_mensalidade >= 0),
  desconto numeric(12,2) not null default 0 check (desconto >= 0),
  valor_total numeric(12,2) not null check (valor_total >= 0),
  forma_pagamento text,
  observacoes text,
  status text not null default 'ativa' check (status in ('ativa', 'aguardando_pagamento', 'cancelada')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index matriculas_empresa_data_idx on public.matriculas (empresa_id, data_matricula desc);
create index matriculas_cliente_id_idx on public.matriculas (cliente_id);
create index matriculas_status_idx on public.matriculas (status);

create trigger matriculas_set_updated_at
  before update on public.matriculas
  for each row execute function public.set_updated_at();

comment on column public.matriculas.stripe_checkout_session_id is 'Preenchido só na confirmação do pagamento da 1ª parcela (evento checkout.session.completed) — não existe enquanto a matrícula está aguardando_pagamento.';
comment on column public.matriculas.stripe_payment_intent_id is 'Payment Intent do Stripe da 1ª parcela, preenchido junto com stripe_checkout_session_id.';

-- ── Parcelas da matrícula (títulos a receber, com vencimento futuro) ────
create table public.matricula_parcelas (
  id uuid primary key default gen_random_uuid(),
  matricula_id uuid not null references public.matriculas(id) on delete cascade,
  empresa_id uuid not null references public.empresas(id),
  cliente_id uuid not null references public.clientes(id) on delete restrict,
  numero_parcela integer not null check (numero_parcela > 0),
  valor numeric(12,2) not null check (valor >= 0),
  data_vencimento date not null,
  data_pagamento date,
  forma_pagamento text,
  status text not null default 'pendente' check (status in ('pendente', 'pago', 'cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (matricula_id, numero_parcela)
);

create index matricula_parcelas_empresa_vencimento_idx on public.matricula_parcelas (empresa_id, data_vencimento);
create index matricula_parcelas_matricula_id_idx on public.matricula_parcelas (matricula_id);
create index matricula_parcelas_cliente_id_idx on public.matricula_parcelas (cliente_id);

create trigger matricula_parcelas_set_updated_at
  before update on public.matricula_parcelas
  for each row execute function public.set_updated_at();

-- ── RLS: mesmo padrão multiempresa de contas_pagar/entradas_estoque ─────
alter table public.matriculas enable row level security;
alter table public.matricula_parcelas enable row level security;

create policy "matriculas_authenticated" on public.matriculas for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

create policy "matricula_parcelas_authenticated" on public.matricula_parcelas for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── criar_matricula: cria o cabeçalho + gera as N parcelas de uma vez.
-- p_status 'ativa' (padrão, pagamento imediato: Dinheiro/Pix/Cartão/Boleto)
-- marca a parcela 1 como paga na hora; 'aguardando_pagamento' (fluxo Stripe)
-- deixa todas pendentes até o webhook confirmar a 1ª parcela — ver
-- confirmar_pagamento_stripe_matricula.
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
  v_valor_total := greatest(v_preco * p_meses - coalesce(p_desconto, 0), 0);
  v_valor_parcela := round(v_valor_total / p_numero_parcelas, 2);

  insert into public.matriculas (
    empresa_id, cliente_id, produto_id, data_matricula, meses, numero_parcelas,
    valor_mensalidade, desconto, valor_total, forma_pagamento, observacoes, status
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

-- ── registrar_pagamento_parcela_matricula: baixa manual de uma parcela
-- futura (o aluno pagou no balcão) — mesmo padrão de
-- registrar_pagamento_conta_pagar.
create or replace function public.registrar_pagamento_parcela_matricula(
  p_parcela_id uuid,
  p_data_pagamento date default null,
  p_forma_pagamento text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_empresa_id uuid;
  v_matricula_id uuid;
  v_matricula_status text;
begin
  select status, empresa_id, matricula_id into v_status, v_empresa_id, v_matricula_id
  from public.matricula_parcelas where id = p_parcela_id for update;

  if v_status is null then
    raise exception 'Parcela % não encontrada', p_parcela_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para alterar esta parcela.';
  end if;

  if v_status <> 'pendente' then
    raise exception 'Esta parcela já foi paga ou cancelada.';
  end if;

  select status into v_matricula_status from public.matriculas where id = v_matricula_id;
  if v_matricula_status = 'cancelada' then
    raise exception 'Esta matrícula está cancelada.';
  end if;

  update public.matricula_parcelas
  set status = 'pago',
      data_pagamento = coalesce(p_data_pagamento, current_date),
      forma_pagamento = coalesce(p_forma_pagamento, forma_pagamento)
  where id = p_parcela_id;
end;
$$;

revoke all on function public.registrar_pagamento_parcela_matricula(uuid, date, text) from public;
grant execute on function public.registrar_pagamento_parcela_matricula(uuid, date, text) to authenticated;

-- ── cancelar_matricula: idempotente, mesmo padrão de cancelar_conta_pagar.
-- Só cancela parcelas ainda pendentes — parcelas já pagas ficam como
-- histórico financeiro.
create or replace function public.cancelar_matricula(p_matricula_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_empresa_id uuid;
begin
  select status, empresa_id into v_status, v_empresa_id from public.matriculas where id = p_matricula_id for update;

  if v_status is null then
    raise exception 'Matrícula % não encontrada', p_matricula_id;
  end if;

  if not (is_admin() or v_empresa_id = current_empresa_id()) then
    raise exception 'Você não tem permissão para cancelar esta matrícula.';
  end if;

  if v_status = 'cancelada' then
    return;
  end if;

  update public.matricula_parcelas set status = 'cancelado' where matricula_id = p_matricula_id and status = 'pendente';
  update public.matriculas set status = 'cancelada' where id = p_matricula_id;
end;
$$;

revoke all on function public.cancelar_matricula(uuid) from public;
grant execute on function public.cancelar_matricula(uuid) to authenticated;

-- ── confirmar_pagamento_stripe_matricula / marcar_stripe_pagamento_falhou_matricula
-- Chamadas só pelo webhook (stripe-webhook), com a service role — mesmo
-- racional de confirmar_pagamento_stripe/marcar_stripe_pagamento_falhou
-- (vendas, ver 0013): a única checagem de "o pagamento realmente aconteceu"
-- é ter chegado até aqui vindo do webhook com assinatura do Stripe validada.
create or replace function public.confirmar_pagamento_stripe_matricula(
  p_matricula_id uuid,
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
begin
  select status into v_status from public.matriculas where id = p_matricula_id for update;

  if v_status is null then
    raise exception 'Matrícula % não encontrada', p_matricula_id;
  end if;

  -- Idempotente: o Stripe pode reentregar o mesmo evento de webhook.
  if v_status = 'ativa' then
    return;
  end if;

  if v_status <> 'aguardando_pagamento' then
    raise exception 'Matrícula % não está aguardando pagamento (status atual: %)', p_matricula_id, v_status;
  end if;

  update public.matricula_parcelas
  set status = 'pago', data_pagamento = current_date, forma_pagamento = 'Stripe'
  where matricula_id = p_matricula_id and numero_parcela = 1;

  update public.matriculas
  set status = 'ativa',
      stripe_checkout_session_id = p_stripe_checkout_session_id,
      stripe_payment_intent_id = p_stripe_payment_intent_id
  where id = p_matricula_id;
end;
$$;

revoke all on function public.confirmar_pagamento_stripe_matricula(uuid, text, text) from public;
grant execute on function public.confirmar_pagamento_stripe_matricula(uuid, text, text) to service_role;

create or replace function public.marcar_stripe_pagamento_falhou_matricula(p_matricula_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.matriculas where id = p_matricula_id for update;

  if v_status is null then
    raise exception 'Matrícula % não encontrada', p_matricula_id;
  end if;

  -- Idempotente / já resolvida por outro caminho — não faz nada.
  if v_status <> 'aguardando_pagamento' then
    return;
  end if;

  update public.matricula_parcelas set status = 'cancelado' where matricula_id = p_matricula_id;
  update public.matriculas set status = 'cancelada' where id = p_matricula_id;
end;
$$;

revoke all on function public.marcar_stripe_pagamento_falhou_matricula(uuid) from public;
grant execute on function public.marcar_stripe_pagamento_falhou_matricula(uuid) to service_role;
