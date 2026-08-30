-- Horários da Agenda configuráveis por empresa: hoje HORARIOS era uma
-- constante fixa (08:00–17:00, de hora em hora) pro sistema inteiro, sem
-- fazer sentido para empresas com grades diferentes. Nulo/vazio = usa a
-- lista padrão do frontend (agenda.js). Mesmo padrão de nome_aplicacao/
-- menus_habilitados (migration 0011): editável só por admin global.

alter table public.empresas add column horarios_agenda text[];
comment on column public.empresas.horarios_agenda is 'Horários de atendimento da Agenda desta empresa (ex.: {08:00,09:00,...}). Nulo/vazio = usa a lista padrão do app.';

-- Assinatura muda (3 params -> 4) — precisa dropar a antiga explicitamente,
-- senão vira overload e a chamada existente (sem p_horarios_agenda) fica
-- ambígua entre as duas versões. Mesmo problema já visto em criar_venda/
-- pre_cadastro_cliente (ver 0006/0013).
drop function if exists public.atualizar_config_empresa(uuid, text, jsonb);

create or replace function public.atualizar_config_empresa(
  p_empresa_id uuid,
  p_nome_aplicacao text,
  p_menus_habilitados jsonb,
  p_horarios_agenda text[] default null
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
      menus_habilitados = coalesce(p_menus_habilitados, '{}'::jsonb),
      horarios_agenda = case when p_horarios_agenda is null or array_length(p_horarios_agenda, 1) is null then null else p_horarios_agenda end
  where id = p_empresa_id;
end;
$$;

revoke all on function public.atualizar_config_empresa(uuid, text, jsonb, text[]) from public;
grant execute on function public.atualizar_config_empresa(uuid, text, jsonb, text[]) to authenticated;
