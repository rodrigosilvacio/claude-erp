-- Reconstruído a partir do estado ao vivo do banco (migração real
-- 20260714133446 / harden_recebimentos_policy_search_path_and_fornecedor_empresa_check):
--
-- 1. A policy de `recebimentos` foi registrada para o papel {public} em vez
--    de {authenticated}, divergindo do padrão das demais tabelas.
-- 2. `set_updated_at` (usado em triggers de todas as tabelas com
--    updated_at) não fixava `search_path`, deixando a função vulnerável a
--    sequestro de search_path.
-- 3. Nada impedia vincular a um produto um fornecedor de outra empresa.

-- ── recebimentos: policy só para authenticated ──────────────────────────
drop policy "recebimentos_authenticated" on public.recebimentos;

create policy "recebimentos_authenticated" on public.recebimentos for all to authenticated
  using (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()))
  with check (is_usuario_ativo() and (is_admin() or empresa_id = current_empresa_id()));

-- ── set_updated_at: fixar search_path ───────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── produtos: fornecedor precisa pertencer à mesma empresa ──────────────
create or replace function public.check_produto_fornecedor_empresa()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.fornecedor_id is not null then
    if not exists (
      select 1 from public.fornecedores f
      where f.id = new.fornecedor_id and f.empresa_id = new.empresa_id
    ) then
      raise exception 'O fornecedor selecionado pertence a outra empresa.';
    end if;
  end if;
  return new;
end;
$$;

create trigger produtos_check_fornecedor_empresa
  before insert or update on public.produtos
  for each row execute function public.check_produto_fornecedor_empresa();
