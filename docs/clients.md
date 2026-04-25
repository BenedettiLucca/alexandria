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

Not directly supported yet. Use the importers to pull data, or capture memories via Hermes/Claude and query them from ChatGPT through a custom GPT with API access.

## Any MCP Client

The server uses standard Streamable HTTP transport. Connection params:

| Parameter | Value |
|-----------|-------|
| Transport | Streamable HTTP |
| URL | `https://YOUR_PROJECT_REF.supabase.co/functions/v1/alexandria` |
| Auth header | `x-brain-key: YOUR_MCP_ACCESS_KEY` |
| Auth query param | `?key=YOUR_MCP_ACCESS_KEY` |
