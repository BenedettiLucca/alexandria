# Alexandria Setup Guide

## Prerequisites

- A Supabase account and project (https://supabase.com)
- An OpenRouter API key (https://openrouter.ai) with ~$5 in credits
- Deno installed (https://deno.land)

## Step 1: Run the Database Schema

Open your Supabase project's SQL Editor (left sidebar → SQL Editor → New query).

Copy the contents of `schema/schema.sql` and click **Run**.

This creates all 9 tables:

| Table | Purpose |
|-------|---------|
| `memories` | Notes, ideas, decisions, observations |
| `projects` | Codebase context, architecture, conventions |
| `profile` | User preferences, dev stack, environment |
| `health_entries` | Health data (sleep, exercise, vitals, body composition) |
| `training_logs` | Workout sessions with exercises, volume, RPE |
| `health_summaries` | Derived daily health summaries |
| `entities` | Knowledge graph entities (people, concepts, tools) |
| `entity_mentions` | Links entities to memories |
| `sync_log` | Import sync state tracking |

Plus indexes, functions (vector search, dedup, daily summary computation), triggers, and row-level security policies.

## Step 2: Get Your Credentials

From your Supabase dashboard:

| Credential | Where to find it |
|---|---|
| Project URL | Settings → API → Project URL |
| Service role key | Settings → API → `service_role` key |
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

**Optional environment variables:**

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Model for generating embeddings |
| `CLASSIFICATION_MODEL` | `openai/gpt-4o-mini` | Model for memory classification |
| `ALLOWED_ORIGINS` | *(all origins)* | Comma-separated list of allowed CORS origins |
| `GOOGLE_TOKEN_PATH` | `importers/health-connect/token.json` | Path to Google OAuth token file |
| `GOOGLE_CLIENT_SECRETS_PATH` | `importers/health-connect/client_secret.json` | Path to Google OAuth client secrets file |

To generate a random `MCP_ACCESS_KEY`:

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
curl -H "x-brain-key: YOUR_MCP_ACCESS_KEY" \
  "https://YOUR_REF.supabase.co/functions/v1/alexandria?key=YOUR_MCP_ACCESS_KEY"
```

You should get a response (not a 401 error).

## Step 6: Connect AI Clients

See [clients.md](clients.md) for client-specific configuration.

## Optional: Google OAuth (for health-connect/sync.py)

If you want to import data from Google Health Connect via the OAuth2 sync:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select existing)
3. Navigate to **APIs & Services → Credentials**
4. Click **Create Credentials → OAuth 2.0 Client ID**
5. Select "Desktop app" as the application type
6. Copy the **Client ID** and **Client Secret**

Add them to your `.env`:

```
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

The first run of `importers/health-connect/sync.py` will open a browser for OAuth consent. The `token.json` is saved automatically for subsequent runs.

## Derived Health Summaries

After importing health data, you can compute daily summaries using the `health_summary` and `refresh_summary` MCP tools, or call the SQL function directly:

```sql
SELECT compute_daily_summary('2026-04-25');
```

This aggregates sleep, steps, heart rate, weight, exercise, and training data into `health_summaries`.

## Knowledge Graph

Entities are automatically extracted when capturing memories (via LLM classification). You can also manually manage them through the entity MCP tools: `add_entity`, `get_entity`, `list_entities`, `search_entities`, `get_entity_mentions`, `search_mentions`, `top_entities`.

## Updating

After any changes to `server/index.ts`:

```bash
bash scripts/deploy.sh
```

Schema changes need to be run manually in the SQL Editor.
