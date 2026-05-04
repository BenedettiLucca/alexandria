# Alexandria — Personal Context MCP Server

[![Tests](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml/badge.svg)](https://github.com/BenedettiLucca/alexandria/actions/workflows/test.yml)

A unified personal context store accessible by any AI via the MCP protocol. Single-user, self-hosted on Supabase. One database, one server — every AI you use reads and writes to the same brain.

Named after the Library of Alexandria — a single repository holding all knowledge, accessible to any scholar (or AI) who needs it.

## Features

- **25 MCP tools** for memories, projects, health, training, and knowledge graph
- **Semantic search** with pgvector (HNSW indexes)
- **Auto-classification and embedding** via OpenRouter (GPT-4o-mini + text-embedding-3-small)
- **Knowledge graph** with entity extraction from memories
- **Health data importers** (Google Health Connect, Iron Log)
- **OAuth2 sync** for Google Health API
- **Derived health summaries** (daily aggregations via SQL RPC)
- **Row-level security** locked to `service_role`
- **121 tests** (73 Python + 48 Deno)

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

9 tables in a single consolidated [`schema/schema.sql`](schema/schema.sql):

| Table | Description |
|-------|-------------|
| `memories` | Notes, ideas, decisions, observations |
| `projects` | Codebase context, architecture, conventions |
| `profile` | User preferences, dev stack, environment |
| `health_entries` | Health data (sleep, exercise, vitals, body composition) |
| `training_logs` | Workout sessions with exercises, volume, RPE |
| `health_summaries` | Derived daily/weekly health summaries |
| `entities` | Knowledge graph entities (people, concepts, tools) |
| `entity_mentions` | Links entities to memories |
| `sync_log` | Import sync state tracking |

## MCP Tools

### Memories
- `search_memories` — semantic search across all memories
- `capture_memory` — save a new memory (auto-embeds + classifies)
- `list_memories` — list/filter recent memories
- `memory_stats` — summary statistics

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
- `health_summary` — view daily aggregated summaries
- `search_health` — semantic search over health entries

### Training
- `log_workout` — record a training session
- `query_workouts` — search/filter workout history
- `search_training` — semantic search over training logs

### Knowledge Graph
- `add_entity` — create a knowledge graph entity
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

3. **Run the schema** — open SQL Editor and run the contents of `schema/schema.sql`

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
./run-tests.sh                                          # Full suite (121 tests)
deno test supabase/functions/alexandria/ --allow-all    # Deno tests only (48)
python -m pytest importers/ -v                          # Python tests only (73)
python -m pytest importers/ -v --cov=importers          # With coverage report
```

CI runs automatically on every push to `master` and on pull requests. See the [Actions tab](https://github.com/BenedettiLucca/alexandria/actions) for results.

## Project Structure

```
alexandria/
├── schema/schema.sql          # Consolidated DB schema
├── supabase/
│   └── functions/
│       └── alexandria/
│           ├── index.ts       # MCP server (25 tools)
│           ├── lib.ts         # Pure functions
│           ├── lib.test.ts    # Deno tests (48)
│           ├── deno.json      # Deno config + imports
│           └── deno.lock
├── importers/
│   ├── shared.py              # Shared utilities
│   ├── health-connect/        # Google Health Connect importer
│   ├── iron-log/              # Iron Log workout importer
│   └── test_*.py              # Python tests (73)
├── docs/
│   ├── setup.md               # Detailed setup guide
│   ├── clients.md             # AI client connection guide
│   └── plan.md                # Architecture & improvement plan
├── scripts/deploy.sh          # One-command deploy
└── .env.example               # Environment template
```

## License

MIT
