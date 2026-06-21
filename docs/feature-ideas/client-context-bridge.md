---
date: 2026-06-10
source: Synapse Diff cron
project: /home/lucca/Projects/alexandria
feature: Client Context Bridge — Import MOIC-MCP Kommo Data as Brief Artifacts
---

# Client Context Bridge

## Summary / Pitch

Import MOIC-MCP Kommo CRM data (contacts, deals, notes) into Alexandria as `brief` artifacts, creating a unified personal + work context store that any agent can query via MCP.

## Why Now

- Alexandria just gained `briefs/artifacts` table with MCP tools, search, and dedupe (#12)
- MOIC-MCP just split Kommo connectors into focused modules with decision-grade evidence blocks (#8, #9)
- Both projects are active and the data flow is natural: Kommo → normalized briefs → agent context
- The pattern mirrors the existing Google Health Connect importer in Alexandria (health data → agent-readable context), but for work data

## Suggested Implementation

1. Add `import_kommo_briefs` tool to Alexandria MCP server
2. Call MOIC-MCP Kommo connector (HTTP API or direct Supabase query if same instance)
3. Normalize contacts/deals/notes into brief artifacts with `type: 'client_intel'`
4. Schema: `{ source: 'kommo', entity_type: 'contact'|'deal'|'note', entity_id, summary, evidence_blocks[] }`
5. Dedupe against existing briefs using the existing dedup logic
6. ~200-300 lines in Alexandria, zero changes needed in MOIC-MCP

## Effort

M (2-3 days)

## Open Questions / Risks

- Is MOIC-MCP accessible via HTTP API or only direct DB? Need to check deployment model.
- Kommo data may contain client-confidential info — need to assess what gets imported vs what stays in MOIC-MCP only.
- Rate limiting on Kommo API calls — same concern as health data importers.
- Should this be a one-time import or periodic sync? Periodic sync is more useful but adds complexity.
