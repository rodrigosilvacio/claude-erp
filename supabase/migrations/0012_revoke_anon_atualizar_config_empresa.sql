-- 0011 revogou de `public` e concedeu a `authenticated`, mas esqueceu de
-- revogar explicitamente de `anon` — mesmo padrão de fechamento usado em
-- 0006 para criar_venda. A função já se protege sozinha (raise exception se
-- quem chama não for admin global), mas fechar o grant evita que ela apareça
-- na API pública para quem nem está logado.
revoke execute on function public.atualizar_config_empresa(uuid, text, jsonb) from anon;
