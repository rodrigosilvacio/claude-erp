#!/usr/bin/env bash
# Cria o primeiro usuário administrador (global) do zero, chamando a Edge
# Function manage-usuarios com o bootstrap_secret — necessário porque, com
# a tabela `usuarios` vazia, ninguém consegue logar pra criar o primeiro
# admin pela tela normal. Rode uma única vez, depois do deploy.sh e do
# set-secrets.sh (precisa de APPVENDAS_BOOTSTRAP_SECRET já configurado).
#
# Uso: ./scripts/bootstrap-admin.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v curl &> /dev/null; then
  echo "curl não encontrado." >&2
  exit 1
fi

# Tenta ler SUPABASE_URL/SUPABASE_KEY de assets/supabaseClient.js (fonte
# única de verdade, se você já preencheu com os dados do seu projeto).
CLIENT_FILE="assets/supabaseClient.js"
DEFAULT_URL=""
DEFAULT_ANON_KEY=""
if [ -f "$CLIENT_FILE" ]; then
  DEFAULT_URL=$(grep -oE 'SUPABASE_URL = "[^"]+"' "$CLIENT_FILE" | sed -E 's/.*"([^"]+)"/\1/' || true)
  DEFAULT_ANON_KEY=$(grep -oE 'SUPABASE_KEY = "[^"]+"' "$CLIENT_FILE" | sed -E 's/.*"([^"]+)"/\1/' || true)
fi

read -rp "URL do projeto Supabase [${DEFAULT_URL:-obrigatório}]: " SUPABASE_URL
SUPABASE_URL="${SUPABASE_URL:-$DEFAULT_URL}"
[ -z "$SUPABASE_URL" ] && { echo "URL do projeto é obrigatória." >&2; exit 1; }

read -rp "Anon/publishable key do projeto [${DEFAULT_ANON_KEY:-obrigatório}]: " SUPABASE_ANON_KEY
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-$DEFAULT_ANON_KEY}"
[ -z "$SUPABASE_ANON_KEY" ] && { echo "Anon key do projeto é obrigatória." >&2; exit 1; }

read -rsp "APPVENDAS_BOOTSTRAP_SECRET (o mesmo valor configurado com set-secrets.sh): " BOOTSTRAP_SECRET
echo
[ -z "$BOOTSTRAP_SECRET" ] && { echo "Bootstrap secret é obrigatório." >&2; exit 1; }

read -rp "Nome completo do administrador: " NOME
read -rp "Login (sem espaços/acentos, ex.: joao.silva): " LOGIN
read -rsp "Senha (mín. 6 caracteres): " SENHA
echo

RESPONSE=$(curl -sS -X POST "${SUPABASE_URL}/functions/v1/manage-usuarios" \
  -H "Content-Type: application/json" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  -d "{\"action\":\"create\",\"bootstrap_secret\":\"${BOOTSTRAP_SECRET}\",\"nome\":\"${NOME}\",\"login\":\"${LOGIN}\",\"senha\":\"${SENHA}\"}")

echo "$RESPONSE"
if echo "$RESPONSE" | grep -q '"error"'; then
  echo "Falhou — confira a mensagem de erro acima (secret errado? já existe um admin?)." >&2
  exit 1
fi
echo
echo "Admin criado. Acesse o app e entre com o login/senha acima."
