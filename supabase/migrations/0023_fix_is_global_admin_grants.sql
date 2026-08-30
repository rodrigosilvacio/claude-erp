-- is_global_admin() (migration 0020) foi criada sem revoke/grant explícitos
-- — ficou com o padrão do Postgres (EXECUTE liberado pra PUBLIC, incluindo
-- anon), diferente do resto das funções deste schema, que sempre fecham
-- explicitamente e reabrem só pra quem precisa (ver criar_venda,
-- atualizar_config_empresa, etc.). Sem risco de vazamento de dado (a função
-- só olha a sessão de quem chama, retorna false pra anon já que auth.uid()
-- é null), mas inconsistente com o padrão — fechado aqui por higiene,
-- flagrado pelo advisor de segurança do Supabase
-- (anon_security_definer_function_executable).
revoke all on function public.is_global_admin() from public;
grant execute on function public.is_global_admin() to authenticated;
