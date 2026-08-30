-- Roadmap Fase 2 — item "Kardex de estoque": hoje o saldo de produtos.estoque
-- muda por 3 caminhos (entrada manual, baixa de venda confirmada, devolução
-- de venda cancelada) mas só o primeiro tem um lançamento próprio
-- (entradas_estoque). Não existe forma de corrigir uma contagem física
-- divergente (perda, quebra, achado) sem mexer direto no banco. Esta
-- migração fecha essa lacuna com uma tabela de ajuste manual auditável, no
-- mesmo padrão de entradas_estoque (0014) — o extrato "Kardex" em si (tela
-- estoques.js) é montado no front cruzando entradas_estoque + ajustes_estoque
-- + venda_itens de vendas confirmadas, sem precisar de uma tabela de ledger
-- unificada nova.

create table public.ajustes_estoque (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  produto_id uuid not null references public.produtos(id),
  -- positivo = sobra/achado na contagem; negativo = perda/quebra.
  quantidade integer not null check (quantidade <> 0),
  motivo text not null,
  created_at timestamptz not null default now()
);

create index ajustes_estoque_empresa_data_idx on public.ajustes_estoque (empresa_id, created_at);
create index ajustes_estoque_produto_id_idx on public.ajustes_estoque (produto_id);

create trigger ajustes_estoque_set_empresa_id
  before insert on public.ajustes_estoque
  for each row execute function public.set_empresa_id();

alter table public.ajustes_estoque enable row level security;

create policy "ajustes_estoque_authenticated" on public.ajustes_estoque for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── registrar_ajuste_estoque ─────────────────────────────────────────────
create or replace function public.registrar_ajuste_estoque(
  p_produto_id uuid,
  p_quantidade integer,
  p_motivo text,
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

  -- Lock na linha do produto: mesmo cuidado de registrar_entrada_estoque
  -- (evita duas escritas simultâneas perderem uma atualização de saldo).
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

  insert into public.ajustes_estoque (empresa_id, produto_id, quantidade, motivo)
  values (v_empresa_id, p_produto_id, p_quantidade, trim(p_motivo))
  returning id into v_ajuste_id;

  update public.produtos set estoque = estoque + p_quantidade where id = p_produto_id;

  return v_ajuste_id;
end;
$$;

revoke all on function public.registrar_ajuste_estoque(uuid, integer, text, uuid) from public;
grant execute on function public.registrar_ajuste_estoque(uuid, integer, text, uuid) to authenticated;
