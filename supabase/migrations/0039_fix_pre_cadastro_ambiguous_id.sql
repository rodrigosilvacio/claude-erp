-- Bug real: pre_cadastro_cliente (tela pública de pré-cadastro) falhava em
-- 100% das chamadas, com ou sem ?empresa= na URL. `RETURNS TABLE(id uuid,
-- nome text)` cria um parâmetro de saída chamado `id`; as duas consultas
-- internas "select id into v_empresa_id from public.empresas where ..."
-- referenciavam esse `id` sem qualificar de qual — o próprio parâmetro de
-- saída ou a coluna empresas.id — e o Postgres rejeitava a função inteira
-- com "column reference id is ambiguous" (42702) assim que a consulta era
-- de fato executada. A única linha já escrita corretamente na função era o
-- "returning clientes.id into v_id" do INSERT — as duas buscas de empresa
-- foram esquecidas na hora de qualificar.

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
set search_path = 'public'
as $function$
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
    select empresas.id into v_empresa_id from public.empresas where upper(codigo) = upper(trim(p_empresa_codigo)) and ativo = true;
    if v_empresa_id is null then
      raise exception 'Link de cadastro inválido.';
    end if;
  else
    select empresas.id into v_empresa_id from public.empresas where empresas.codigo = 'MATRIZ';
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
$function$;

-- Assinatura idêntica (mesmo nome/tipos/defaults) — CREATE OR REPLACE
-- substitui a função existente, sem gerar overload. Ainda assim, revalida
-- os grants por segurança (mesmo padrão do resto do projeto).
revoke all on function public.pre_cadastro_cliente(text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.pre_cadastro_cliente(text, text, text, text, text, text, text, text, text) to anon, authenticated;
