-- Mitiga spam na rota pública de pré-cadastro (pre-cadastro.html), que
-- insere direto em `clientes` como "pendente" sem exigir login. O
-- front-end já ganhou um honeypot e um tempo mínimo de preenchimento
-- (pre-cadastro.js), mas isso não impede alguém de chamar a RPC
-- diretamente com a chave anon — por isso o limite abaixo é aplicado
-- dentro da própria função, no servidor.
--
-- Limite simples por empresa e janela de tempo (sem depender de IP, que a
-- RPC não recebe de forma confiável): no máximo 20 pré-cadastros pendentes
-- criados nos últimos 10 minutos para a mesma empresa.
create or replace function public.pre_cadastro_cliente(
  p_nome text,
  p_documento text,
  p_email text default null,
  p_telefone text default null,
  p_cep text default null,
  p_cidade text default null,
  p_uf text default null,
  p_endereco text default null,
  p_empresa_codigo text default null
)
returns table(id uuid, nome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text := trim(p_nome);
  v_documento text := trim(p_documento);
  v_id uuid;
  v_empresa_id uuid;
  v_recentes integer;
  v_ja_existe_msg text := 'Já existe um cadastro com este CPF/CNPJ em nossa base. Se você acredita que isso é um engano, fale com a nossa equipe.';
begin
  if v_nome = '' then
    raise exception 'Informe seu nome.';
  end if;

  if v_documento = '' then
    raise exception 'Informe seu CPF ou CNPJ.';
  end if;

  if p_empresa_codigo is not null and trim(p_empresa_codigo) <> '' then
    select id into v_empresa_id from public.empresas where upper(codigo) = upper(trim(p_empresa_codigo)) and ativo = true;
    if v_empresa_id is null then
      raise exception 'Link de cadastro inválido.';
    end if;
  else
    select id into v_empresa_id from public.empresas where codigo = 'MATRIZ';
  end if;

  select count(*) into v_recentes
  from public.clientes
  where empresa_id = v_empresa_id
    and status_cadastro = 'pendente'
    and created_at > now() - interval '10 minutes';

  if v_recentes >= 20 then
    raise exception 'Recebemos muitos cadastros por aqui nos últimos minutos. Tente novamente em alguns instantes.';
  end if;

  if exists (
    select 1 from public.clientes c
    where c.empresa_id = v_empresa_id
      and regexp_replace(c.documento, '\D', '', 'g') = regexp_replace(v_documento, '\D', '', 'g')
  ) then
    raise exception '%', v_ja_existe_msg;
  end if;

  begin
    insert into public.clientes (empresa_id, nome, documento, email, telefone, cep, cidade, uf, endereco, ativo, status_cadastro)
    values (
      v_empresa_id, v_nome, v_documento,
      nullif(trim(p_email), ''), nullif(trim(p_telefone), ''), nullif(trim(p_cep), ''),
      nullif(trim(p_cidade), ''), nullif(trim(p_uf), ''), nullif(trim(p_endereco), ''),
      false, 'pendente'
    )
    returning clientes.id into v_id;
  exception when unique_violation then
    raise exception '%', v_ja_existe_msg;
  end;

  return query select v_id, v_nome;
end;
$$;

grant execute on function public.pre_cadastro_cliente(text, text, text, text, text, text, text, text, text) to anon, authenticated;
