-- Log de auditoria do próprio ERPConnect. A tabela `audit_logs` que já
-- existia no projeto pertence a outro app (chave `report_id` sem relação
-- com nada daqui) — o ERPConnect nunca teve rastreabilidade de quem alterou
-- preço, editou/excluiu cadastro, etc. Cobre as tabelas onde isso mais
-- importa: produtos (preço/custo/estoque mínimo), clientes, fornecedores,
-- vendas, matrículas e contas_pagar — snapshot completo de antes/depois,
-- não só os campos "sensíveis" (mais simples e mais útil de auditar).

create table public.erp_audit_log (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references public.empresas(id) on delete cascade,
  usuario_id uuid references public.usuarios(id) on delete set null,
  tabela text not null,
  registro_id uuid,
  acao text not null check (acao in ('insert', 'update', 'delete')),
  dados_antes jsonb,
  dados_depois jsonb,
  created_at timestamptz not null default now()
);

comment on table public.erp_audit_log is 'Auditoria de mutações do ERPConnect (produtos/clientes/fornecedores/vendas/matriculas/contas_pagar), preenchida por trigger genérica (registrar_auditoria). Só consulta — nada aqui é escrito por usuário/API, apenas pelo trigger via SECURITY DEFINER.';

create index idx_erp_audit_log_empresa on public.erp_audit_log(empresa_id, created_at desc);
create index idx_erp_audit_log_tabela on public.erp_audit_log(tabela, registro_id);

alter table public.erp_audit_log enable row level security;

-- Só admin (da própria empresa, ou global) enxerga o log — é dado sensível
-- (histórico de preços/exclusões), não é operação do dia a dia de vendedor.
create policy erp_audit_log_select on public.erp_audit_log
  for select
  using (is_usuario_ativo() and is_admin() and (is_global_admin() or empresa_id = current_empresa_id()));

-- Sem policy de insert/update/delete para authenticated/anon: a única
-- escrita é via trigger SECURITY DEFINER abaixo, que roda com o
-- privilégio do dono da função (bypassa RLS por ownership, não por policy).
revoke all on public.erp_audit_log from authenticated, anon;
grant select on public.erp_audit_log to authenticated;

create or replace function public.registrar_auditoria()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_registro_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_empresa_id := old.empresa_id;
    v_registro_id := old.id;
  else
    v_empresa_id := new.empresa_id;
    v_registro_id := new.id;
  end if;

  insert into public.erp_audit_log (empresa_id, usuario_id, tabela, registro_id, acao, dados_antes, dados_depois)
  values (
    v_empresa_id,
    auth.uid(),
    TG_TABLE_NAME,
    v_registro_id,
    lower(TG_OP),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

comment on function public.registrar_auditoria() is 'Trigger genérica de auditoria, reaproveitada em várias tabelas via TG_TABLE_NAME/TG_OP — grava snapshot completo (antes/depois) em erp_audit_log a cada INSERT/UPDATE/DELETE.';

create trigger trg_audit_produtos after insert or update or delete on public.produtos for each row execute function public.registrar_auditoria();
create trigger trg_audit_clientes after insert or update or delete on public.clientes for each row execute function public.registrar_auditoria();
create trigger trg_audit_fornecedores after insert or update or delete on public.fornecedores for each row execute function public.registrar_auditoria();
create trigger trg_audit_vendas after insert or update or delete on public.vendas for each row execute function public.registrar_auditoria();
create trigger trg_audit_matriculas after insert or update or delete on public.matriculas for each row execute function public.registrar_auditoria();
create trigger trg_audit_contas_pagar after insert or update or delete on public.contas_pagar for each row execute function public.registrar_auditoria();
