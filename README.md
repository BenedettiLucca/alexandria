# Alexandria — Personal Context MCP Server

[![Tests](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml/badge.svg)](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml)

A unified personal context store accessible by any AI via the MCP protocol. Single-user, self-hosted on Supabase. One database, one server — every AI you use reads and writes to the same brain.

Named after the Library of Alexandria — a single repository holding all knowledge, accessible to any scholar (or AI) who needs it.

## Features

- **40 MCP tools** for memories, briefs, room manifests, recipes, brief quality, health, training, and knowledge graph
- **Semantic search** with pgvector (HNSW indexes)
- **Auto-classification and embedding** via OpenRouter (GPT-4o-mini + text-embedding-3-small)
- **Knowledge graph** with entity extraction from memories
- **Health data importers** (Google Health Connect, Iron Log)
- **OAuth2 sync** for Google Health API
- **Derived health summaries** (daily aggregations via SQL RPC)
- **Source coverage tracking** (distinguishes missing data from true zeros) with transition snapshots and recovery reporting
- **Tool activation telemetry** (which MCP tools are actually called, by which client, with trends over 7/30/90-day windows)
- **Row-level security** locked to `service_role`
- **213 tests** (96 Python + 117 Deno)

## Architecture

```
AI Clients (Claude, ChatGPT, Cursor, Hermes, ...)
    │
    ▼  MCP over Streamable HTTP
Supabase Edge Function (Deno + Hono + MCP SDK)
    │
    ├──▶ Supabase PostgreSQL + pgvector
    └──▶ OpenRouter API (embeddings + classification)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Server | Supabase Edge Function (Deno) |
| Framework | Hono + @hono/mcp |
| Transport | Streamable HTTP |
| Database | Supabase PostgreSQL + pgvector |
| AI | OpenRouter (text-embedding-3-small, gpt-4o-mini) |
| Importers | Python 3.11+ |

## Database Schema

The canonical bootstrap schema for fresh installs lives in `supabase/migrations/20260429160331_alexandria_schema.sql`.

12 tables across the bootstrap + incremental migrations:

| Table | Description |
|-------|-------------|
| `memories` | Notes, ideas, decisions, observations |
| `briefs` | Structured markdown artifacts from cron/jobs with dedupe + semantic recall |
| `projects` | Codebase context, architecture, conventions |
| `profile` | User preferences, dev stack, environment |
| `health_entries` | Health data (sleep, exercise, vitals, body composition) |
| `training_logs` | Workout sessions with exercises, volume, RPE |
| `health_summaries` | Derived daily/weekly health summaries |
| `entities` | Knowledge graph entities (people, concepts, tools) |
| `entity_mentions` | Links entities to memories |
| `sync_log` | Import sync state tracking |
| `room_recipes` | Saved room recipes with authority weights and exclusion rules |
| `brief_claims` | Structured claims extracted from briefs for conflict detection |
| `coverage_snapshots` | Point-in-time source coverage captures for transition tracking |
| `tool_call_log` | Append-only log of every MCP tool invocation |
| `tool_catalog` | Registered MCP tool names (enables never-called classification) |

## MCP Tools

### Memories
- `search_memories` — semantic search across all memories
- `capture_memory` — save a new memory (auto-embeds + classifies)
- `list_memories` — list/filter recent memories
- `memory_stats` — summary statistics
- `update_memory` — edit a memory (re-embeds + re-classifies when content changes)
- `delete_memory` — remove a memory

### Briefs
- `capture_brief` — store a structured brief/report artifact
- `list_briefs` — list/filter recent briefs
- `search_briefs` — semantic search across stored briefs
- `extract_brief_claims` — extract structured claims from brief markdown
- `scan_brief_conflicts` — scan recent briefs for contradictory numeric claims

### Room Manifests
- `build_room_manifest` — generate a structured manifest for a draft room based on topic queries and filters

### Room Recipes
- `save_room_recipe` — save/upsert a room recipe by name
- `list_room_recipes` — list all room recipes
- `get_room_recipe` — get recipe details by name
- `build_room_manifest_from_recipe` — build a room manifest based on a recipe

### Proof Chain
- `score_brief_provenance` — evaluate provenance quality of a brief (heuristic 0-100 score)

### Profile
- `get_profile` — retrieve profile sections
- `set_profile` — create/update profile data
- `whoami` — return the current authenticated identity

### Projects
- `list_projects` — list tracked projects
- `save_project` — create/update project context

### Health
- `log_health` — record a health entry
- `query_health` — search/filter health data
- `search_health` — semantic search over health entries
- `health_summary` — view daily aggregated summaries (includes coverage warnings)
- `refresh_summary` — recompute daily summary aggregations
- `delete_health_entry` — remove a health entry
- `bodycomp_summary` — body composition trends vs measurement goals
- `source_coverage_report` — diagnostic report on source/lane data ingestion coverage
- `coverage_transition_report` — NEW/ONGOING/RECOVERED state transitions across coverage lanes

### Training
- `log_workout` — record a training session
- `query_workouts` — search/filter workout history
- `search_workouts` — semantic search over training logs
- `update_workout` — edit a workout

### Knowledge Graph
- `search_entities` — search entities by name
- `get_entity` — get entity details and related memories
- `list_entities` — browse all entities

### Sync
- `sync_status` — view import sync history

### Telemetry
- `get_tool_activation_report` — which MCP tools are being called, by which client, and trends over 7/30/90-day windows

## Quick Start

1. **Clone the repo**
   ```bash
   git clone https://github.com/your-username/alexandria.git
   cd alexandria
   ```

2. **Create a Supabase project** at [supabase.com](https://supabase.com)

3. **Run the bootstrap schema** — open SQL Editor and run `supabase/migrations/20260429160331_alexandria_schema.sql`

4. **Get an OpenRouter API key** at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)

5. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

6. **Deploy**
   ```bash
   bash scripts/deploy.sh
   ```

7. **Connect your AI client** — see [docs/clients.md](docs/clients.md)

## Testing

```bash
./run-tests.sh                                          # Full suite
deno test supabase/functions/alexandria/ --allow-all    # Deno tests only (117)
python -m pytest importers/ -v                          # Python tests only (96)
python -m pytest importers/ -v --cov=importers          # With coverage report
```

CI runs automatically on every push to `master` and on pull requests. See the [Actions tab](https://github.com/BenedettiLucca/alexandria/actions) for results.

## Project Structure

```
alexandria/
├── supabase/
│   ├── migrations/
│   │   ├── 20260429160331_alexandria_schema.sql  # Bootstrap schema (12 tables)
│   │   ├── 20260702010000_add_compute_source_coverage.sql
│   │   ├── 20260702020000_add_room_recipes.sql
│   │   ├── 20260702030000_add_brief_claims.sql
│   │   ├── 20260814010000_add_coverage_transitions.sql
│   │   └── 20260815010000_add_tool_telemetry.sql
│   └── functions/
│       ├── alexandria/
│       │   ├── index.ts       # MCP server (40 tools)
│       │   ├── lib.ts         # Pure functions
│       │   ├── lib.test.ts    # Deno tests (47)
│       │   ├── context.ts     # Request-scoped auth context (AsyncLocalStorage)
│       │   ├── telemetry.ts   # Tool-call logging (hash, latency, client)
│       │   ├── deno.json      # Deno config + imports
│       │   ├── deno.lock
│       │   └── tools/
│       │       ├── briefs.ts          # capture, list, search, build_room_manifest
│       │       ├── memories.ts        # search, capture, list, stats, update, delete
│       │       ├── health.ts          # log, query, summary, search, coverage, transitions
│       │       ├── workouts.ts        # log, query, search training
│       │       ├── projects.ts        # list, save
│       │       ├── profile.ts         # get, set, whoami
│       │       ├── entities.ts        # search, get, list, sync_status
│       │       ├── recipes.ts         # save, list, get, build_from_recipe
│       │       ├── proof_chain.ts     # score_brief_provenance
│       │       ├── conflict_radar.ts  # extract_claims, scan_conflicts
│       │       ├── telemetry.ts       # get_tool_activation_report
│       │       └── *.test.ts          # tool-level Deno tests
│       └── coverage-capture/  # Scheduled Edge Function (nightly snapshots)
├── importers/
│   ├── shared.py              # Shared utilities
│   ├── health-connect/        # Google Health Connect importer
│   ├── iron-log/              # Iron Log workout importer
│   └── test_*.py              # Python tests (96)
├── docs/
│   ├── setup.md               # Detailed setup guide
│   └── clients.md             # AI client connection guide
├── scripts/deploy.sh          # One-command deploy
└── .env.example               # Environment template
```

## Source Coverage Healthcheck

Alexandria tracks data ingestion coverage to distinguish missing/non-ingested data from true zeros (e.g. knowing whether you walked 0 steps vs. the steps data was not synchronized).

### Coverage Statuses
- `current`: Data is up to date and within the expected cadence.
- `late`: Data has been imported before, but the gap since the last entry exceeds the expected cadence.
- `summary_stale`: Health summaries exist, but the lane lacks current entries.
- `missing`: Workouts are recent, but daily lanes (sleep, steps) are absent and no completed sync evidence exists.
- `never_seen`: No entries exist and there is no sync or summary evidence.

### Diagnostic Tools and Warnings
- Use the `source_coverage_report` tool to get a full report of ingestion status and gaps across all lanes (`workouts`, `sleep`, `steps`, `heart_rate`, `weight`), grouped by status severity.
- The `health_summary` tool automatically appends a `Coverage warnings:` block when any lanes are missing or stale, ensuring operators are immediately aware of ingestion health issues.

### Transition Snapshots and Recovery Reporting

A nightly scheduled Edge Function (`coverage-capture`) snapshots each lane's coverage state into `coverage_snapshots`. The `coverage_transition_report` tool then derives state transitions between consecutive snapshots:

- **NEW** — a lane degraded for the first time since the last healthy snapshot
- **ONGOING** — a lane that remains degraded across consecutive snapshots
- **RECOVERED** — a lane that returned to `current` after being degraded
- **STEADY** — a lane unchanged since the last snapshot
- **TRUST-BLOCKING** — a lane degraded across 2+ snapshots, which downstream consumers should treat as untrustworthy

The report also tracks `first_degraded_at`, degradation streak length, and (for brief/artifact lanes) `artifact_freshness_status` (`fresh`/`stale`/`missing`).

**Brief/artifact lanes** are populated by external producers (e.g. cron jobs) via the `publish_lane_heartbeat` SQL function, recording `last_success_at` / `last_failure_at` / `last_expected_run_at` so stale artifacts that look healthy are surfaced.

### Brief Lane Heartbeat

External producers can report their run outcome to the coverage ledger:

```sql
SELECT publish_lane_heartbeat(
  'night-research-pack',   -- source_name
  'night_research_pack',   -- lane
  TRUE,                    -- success
  24,                      -- expected_cadence_hours
  ARRAY['ok']              -- notes
);
```

## Tool Activation Telemetry

Every MCP tool invocation is recorded (append-only) in `tool_call_log`:

- `tool_name`, `caller_client`, `timestamp`, `params_hash` (SHA-256 of the canonical JSON params — not reversible), `success`, `latency_ms`, `owner_id`
- **Always-on** logging with a **90-day retention** window (pruned by `prune_tool_call_log`)
- Client identity is resolved in this order: `x-alexandria-client` header → `user-agent` header → `unknown`. Set `x-alexandria-client` on your MCP client to label its calls.

Use the `get_tool_activation_report` MCP tool to see, over a configurable window (default 90 days):

- **Never-called** tools (from the seeded `tool_catalog`) and **dormant** tools
- Call volume across 7/30/90-day windows
- Per-tool trends (`rising` / `falling` / `stable`)
- Client diversity (which clients call which tools)
- Success rate and average latency

The report tool is itself pre-seeded in `tool_catalog`, so it appears from day one.

## License

MIT

