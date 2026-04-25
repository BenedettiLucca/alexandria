# Alexandria Setup Guide

## Prerequisites

- A Supabase account and project (https://supabase.com)
- An OpenRouter API key (https://openrouter.ai) with ~$5 in credits
- Deno installed (https://deno.land)

## Step 1: Run the Database Schema

Open your Supabase project's SQL Editor (left sidebar -> SQL Editor -> New query).

Run the SQL files in order:

1. Copy the contents of `schema/001_core.sql` and click **Run**
2. Copy the contents of `schema/002_security.sql` and click **Run**

This creates:
- 5 tables: `memories`, `projects`, `profile`, `health_entries`, `training_logs`
- Vector similarity search function
- Deduplication via content fingerprints
- Row-level security locked to service_role

## Step 2: Get Your Credentials

From your Supabase dashboard you need:

| Credential | Where to find it |
|---|---|
| Project URL | Settings > API > Project URL |
| Service role key | Settings > API > service_role key |
| Project ref | The random string in your dashboard URL |

From OpenRouter:

| Credential | Where to find it |
|---|---|
| API key | https://openrouter.ai/settings/keys |

## Step 3: Configure

```bash
cd ~/Projects/alexandria
cp .env.example .env
```

Edit `.env` and fill in:

```
SUPABASE_URL=https://your-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
OPENROUTER_API_KEY=sk-or-...
MCP_ACCESS_KEY=<generate a random string>
```

To generate a random MCP_ACCESS_KEY:

```bash
openssl rand -hex 32
```

## Step 4: Deploy

```bash
bash scripts/deploy.sh
```

This:
1. Installs Supabase CLI if needed
2. Links to your project
3. Deploys the Edge Function
4. Sets all secrets

## Step 5: Verify

```bash
# Replace with your actual values
curl -H "x-brain-key: YOUR_KEY" \
  "https://YOUR_REF.supabase.co/functions/v1/alexandria?key=YOUR_KEY"
```

You should get a response (not a 401 error).

## Step 6: Connect AI Clients

See [clients.md](clients.md) for client-specific configuration.

## Updating

After any changes to `server/index.ts`:

```bash
bash scripts/deploy.sh
```

Schema changes need to be run manually in the SQL Editor.
