# Alexandria

Personal context store for multi-AI shared memory. One database, one MCP server, every AI you use reads and writes to the same brain.

Named after the Library of Alexandria -- a single repository holding all knowledge, accessible to any scholar (or AI) who needs it.

## What It Stores

| Domain | Table | Contents |
|--------|-------|----------|
| Memories | `memories` | Notes, ideas, decisions, observations, references |
| Projects | `projects` | Codebase context, architecture decisions, conventions |
| Profile | `profile` | Who you are, preferences, dev stack, environment |
| Health | `health_entries` | Samsung Health sync (sleep, exercise, vitals) |
| Training | `training_logs` | Iron-Log workout data |

## Architecture

```
AI Client (Claude / ChatGPT / Cursor / Hermes / ...)
    |
    v  MCP over Streamable HTTP
Supabase Edge Function (Deno + Hono + MCP SDK)
    |
    +-> Supabase PostgreSQL + pgvector
    +-> OpenRouter API (embeddings + classification)
```

## Setup

See [docs/setup.md](docs/setup.md) for the full walkthrough.

## MCP Tools

The server exposes these tools to any connected AI client:

**Memories:**
- `search_memories` -- semantic search across all memories
- `capture_memory` -- save a new memory (auto-embeds + classifies)
- `list_memories` -- list/filter recent memories
- `memory_stats` -- summary statistics

**Profile:**
- `get_profile` -- retrieve profile sections
- `set_profile` -- create/update profile data

**Projects:**
- `list_projects` -- list tracked projects
- `get_project` -- get project details
- `save_project` -- create/update project context

**Health:**
- `log_health` -- record a health entry
- `query_health` -- search/filter health data

**Training:**
- `log_workout` -- record a training session
- `query_workouts` -- search/filter workout history

## Connecting AI Clients

Once deployed, any MCP-compatible client connects via:

```
URL: https://<your-project>.supabase.co/functions/v1/alexandria?key=<your-mcp-key>
```

See [docs/clients.md](docs/clients.md) for client-specific setup.

## License

MIT
