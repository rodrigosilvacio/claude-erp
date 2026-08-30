-- Corrige escalonamento de privilégio entre empresas: um admin vinculado a
-- uma única empresa conseguia promover a si mesmo (ou qualquer usuário) a
-- admin global bastando um UPDATE em usuarios.empresa_id = null, porque a
-- policy de update só checava is_admin() — sem comparar a empresa do alvo
-- com a de quem chama. O mesmo buraco existia nas policies de leitura/
-- escrita de empresas (qualquer admin lia/editava o cadastro de qualquer
-- empresa, não só a própria).
--
-- O padrão de correção (is_admin() and current_empresa_id() is null =
-- "admin global") já existia desde a migration 0011
-- (atualizar_config_empresa) — extraído aqui para uma função reutilizável e
-- replicado nas policies genéricas de usuarios/empresas.
--
-- A superfície de ataque real na aplicação é a edge function
-- manage-usuarios (roda com service role, contorna RLS por completo) —
-- corrigida separadamente no código da function. Estas policies são a
-- segunda camada de defesa, para qualquer acesso direto às tabelas com uma
-- sessão authenticated (ex.: chamada supabase-js fora da edge function).

create or replace function public.is_global_admin()
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select public.is_admin() and public.current_empresa_id() is null;
$$;

-- ── usuarios ──────────────────────────────────────────────────────────────
-- Select: além da própria linha, um admin de empresa só enxerga usuários da
-- própria empresa (antes via is_admin() enxergava todo mundo, de qualquer
-- empresa).
drop policy "usuarios_select" on public.usuarios;
create policy "usuarios_select" on public.usuarios for select to authenticated
  using (
    id = auth.uid()
    or is_global_admin()
    or (is_admin() and empresa_id = current_empresa_id())
  );

-- Update: um admin de empresa só atualiza usuários da própria empresa, e o
-- "with check" trava o valor final de empresa_id à própria empresa — não dá
-- para nulificar (virar global) nem mover o usuário para outra empresa.
drop policy "usuarios_update_admin" on public.usuarios;
create policy "usuarios_update_admin" on public.usuarios for update to authenticated
  using (
    is_global_admin()
    or (is_admin() and empresa_id = current_empresa_id())
  )
  with check (
    is_global_admin()
    or (is_admin() and empresa_id = current_empresa_id())
  );

-- ── empresas ──────────────────────────────────────────────────────────────
-- Select: um admin de empresa só enxerga a própria empresa (antes via
-- is_admin() enxergava o cadastro de todas as empresas).
drop policy "empresas_select" on public.empresas;
create policy "empresas_select" on public.empresas for select to authenticated
  using (
    is_usuario_ativo() and (
      is_global_admin()
      or id = current_empresa_id()
    )
  );

-- Write: gestão de empresas (criar, editar cadastro, ativar/desativar) passa
-- a ser exclusiva de admin global — mesmo racional já aplicado em
-- atualizar_config_empresa (migration 0011). Um admin de empresa não deve
-- conseguir editar (ou desativar) o cadastro de outra empresa nem o da
-- própria por esta policy genérica.
drop policy "empresas_admin_write" on public.empresas;
create policy "empresas_admin_write" on public.empresas for all to authenticated
  using (is_global_admin())
  with check (is_global_admin());
