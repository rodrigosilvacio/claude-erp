-- Agenda > "Link de agendamento": segunda via de marcar um atendimento,
-- além de um funcionário criar direto na Agenda — um link público
-- (agendamento-publico.html?empresa=<codigo>) que qualquer pessoa com
-- acesso pode usar para agendar um serviço sozinha, sem login. Mesmo
-- racional de pre_cadastro_cliente (migration 0005/0008): RPCs SECURITY
-- DEFINER liberadas para `anon`, únicas portas de entrada — a pessoa nunca
-- toca as tabelas diretamente.
--
-- Só agenda produto tipo='servico' (curso/mensalidade) — agendamento é
-- sobre marcar um horário de atendimento, não sobre vender um produto
-- físico (ver migration 0017, mesma distinção já usada no resto do app).

-- ── agenda_publica_info: dados pra montar a tela (nome da empresa,
-- horários configurados, catálogo de serviços agendáveis) ───────────────
create or replace function public.agenda_publica_info(p_empresa_codigo text default null)
returns table(
  empresa_id uuid,
  nome_exibicao text,
  horarios_agenda text[],
  servicos jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa_id uuid;
  v_nome_aplicacao text;
  v_nome_fantasia text;
  v_horarios text[];
begin
  if p_empresa_codigo is not null and trim(p_empresa_codigo) <> '' then
    select e.id, e.nome_aplicacao, e.nome_fantasia, e.horarios_agenda
      into v_empresa_id, v_nome_aplicacao, v_nome_fantasia, v_horarios
      from public.empresas e
      where upper(e.codigo) = upper(trim(p_empresa_codigo)) and e.ativo = true;
    if v_empresa_id is null then
      raise exception 'Link de agendamento inválido.';
    end if;
  else
    select e.id, e.nome_aplicacao, e.nome_fantasia, e.horarios_agenda
      into v_empresa_id, v_nome_aplicacao, v_nome_fantasia, v_horarios
      from public.empresas e
      where e.codigo = 'MATRIZ';
  end if;

  return query
  select
    v_empresa_id,
    coalesce(nullif(trim(v_nome_aplicacao), ''), v_nome_fantasia, 'BjjConnect'),
    coalesce(v_horarios, array['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00']),
    coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.nome, 'preco', p.preco) order by p.nome)
      from public.produtos p
      where p.empresa_id = v_empresa_id and p.ativo = true and p.tipo = 'servico'
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.agenda_publica_info(text) from public;
grant execute on function public.agenda_publica_info(text) to anon, authenticated;

-- ── horarios_ocupados_publico: horários já reservados numa data, pra
-- desabilitar no select em vez de deixar a pessoa escolher e só descobrir
-- o conflito ao enviar ────────────────────────────────────────────────
create or replace function public.horarios_ocupados_publico(p_empresa_id uuid, p_data date)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select to_char(a.horario, 'HH24:MI')
  from public.agendamentos a
  where a.empresa_id = p_empresa_id and a.data_agendamento = p_data and a.status <> 'cancelado';
$$;

revoke all on function public.horarios_ocupados_publico(uuid, date) from public;
grant execute on function public.horarios_ocupados_publico(uuid, date) to anon, authenticated;

