# Iron-log → Alexandria Sync Bridge

**Date captured:** 2026-07-23
**Source:** Synapse Diff cron
**Project path:** `/home/lucca/Projects/alexandria` (destination), `/home/lucca/Projects/iron-log` (source)
**Feature name:** Iron-log → Alexandria sync bridge (Hermes cron)

## Summary / Pitch

A Hermes cron job that reads Iron-log's exported fitness data (weight, reps, RPE, PRs, RIR) and auto-syncs structured notes into Alexandria, which then updates the vault's `Progress.md` without manual copy-paste.

Current flow: manual. "Dados importados do Alexandria (Iron Log). Última sync: 2026-07-20." — the last sync was 3 days ago and requires manual effort.

Desired flow: automatic. A daily Hermes cron reads Iron-log's SQLite database (via Drizzle ORM), transforms workout records into structured Alexandria notes, and updates the vault's Progress.md.

## Why Now

- Today's task list includes "alexandria + hermes connection (Iron Log)" — this is explicitly on Lucca's radar
- Alexandria's ponytail sprint 2 just consolidated `sync_aggregate` and created `meetcap shared utils` — the pattern for shared utility functions between projects is now established
- Iron-log's Sprint 4 just shipped CI + security gates, meaning the project is mature enough to build integration points
- The Progress.md shows last sync was 2026-07-20 — 3 days stale, and the manual sync is a recurring bottleneck
- 112.8kg new all-time low (20/07) — the most interesting fitness data point in months — and the sync is already stale

## Suggested Implementation

> **⚠️ Update 2026-07-26 (Proactivity Check):** Step 1 is **already done.** `services/AlexandriaExportService.ts` (412 lines, commit `4650857`, test at `__tests__/services/alexandria-export.test.ts`) outputs exactly the schema below — `export_version`, `exported_at`, `sessions[]`, `body_metrics[]`, `personal_records[]`, `measurement_goals[]`, each with `external_id` for upsert dedup. The export *logic* is complete and tested. What remains open is the **trigger/transport** (see Open Questions) — the service currently uses `expo-file-system` + `expo-sharing`, so it runs on-device and cannot be invoked directly by Hermes.

1. ~~**Export endpoint in Iron-log:**~~ **DONE.** `AlexandriaExportService.ts` reads the Drizzle SQLite DB and outputs structured JSON with:
   - Workout sessions (date, treino type, volume, RPE, duration)
   - Exercise entries (name, load, reps, sets, RIR)
   - Body weight records
   - PRs detected since last export

2. **Hermes cron:** A daily cron job (`~/.hermes/cron/iron-log-to-alexandria/`) that:
   - Runs the export script on Iron-log's database
   - Transforms data into Alexandria note format
   - Pushes to Alexandria via MCP
   - Updates the vault's `Projects/FitnessPlan/Progress.md`

3. **Alexandria note schema:** Structured notes per workout session with the same format as the current Progress.md but standardized:
   ```yaml
   type: fitness-workout
   date: YYYY-MM-DD
   program: martelo-de-forja-v9.2
   treino: A | B | C
   volume: 13282
   rpe: 9
   duration_min: 87
   body_weight_kg: 112.8
   exercises:
     - name: agachamento-livre
       load: 90
       sets: 3
       reps: [8, 8, 8]
       rir: [2, 1, 0]
     - ...
   ```

## Effort

**M** — ~3-5 dias:
- Day 1: Export script in Iron-log (reads Drizzle DB, outputs JSON)
- Day 2: Alexandria note schema + Hermes cron wiring
- Day 3: Edge cases (first sync, missing data, conflict resolution)
- Day 4-5: Testing + writing the QA runbook

## Open Questions / Risks

- **Mobile-first problem:** Iron-log runs on a mobile device (Expo/React Native). The SQLite database is local. How does Hermes access it? Options: (a) periodic backup to a shared location, (b) Iron-log exposes a local HTTP endpoint, (c) Syncthing syncs the DB to a Hermes-accessible path
- **Conflict resolution:** What happens when both manual and automated sync update the same Progress.md? Need a lock file or a "last synced" timestamp
- **First sync:** The Progress.md has 460+ lines of historical data. Does the bridge backfill or only carry forward? Recommend: carry forward only, historical data stays as-is
- **PR detection:** The current Progress.md detects PRs manually. The bridge could auto-detect PRs by comparing against historical records — but that's a v2 feature