# Alexandria — Personal Context MCP Server

[![Tests](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml/badge.svg)](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml)

A unified personal context store accessible by any AI via the MCP protocol. Single-user, self-hosted on Supabase. One database, one server — every AI you use reads and writes to the same brain.

Named after the Library of Alexandria — a single repository holding all knowledge, accessible to any scholar (or AI) who needs it.

## Features

- **38 MCP tools** for memories, briefs, room manifests, recipes, brief quality, health, training, and knowledge graph
- **Semantic search** with pgvector (HNSW indexes)
- **Auto-classification and embedding** via OpenRouter (GPT-4o-mini + text-embedding-3-small)
- **Knowledge graph** with entity extraction from memories
- **Health data importers** (Google Health Connect, Iron Log)
- **OAuth2 sync** for Google Health API
- **Derived health summaries** (daily aggregations via SQL RPC)
- **Row-level security** locked to `service_role`
- **201 tests** (96 Python + 105 Deno)

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

## MCP Tools

### Memories
- `search_memories` — semantic search across all memories
- `capture_memory` — save a new memory (auto-embeds + classifies)
- `list_memories` — list/filter recent memories
- `memory_stats` — summary statistics

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

### Projects
- `list_projects` — list tracked projects
- `get_project` — get project details
- `save_project` — create/update project context

### Health
- `log_health` — record a health entry
- `query_health` — search/filter health data
- `health_summary` — view daily aggregated summaries (includes coverage warnings)
- `search_health` — semantic search over health entries
- `source_coverage_report` — diagnostic report on source/lane data ingestion coverage


### Training
- `log_workout` — record a training session
- `query_workouts` — search/filter workout history
- `search_training` — semantic search over training logs

### Knowledge Graph
- `add_entity` — create a knowledge graph entity (auto-extracts on memory capture)
- `get_entity` — get entity details and related memories
- `list_entities` — browse all entities
- `search_entities` — search entities by name
- `get_entity_mentions` — get mentions for an entity
- `search_mentions` — search entity mentions
- `top_entities` — most-connected entities

### Sync
- `sync_status` — view import sync history

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
deno test supabase/functions/alexandria/ --allow-all    # Deno tests only (105)
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
│   │   └── 20260702030000_add_brief_claims.sql
│   └── functions/
│       └── alexandria/
│           ├── index.ts       # MCP server (38 tools)
│           ├── lib.ts         # Pure functions
│           ├── lib.test.ts    # Deno tests (47)
│           ├── deno.json      # Deno config + imports
│           ├── deno.lock
│           └── tools/
│               ├── briefs.ts          # capture, list, search, build_room_manifest
│               ├── memories.ts        # search, capture, list, stats, update, delete
│               ├── health.ts          # log, query, summary, search, coverage, bodycomp
│               ├── workouts.ts        # log, query, search training
│               ├── projects.ts        # list, get, save
│               ├── profile.ts         # get, set
│               ├── entities.ts        # add, get, list, search, mentions, top
│               ├── recipes.ts         # save, list, get, build_from_recipe
│               ├── proof_chain.ts     # score_brief_provenance
│               ├── conflict_radar.ts  # extract_claims, scan_conflicts
│               └── *.test.ts          # 58 tool-level Deno tests
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

## License

MIT

