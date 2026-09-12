# Alexandria Setup Guide

## Prerequisites

- A Supabase account and project (https://supabase.com)
- An OpenRouter API key (https://openrouter.ai) with ~$5 in credits
- Deno installed (https://deno.land)

## Step 1: Run the Database Schema

Open your Supabase project's SQL Editor (left sidebar → SQL Editor → New query).

Copy the contents of `supabase/migrations/20260429160331_alexandria_schema.sql` and click **Run**.

This creates 12 tables:

| Table | Purpose |
|-------|---------|
| `memories` | Notes, ideas, decisions, observations |
| `briefs` | Structured markdown artifacts from cron/jobs with dedupe + semantic recall |
| `projects` | Codebase context, architecture, conventions |
| `profile` | User preferences, dev stack, environment |
| `health_entries` | Health data (sleep, exercise, vitals, body composition) |
| `training_logs` | Workout sessions with exercises, volume, RPE |
| `health_summaries` | Derived daily health summaries |
| `entities` | Knowledge graph entities (people, concepts, tools) |
| `entity_mentions` | Links entities to memories |
| `sync_log` | Import sync state tracking |
| `room_recipes` | Saved room recipes with authority weights and exclusion rules |
| `brief_claims` | Structured claims extracted from briefs for conflict detection |
| `coverage_snapshots` | Point-in-time source coverage captures for transition tracking |
| `tool_call_log` | Append-only log of every MCP tool invocation |
| `tool_catalog` | Registered MCP tool names (enables never-called classification) |

Plus indexes, functions (vector search, dedup, daily summary computation, source coverage, coverage transitions, tool activation reporting), triggers, and row-level security policies.

Run the incremental migrations in `supabase/migrations/` to add room recipes, source coverage, conflict radar, coverage transitions, and tool telemetry features. The easiest path is to apply them all with the Supabase CLI:

```bash
npx supabase db push
```

or use `npx supabase db reset` against a local dev database to validate the full migration chain from scratch.

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
ALEXANDRIA_OWNER_USER_ID=<uuid from Authentication -> Users>
COVERAGE_CAPTURE_SECRET=<generate another random string>
```

`ALEXANDRIA_OWNER_USER_ID` is **required**: every request (JWT or API key) resolves to this
owner, and the function refuses to start without it. `COVERAGE_CAPTURE_SECRET` is required by
the coverage-capture cron (sent as the `x-coverage-capture-secret` header).

**Optional environment variables:**

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` (@ 2048 dims) | Embedding model (dimension is derived from `EMBEDDING_DIMENSION`, default 2048) |
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
5. Deploys the scheduled `coverage-capture` Edge Function

After deploy, schedule `coverage-capture` to run nightly (it snapshots coverage lanes into `coverage_snapshots` so `coverage_transition_report` can detect NEW/ONGOING/RECOVERED transitions). In the Supabase dashboard: **Database → Edge Functions → coverage-capture → Cron/Schedule**, or use `pg_cron`:

```sql
-- nightly 02:00 capture (auth: secret + owner headers are REQUIRED - handler is default-deny)
SELECT cron.schedule(
  'coverage-capture', '0 2 * * *',
  $$
  select net.http_post(
    url:='https://<ref>.supabase.co/functions/v1/coverage-capture',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'x-coverage-capture-secret','<COVERAGE_CAPTURE_SECRET>',
      'x-coverage-execution-id', gen_random_uuid()::text,
      'x-coverage-cadence','daily'
    ),
    body:='{}'::jsonb
  );
  $$
);
```

90-day telemetry pruning is available via `prune_tool_call_log(90)` (schedule alongside the
above); only `service_role` may execute it.

Tool telemetry is always-on; 90-day pruning is available via the `prune_tool_call_log(90)` SQL function (invoke it from a scheduled job or cron alongside the above).

## Step 5: Verify

```bash
curl -H "x-brain-key: YOUR_MCP_ACCESS_KEY" \
  "https://YOUR_REF.supabase.co/functions/v1/alexandria"
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
SELECT alexandria_priv.compute_daily_summary('2026-04-25');
```

The function lives in the `alexandria_priv` schema (not exposed via the API) and enforces the
owner invariant: authenticated callers can only compute their own summaries.

This aggregates sleep, steps, heart rate, weight, exercise, and training data into `health_summaries`.

## Knowledge Graph

Entities are automatically extracted when capturing memories (via LLM classification). You can also manually manage them through the entity MCP tools: `get_entity`, `list_entities`, `search_entities`, `get_entity_mentions`, `search_mentions`, `top_entities` (see the MCP tools list from the server for the authoritative set).

## Updating

After any changes to `supabase/functions/alexandria/index.ts`:

```bash
bash scripts/deploy.sh
```

For database changes:
1. Update `supabase/migrations/20260429160331_alexandria_schema.sql` when the bootstrap schema itself changes.
2. If an existing Supabase project needs the delta, create/apply an incremental migration as well.

Schema changes for an already-running Supabase project still need to be applied to that remote database manually or via your migration workflow.
