#!/usr/bin/env bash
# Lê scripts/.env (copiado de .env.example e preenchido por você) e envia
# cada chave não-vazia para `supabase secrets set` no projeto já linkado.
#
# Uso:
#   cp scripts/.env.example scripts/.env   # uma vez, e preencha os valores
#   ./scripts/set-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v supabase &> /dev/null; then
  echo "Supabase CLI não encontrado. Instale: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

ENV_FILE="scripts/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Não encontrei $ENV_FILE. Copie scripts/.env.example para $ENV_FILE e preencha os valores primeiro." >&2
  exit 1
fi

ARGS=()
while IFS='=' read -r key value; do
  # Ignora linhas em branco, comentários (#) e chaves sem valor preenchido.
  [[ -z "$key" || "$key" == \#* ]] && continue
  [[ -z "$value" ]] && { echo "  (pulando $key — vazio em $ENV_FILE)"; continue; }
  ARGS+=("$key=$value")
done < "$ENV_FILE"

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "Nenhuma variável preenchida em $ENV_FILE — nada para enviar." >&2
  exit 1
fi

echo "Enviando ${#ARGS[@]} secret(s) para o projeto linkado..."
supabase secrets set "${ARGS[@]}"
echo "Pronto. Confira com: supabase secrets list"
