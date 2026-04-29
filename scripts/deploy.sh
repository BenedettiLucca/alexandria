#!/bin/bash
# ============================================================
# Alexandria — Deploy to Supabase Edge Function
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Library of Alexandria -- Deploy"
echo "==============================="
echo ""

# Check for Supabase CLI
# Using npx supabase (CLI installed locally)
# Check for .env
if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "ERROR: .env file not found."
    echo "Copy .env.example to .env and fill in your credentials:"
    echo "  cp .env.example .env"
    echo "  \$EDITOR .env"
    exit 1
fi

source "$PROJECT_ROOT/.env"

# NOTE: For local development with `supabase functions serve`, the CLI blocks env vars
# prefixed with SUPABASE_. Use LOCAL_SUPABASE_URL and LOCAL_SUPABASE_SERVICE_ROLE_KEY
# in your local .env if needed. The deployed function uses SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY as normal.

# Validate required vars
for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY OPENROUTER_API_KEY MCP_ACCESS_KEY; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var is not set in .env"
        exit 1
    fi
done

# Extract project ref from SUPABASE_URL
PROJECT_REF=$(echo "$SUPABASE_URL" | sed 's|https://||' | sed 's|\.supabase\.co.*||')
echo "Project ref: $PROJECT_REF"

# Link project if not already linked
cd "$PROJECT_ROOT"
if [ ! -d ".supabase" ]; then
    echo "Linking to Supabase project..."
    npx supabase link --project-ref "$PROJECT_REF"
fi

# Deploy the Edge Function
echo "Deploying alexandria Edge Function..."
npx supabase functions deploy alexandria \
    --project-ref "$PROJECT_REF" \
    --use-api

# Set secrets (persistent across deploys)
echo "Setting secrets..."
npx supabase secrets set \
    SUPABASE_URL="$SUPABASE_URL" \
    SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
    OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
    MCP_ACCESS_KEY="$MCP_ACCESS_KEY" \
    --project-ref "$PROJECT_REF"

FUNCTION_URL="https://${PROJECT_REF}.supabase.co/functions/v1/alexandria"
echo ""
echo "========================================="
echo "Deployed!"
echo "========================================="
echo ""
echo "MCP Server URL:"
echo "  ${FUNCTION_URL}"
echo ""
echo "Auth header:"
echo "  x-brain-key: ${MCP_ACCESS_KEY}"
echo ""
echo "Query param fallback:"
echo "  ${FUNCTION_URL}?key=${MCP_ACCESS_KEY}"
echo ""
echo "Test it:"
echo "  curl -H 'x-brain-key: ${MCP_ACCESS_KEY}' ${FUNCTION_URL}?key=${MCP_ACCESS_KEY}"
