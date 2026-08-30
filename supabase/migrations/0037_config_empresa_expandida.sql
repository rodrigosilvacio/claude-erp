-- Painel de Configurações reestruturado: até aqui só dava para customizar
-- nome do app, menus visíveis e horários da Agenda por empresa. Para operar
-- várias contas de clientes diferentes no mesmo app (multi-tenant de
-- verdade), faltavam variáveis de identidade visual, regras de negócio e
-- limites de plano por empresa. Mesmo padrão de nome_aplicacao/
-- menus_habilitados (0011) e horarios_agenda (0018): tudo editável só por
-- admin global, via a mesma RPC atualizar_config_empresa.

alter table public.empresas add column cor_primaria text;
alter table public.empresas add column rodape_documentos text;
alter table public.empresas add column limite_usuarios integer check (limite_usuarios is null or limite_usuarios > 0);
alter table public.empresas add column dias_lembrete_vencimento integer not null default 1 check (dias_lembrete_vencimento >= 0);
alter table public.empresas add column papel_padrao_novo_usuario text not null default 'caixa' check (papel_padrao_novo_usuario in ('admin', 'caixa'));

comment on column public.empresas.cor_primaria is 'Cor de destaque (hex #RRGGBB) aplicada na sidebar/botões para usuários desta empresa. Nulo = usa a cor padrão do app.';
comment on column public.empresas.rodape_documentos is 'Texto customizado anexado ao rodapé de e-mails de proposta (CRM) enviados por esta empresa. Nulo = nenhum rodapé extra.';
comment on column public.empresas.limite_usuarios is 'Máximo de usuários ATIVOS que esta empresa pode ter (enforced em manage-usuarios, ação "create"). Nulo = sem limite.';
comment on column public.empresas.dias_lembrete_vencimento is 'Quantos dias antes do vencimento o lembrete de conta a pagar (appvendas-lembretes) é disparado para esta empresa. Padrão: 1.';
comment on column public.empresas.papel_padrao_novo_usuario is 'Papel pré-selecionado ao abrir "novo usuário" em Administração > Usuários para esta empresa.';

-- Assinatura muda (4 params -> 9) — precisa dropar a antiga explicitamente,
-- mesmo gotcha de sempre (ver 0018): CREATE OR REPLACE com lista de tipos
-- diferente cria um overload em vez de substituir, e a chamada antiga (com
-- só 4 argumentos) fica ambígua entre as duas versões.
drop function if exists public.atualizar_config_empresa(uuid, text, jsonb, text[]);

create or replace function public.atualizar_config_empresa(
  p_empresa_id uuid,
  p_nome_aplicacao text,
  p_menus_habilitados jsonb,
  p_horarios_agenda text[] default null,
  p_cor_primaria text default null,
  p_rodape_documentos text default null,
  p_limite_usuarios integer default null,
  p_dias_lembrete_vencimento integer default 1,
  p_papel_padrao_novo_usuario text default 'caixa'
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

  if p_cor_primaria is not null and trim(p_cor_primaria) <> '' and p_cor_primaria !~ '^#[0-9a-fA-F]{6}$' then
    raise exception 'Cor primária inválida — use o formato hexadecimal #RRGGBB.';
  end if;

  if p_limite_usuarios is not null and p_limite_usuarios <= 0 then
    raise exception 'O limite de usuários deve ser maior que zero (ou em branco para sem limite).';
  end if;

  if p_dias_lembrete_vencimento is null or p_dias_lembrete_vencimento < 0 then
    raise exception 'Dias de antecedência do lembrete deve ser zero ou mais.';
  end if;

  if p_papel_padrao_novo_usuario not in ('admin', 'caixa') then
    raise exception 'Papel padrão inválido.';
  end if;

  update public.empresas
  set nome_aplicacao = nullif(trim(p_nome_aplicacao), ''),
      menus_habilitados = coalesce(p_menus_habilitados, '{}'::jsonb),
      horarios_agenda = case when p_horarios_agenda is null or array_length(p_horarios_agenda, 1) is null then null else p_horarios_agenda end,
      cor_primaria = nullif(trim(p_cor_primaria), ''),
      rodape_documentos = nullif(trim(p_rodape_documentos), ''),
      limite_usuarios = p_limite_usuarios,
      dias_lembrete_vencimento = p_dias_lembrete_vencimento,
      papel_padrao_novo_usuario = p_papel_padrao_novo_usuario
  where id = p_empresa_id;
end;
$$;

revoke all on function public.atualizar_config_empresa(uuid, text, jsonb, text[], text, text, integer, integer, text) from public;
grant execute on function public.atualizar_config_empresa(uuid, text, jsonb, text[], text, text, integer, integer, text) to authenticated;
