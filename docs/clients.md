# Connecting AI Clients to Alexandria

Your MCP server URL (after deployment):

```
https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria
```

Authentication via header: `x-brain-key: YOUR_MCP_ACCESS_KEY`
Or via query param: `?key=YOUR_MCP_ACCESS_KEY`

---

## Hermes Agent

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  alexandria:
    url: "https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria"
    headers:
      x-brain-key: "YOUR_MCP_ACCESS_KEY"
```

Then restart Hermes. Tools appear as `mcp_alexandria_*`.

## Claude Desktop

**Option A:** Settings → Connectors → Add custom connector:
- URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria`

**Option B:** Edit config file directly.

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "alexandria": {
      "url": "https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria",
      "headers": {
        "x-brain-key": "YOUR_MCP_ACCESS_KEY"
      }
    }
  }
}
```

## Cursor

Settings → MCP → Add new server:
- **Type:** Streamable HTTP
- **URL:** `https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria`
- **Header:** `x-brain-key: YOUR_MCP_ACCESS_KEY`

## ChatGPT / OpenAI

Alexandria now exposes MCP OAuth discovery endpoints and auth challenges compatible with ChatGPT custom MCP apps.

### Recommended setup

1. In ChatGPT, add a custom MCP app.
2. MCP URL:
   - `https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria`
3. Auth mode:
   - `OAuth`
4. Keep `x-brain-key` for Hermes/automation clients (backward compatible).

### OAuth behavior

- Unauthorized MCP requests return `401` with:
  - `WWW-Authenticate: Bearer ... resource_metadata=...`
  - `_meta["mcp/www_authenticate"]` in body
- Discovery endpoints available under the MCP path:
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/openid-configuration`

## Any MCP Client

The server uses standard Streamable HTTP transport. Connection params:

| Parameter | Value |
|-----------|-------|
| Transport | Streamable HTTP |
| URL | `https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria` |
| Auth header | `x-brain-key: YOUR_MCP_ACCESS_KEY` |
| Auth query param | `?key=YOUR_MCP_ACCESS_KEY` |
