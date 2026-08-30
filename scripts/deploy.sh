#!/usr/bin/env bash
# Aplica as migrations e faz deploy de todas as Edge Functions no projeto
# Supabase já linkado (`supabase link --project-ref <ref>` — ver
# scripts/README.md se ainda não fez isso).
#
# Uso: ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v supabase &> /dev/null; then
  echo "Supabase CLI não encontrado. Instale: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

echo "== 1/2 — aplicando migrations (supabase/migrations) =="
supabase db push

echo
echo "== 2/2 — deploy das Edge Functions =="
# verify_jwt de cada uma vem de supabase/config.toml — não precisa repetir
# aqui com --no-verify-jwt.
FUNCTIONS=(
  manage-usuarios
  appvendas-lembretes
  enviar-proposta
  create-stripe-checkout
  stripe-webhook
  enviar-confirmacao-negocio
  mcp-cep
)
for fn in "${FUNCTIONS[@]}"; do
  echo "-- deploy: $fn"
  supabase functions deploy "$fn"
done

cat <<'EOF'

Deploy concluído. Próximos passos:
  1. ./scripts/set-secrets.sh          (se ainda não rodou)
  2. ./scripts/bootstrap-admin.sh      (criar o primeiro usuário admin)
  3. Preencher assets/supabaseClient.js com a URL/anon key do projeto e
     publicar os arquivos estáticos (ver scripts/README.md).
EOF
