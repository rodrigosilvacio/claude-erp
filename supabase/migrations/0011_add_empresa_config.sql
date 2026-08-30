-- Configuração por empresa: nome customizado da aplicação (white-label) e
-- quais itens de menu operacionais ficam visíveis para os usuários daquela
-- empresa. Editável apenas por administradores globais (usuarios.role =
-- 'admin' e empresa_id nulo) — um admin vinculado a uma empresa específica
-- não deve poder alterar a própria "casca" do app nem a de outra empresa.

alter table public.empresas add column nome_aplicacao text;
alter table public.empresas add column menus_habilitados jsonb not null default '{}'::jsonb;

comment on column public.empresas.nome_aplicacao is 'Nome exibido na sidebar/título para usuários desta empresa. Nulo/vazio = usa o nome padrão do app.';
comment on column public.empresas.menus_habilitados is 'Mapa {chave_da_rota: boolean}. Ausente ou true = item de menu visível; false = escondido para usuários desta empresa.';

-- RPC dedicada em vez de liberar a coluna pela policy genérica de UPDATE em
-- empresas (que hoje permite qualquer admin, inclusive vinculado a uma única
-- empresa, editar cadastro de qualquer empresa) — aqui a checagem de admin
-- GLOBAL fica centralizada e vale também se a policy de empresas mudar no
-- futuro.
create or replace function public.atualizar_config_empresa(
  p_empresa_id uuid,
  p_nome_aplicacao text,
  p_menus_habilitados jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() and public.current_empresa_id() is null) then
    raise exception 'Apenas administradores globais podem alterar estas configurações.';
  end if;

  update public.empresas
  set nome_aplicacao = nullif(trim(p_nome_aplicacao), ''),
      menus_habilitados = coalesce(p_menus_habilitados, '{}'::jsonb)
  where id = p_empresa_id;
end;
$$;

revoke all on function public.atualizar_config_empresa(uuid, text, jsonb) from public;
grant execute on function public.atualizar_config_empresa(uuid, text, jsonb) to authenticated;
