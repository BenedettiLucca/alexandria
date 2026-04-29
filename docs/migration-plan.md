# Alexandria Migration Plan — Supabase API Updates (Apr 2026)

## Issues Found

### 1. CRITICAL: Wrong directory structure for Supabase Edge Functions
**Problem:** Code lives in `server/`, but `supabase functions deploy alexandria` expects `supabase/functions/alexandria/index.ts`. Without this, the CLI throws "entrypoint path does not exist".

**Fix:** Move `server/*` → `supabase/functions/alexandria/*` and create `supabase/config.toml` if missing.

### 2. Dependency drift & SDK breakage
**Problem:**
- `@hono/mcp@0.1.1` incompatible with `@modelcontextprotocol/sdk > 1.25.0` (missing `isJSONRPCError` export)
- `@supabase/supabase-js@2.47.10` is ~5 months old

**Fix:** Bump to:
- `@hono/mcp@0.2.5`
- `@modelcontextprotocol/sdk@1.26.0`
- `@supabase/supabase-js@2.104.0`

### 3. Local dev env var restrictions
**Problem:** Supabase CLI blocks env vars prefixed with `SUPABASE_` during `supabase functions serve` because the local runtime injects its own.

**Fix:** Add fallback aliases in `index.ts`:
```ts
const SUPABASE_URL = Deno.env.get("LOCAL_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
```

### 4. Accept header strictness (older @hono/mcp)
**Problem:** `@hono/mcp@0.1.1` strictly requires both `application/json` and `text/event-stream` in Accept header. Some MCP clients (Claude Code, Gemini CLI) omit one and get 406.

**Fix:** Already partially patched in current code, but upgrading to `0.2.5` resolves this properly at the library level. We'll also keep the existing header-spoofing fallback for safety.

### 5. Deploy script outdated
**Problem:** `deploy.sh` assumes `server/` layout and uses old patterns. It also doesn't handle Deno 2 auto-discovery of `deno.json`.

**Fix:** Update paths, add `--use-api` flag option for Docker-less deploys, and remove obsolete import-map logic.

### 6. Missing `supabase/config.toml`
**Problem:** New Supabase CLI projects expect `config.toml`. Without it, `supabase link` may behave unexpectedly.

**Fix:** Run `supabase init` if `.supabase/config.toml` doesn't exist, or ensure the deploy script handles linking properly.

## What does NOT need changing
- Database schema (auth.role(), RLS policies, RPC functions)
- PostgREST query patterns (.insert().select().single(), .rpc(), etc.)
- Vector search functions
- Importer Python code

## Execution Order
1. Document plan (this file)
2. Restructure directories
3. Update deno.json
4. Patch index.ts
5. Update deploy.sh
6. Verify & test