-- ── agendar_publico: cria o agendamento (e o cliente, se ainda não
-- existir pelo documento) ────────────────────────────────────────────────
create or replace function public.agendar_publico(
  p_empresa_codigo text,
  p_nome text,
  p_documento text,
  p_produto_id uuid,
  p_data_agendamento date,
  p_horario time,
  p_telefone text default null,
  p_email text default null,
  p_observacoes text default null
)
returns table(id uuid, data_agendamento date, horario time, nome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := trim(p_nome);
  v_documento text := trim(p_documento);
  v_empresa_id uuid;
  v_horarios_permitidos text[];
  v_produto_tipo text;
  v_produto_ativo boolean;
  v_cliente_id uuid;
  v_agendamento_id uuid;
  v_recentes integer;
begin
  if v_nome = '' then
    raise exception 'Informe seu nome.';
  end if;

  if v_documento = '' then
    raise exception 'Informe seu CPF ou CNPJ.';
  end if;

  if p_produto_id is null then
    raise exception 'Selecione o serviço desejado.';
  end if;

  if p_data_agendamento is null or p_data_agendamento < current_date then
    raise exception 'Selecione uma data válida (a partir de hoje).';
  end if;

  if p_horario is null then
    raise exception 'Selecione um horário.';
  end if;

  if p_empresa_codigo is not null and trim(p_empresa_codigo) <> '' then
    select e.id, coalesce(e.horarios_agenda, array['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'])
      into v_empresa_id, v_horarios_permitidos
      from public.empresas e
      where upper(e.codigo) = upper(trim(p_empresa_codigo)) and e.ativo = true;
    if v_empresa_id is null then
      raise exception 'Link de agendamento inválido.';
    end if;
  else
    select e.id, coalesce(e.horarios_agenda, array['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'])
      into v_empresa_id, v_horarios_permitidos
      from public.empresas e
      where e.codigo = 'MATRIZ';
  end if;

  -- Trava o horário na grade configurada da empresa — sem isso, alguém
  -- chamando a RPC direto (fora do formulário) poderia marcar num horário
  -- fora do expediente.
  if not (to_char(p_horario, 'HH24:MI') = any(v_horarios_permitidos)) then
    raise exception 'Horário indisponível para agendamento.';
  end if;

  select p.tipo, p.ativo into v_produto_tipo, v_produto_ativo
  from public.produtos p where p.id = p_produto_id and p.empresa_id = v_empresa_id;

  if v_produto_tipo is null or v_produto_ativo is not true then
    raise exception 'Serviço não encontrado.';
  end if;

  if v_produto_tipo <> 'servico' then
    raise exception 'Este item não está disponível para agendamento público.';
  end if;

  -- Mesmo limite (por empresa/janela) usado em pre_cadastro_cliente — aqui
  -- o risco é pior que spam de cadastro: um bot conseguiria ocupar horários
  -- de verdade e travar clientes reais de agendar.
  select count(*) into v_recentes
  from public.agendamentos
  where empresa_id = v_empresa_id and created_at > now() - interval '10 minutes';

  if v_recentes >= 30 then
    raise exception 'Recebemos muitos agendamentos por aqui nos últimos minutos. Tente novamente em alguns instantes.';
  end if;

  -- Encontra cliente existente pelo documento (mesma empresa); cria um novo
  -- "pendente" se não achar — o agendamento em si não depende de aprovação,
  -- só o cadastro completo do cliente segue o mesmo fluxo de revisão do
  -- pré-cadastro (ver clientes.js).
  select c.id into v_cliente_id
  from public.clientes c
  where c.empresa_id = v_empresa_id
    and regexp_replace(c.documento, '\D', '', 'g') = regexp_replace(v_documento, '\D', '', 'g');

  if v_cliente_id is null then
    begin
      insert into public.clientes (empresa_id, nome, documento, email, telefone, ativo, status_cadastro)
      values (v_empresa_id, v_nome, v_documento, nullif(trim(p_email), ''), nullif(trim(p_telefone), ''), false, 'pendente')
      returning clientes.id into v_cliente_id;
    exception when unique_violation then
      -- Corrida com outro pedido pro mesmo documento — reaproveita o que
      -- acabou de ser criado em vez de falhar o agendamento à toa.
      select c.id into v_cliente_id
      from public.clientes c
      where c.empresa_id = v_empresa_id
        and regexp_replace(c.documento, '\D', '', 'g') = regexp_replace(v_documento, '\D', '', 'g');
    end;
  end if;

  begin
    insert into public.agendamentos (empresa_id, cliente_id, produto_id, data_agendamento, horario, observacoes, status)
    values (v_empresa_id, v_cliente_id, p_produto_id, p_data_agendamento, p_horario, nullif(trim(p_observacoes), ''), 'agendado')
    returning agendamentos.id into v_agendamento_id;
  exception when unique_violation then
    raise exception 'Esse horário acabou de ser reservado por outra pessoa. Escolha outro horário.';
  end;

  return query select v_agendamento_id, p_data_agendamento, p_horario, v_nome;
end;
$$;

revoke all on function public.agendar_publico(text, text, text, uuid, date, time, text, text, text) from public;
grant execute on function public.agendar_publico(text, text, text, uuid, date, time, text, text, text) to anon, authenticated;
