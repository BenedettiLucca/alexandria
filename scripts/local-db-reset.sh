#!/usr/bin/env bash
# ==============================================================================
# Alexandria — Reset reproduzível do banco local e aplicação de migrations (fresh chain)
# ==============================================================================
set -euo pipefail

# Garante execução a partir da raiz do repositório
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Alexandria: Inicializando verificação de pré-requisitos locais ==="

# 1. Checa Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "ERRO: O binário 'docker' não foi encontrado no PATH." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERRO: O daemon do Docker não está acessível ou não está em execução." >&2
  exit 1
fi

# 2. Checa Supabase CLI
if ! command -v supabase >/dev/null 2>&1; then
  echo "ERRO: A CLI 'supabase' não foi encontrada no PATH." >&2
  exit 1
fi

echo "=== Alexandria: Verificando status da stack local Supabase ==="

# Se a stack do Supabase não estiver ativa, executa supabase start
if ! supabase status >/dev/null 2>&1; then
  echo "Stack local desligada. Executando 'supabase start'..."
  supabase start
else
  echo "Stack local Supabase já está ativa."
fi

echo "=== Alexandria: Executando reset limpo do banco e aplicando todas as migrations ==="
supabase db reset

echo "=== Alexandria: Aguardando PostgREST responder em http://127.0.0.1:54321/rest/v1/ ==="
MAX_RETRIES=30
RETRY_INTERVAL=1
READY=0

for ((i=1; i<=MAX_RETRIES; i++)); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:54321/rest/v1/" || true)
  if [ "$HTTP_CODE" = "200" ]; then
    READY=1
    break
  fi
  sleep "$RETRY_INTERVAL"
done

if [ "$READY" -ne 1 ]; then
  echo "ERRO: PostgREST não respondeu com código 200 após $((MAX_RETRIES * RETRY_INTERVAL)) segundos." >&2
  exit 1
fi

echo "=== Alexandria: Banco local redefinido e migrations aplicadas com sucesso (HTTP $HTTP_CODE) ==="
