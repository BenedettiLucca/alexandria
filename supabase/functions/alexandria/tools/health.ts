import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthContext, supabase } from "../config.ts";
import { getDataContext } from "../data_context.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";
import { normalizeHealthEntry } from "../health_contract.ts";
import type {
  CoverageRow,
  HealthEntryRow,
  HealthSummaryRow,
  SearchHealthEntryRow,
  TransitionRow,
} from "../types.ts";
import {
  computeBodyCompDelta,
  extractBodyCompMetrics,
  formatBodyCompSummary,
  formatCoverageReport,
  formatCoverageTransitions,
  formatCoverageWarnings,
  formatDailyHealthSummary,
  formatHealthEntry,
  recordToText,
} from "../lib.ts";

/**
 * Resolves the database client and user ID for health operations.
 * Prefers request-scoped DataContext; falls back to getAuth callback if present.
 */
function getContext(getAuth?: () => AuthContext | undefined): {
  client: any;
  userId: string;
} {
  try {
    const ctx = getDataContext();
    return { client: ctx.client, userId: ctx.userId };
  } catch {
    const auth = getAuth ? getAuth() : undefined;
    if (auth?.userId) {
      return { client: supabase, userId: auth.userId };
    }
    throw new Error("Request context or authentication is required");
  }
}

export function registerHealthTools(
  server: McpServer,
  getAuth?: () => AuthContext | undefined,
) {
  // 1. log_health
  server.registerTool(
    "log_health",
    {
      title: "Log Health Entry",
      description:
        "Record a health metric (sleep, exercise, heart rate, steps, weight, body composition, etc.). Uses canonical contract validation, atomic upsert, and explicit indexing status.",
      inputSchema: {
        entry_type: z.string().describe(
          "Type: steps, weight, heart_rate, sleep, exercise, body_composition, measurement_goal",
        ),
        timestamp: z.string().describe(
          "ISO 8601 timestamp with timezone offset (e.g. 2026-09-12T10:00:00Z or 2026-09-12T07:00:00-03:00)",
        ),
        duration_s: z.number().optional().describe("Duration in seconds"),
        value: z.record(z.any()).optional().describe(
          "Health data as JSON (varies by type)",
        ),
        tags: z.array(z.string()).optional(),
        numeric_value: z.number().optional().describe(
          "Primary numeric value (e.g. bpm for heart_rate, kg for weight, duration_hours for sleep)",
        ),
        external_id: z.string().optional().describe(
          "External record ID from source system for upsert dedup",
        ),
        source: z.string().optional().describe(
          "Source system (defaults to mcp)",
        ),
      },
    },
    wrapHandler(
      async ({
        entry_type,
        timestamp,
        duration_s,
        value,
        tags,
        numeric_value,
        external_id,
        source,
      }) => {
        const { client, userId } = getContext(getAuth);

        // Normalize and validate entry with canonical health contract
        let normalized: Record<string, unknown>;
        try {
          normalized = normalizeHealthEntry({
            entry_type,
            timestamp,
            duration_s,
            value: value ?? {},
            numeric_value,
            external_id,
            source: source || "mcp",
          });
        } catch (err: any) {
          throw new Error(`Health entry validation failed: ${err.message}`);
        }

        // Atomic upsert scoped by authenticated owner
        const { data: upsertResult, error: upsertErr } = await client.rpc(
          "upsert_health_entry",
          {
            p_entry_type: normalized.entry_type,
            p_timestamp: normalized.timestamp,
            p_value: normalized.value || {},
            p_numeric_value: normalized.numeric_value ?? null,
            p_duration_s: normalized.duration_s ?? null,
            p_tags: tags || [],
            p_source: normalized.source || "mcp",
            p_external_id: normalized.external_id ?? null,
            p_metadata: { contract_version: normalized.contract_version },
            p_user_id: userId,
          },
        );

        if (upsertErr) {
          throw new Error(`Health log upsert failed: ${upsertErr.message}`);
        }

        const id = upsertResult?.id;
        const status = upsertResult?.status || "created";

        // Explicit indexing status
        let indexingStatus = "pending";
        try {
          const text = recordToText(normalized.entry_type as string, {
            entry_type: normalized.entry_type,
            timestamp: normalized.timestamp,
            numeric_value: normalized.numeric_value,
            value: normalized.value,
            tags: tags || [],
          });
          const embedding = await getEmbedding(text);
          if (embedding && id) {
            const { error: embErr } = await client
              .from("health_entries")
              .update({
                embedding,
                embedding_status: "ready",
                embedded_at: new Date().toISOString(),
              })
              .eq("id", id)
              .eq("user_id", userId);
            if (!embErr) {
              indexingStatus = "ready";
            }
          }
        } catch {
          // Non-blocking: background outbox will reconcile
          indexingStatus = "pending";
        }

        return `Health entry logged: ${normalized.entry_type} at ${
          new Date(normalized.timestamp as string).toISOString()
        } [status: ${status}, indexing: ${indexingStatus}]`;
      },
    ),
  );

  // 2. query_health
  server.registerTool(
    "query_health",
    {
      title: "Query Health Entries",
      description:
        "Browse raw health entries with optional filtering by type, date range, or limit. Range filters take precedence; historical 'event_to' anchors the time window.",
      inputSchema: {
        entry_type: z.string().optional().describe("Filter by type"),
        days: z.number().optional().describe("Last N days"),
        limit: z.number().optional().default(20).describe(
          "Maximum entries to return (cap, default 20, max 100)",
        ),
        event_from: z.string().optional().describe(
          "Filter from timestamp (ISO 8601)",
        ),
        event_to: z.string().optional().describe(
          "Filter to timestamp (ISO 8601)",
        ),
      },
    },
    wrapHandler(async ({ entry_type, days, limit, event_from, event_to }) => {
      const { client, userId } = getContext(getAuth);

      if (event_from && isNaN(Date.parse(event_from))) {
        throw new Error("Invalid event_from timestamp format");
      }
      if (event_to && isNaN(Date.parse(event_to))) {
        throw new Error("Invalid event_to timestamp format");
      }
      if (event_from && event_to && new Date(event_from) > new Date(event_to)) {
        throw new Error("event_from must be less than or equal to event_to");
      }

      let fromTs = event_from;
      let toTs = event_to;

      if (!fromTs && days !== undefined) {
        if (days < 0) throw new Error("days must be non-negative");
        const anchor = toTs ? new Date(toTs) : new Date();
        const since = new Date(anchor.getTime() - days * 24 * 60 * 60 * 1000);
        fromTs = since.toISOString();
      }

      const cap = Math.min(Math.max(limit || 20, 1), 100);
      let q = client
        .from("health_entries")
        .select(
          "id, entry_type, timestamp, duration_s, value, numeric_value, tags, source, created_at, embedding_status",
        )
        .eq("user_id", userId)
        .order("timestamp", { ascending: false })
        .limit(cap + 1);

      if (entry_type) q = q.eq("entry_type", entry_type);
      if (fromTs) q = q.gte("timestamp", fromTs);
      if (toTs) q = q.lte("timestamp", toTs);

      const { data, error } = await q;
      if (error) throw new Error(`Health query failed: ${error.message}`);
      if (!data || data.length === 0) return "No health entries found.";

      const isTruncated = data.length > cap;
      const rows = isTruncated ? data.slice(0, cap) : data;

      const lines = rows.map((r: HealthEntryRow) =>
        recordToText(r.entry_type, {
          entry_type: r.entry_type,
          timestamp: r.timestamp,
          duration_s: r.duration_s,
          value: r.value,
          numeric_value: r.numeric_value,
          tags: r.tags,
          source: r.source,
        })
      );

      let output = lines.join("\n");
      if (isTruncated) {
        output +=
          `\n\n[Warning: Results truncated at ${cap} items. Refine date range or increase limit.]`;
      }
      return output;
    }),
  );

  // 3. search_health
  server.registerTool(
    "search_health",
    {
      title: "Semantic Search Health",
      description:
        "Semantic search across health entries using natural language (e.g. 'bad sleep this week', 'leg day squats', 'high heart rate during run'). Scoped to ready embeddings.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.3),
        entry_type: z.string().optional().describe("Filter by entry type"),
      },
    },
    wrapHandler(async ({ query, limit, threshold, entry_type }) => {
      const { client, userId } = getContext(getAuth);
      const qEmb = await getEmbedding(query);
      const { data, error } = await client.rpc("search_health_entries", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_entry_type: entry_type || null,
        p_user_id: userId,
      });

      if (error) throw new Error(`Search failed: ${error.message}`);
      if (!data || data.length === 0) {
        return `No health entries found matching "${query}".`;
      }

      const results = data.map(
        (t: HealthEntryRow & { similarity: number }, i: number) => {
          const parts = [
            `#${i + 1} [${t.entry_type.toUpperCase()}] ${
              new Date(t.timestamp).toLocaleString()
            } (similarity: ${(t.similarity * 100).toFixed(0)}%)`,
          ];
          if (t.numeric_value !== null && t.numeric_value !== undefined) {
            parts.push(`Value: ${t.numeric_value}`);
          }
          if (t.duration_s) {
            parts.push(`Duration: ${Math.round(t.duration_s / 60)}min`);
          }
          parts.push(`\n${JSON.stringify(t.value)}`);
          return parts.join("\n");
        },
      );

      return `Found ${data.length} health entr${
        data.length === 1 ? "y" : "ies"
      }:\n\n${results.join("\n\n")}`;
    }),
  );

  // 4. health_summary
  server.registerTool(
    "health_summary",
    {
      title: "Health Summary",
      description:
        "View daily aggregated health summaries. Range (from/to) takes precedence over days; cap is separated from range and truncation is explicitly warned.",
      inputSchema: {
        days: z.number().optional().default(7).describe(
          "Number of recent days to show (used when date range is omitted)",
        ),
        from: z.string().optional().describe(
          "Start date YYYY-MM-DD (overrides days)",
        ),
        to: z.string().optional().describe(
          "End date YYYY-MM-DD (anchors window if from is omitted)",
        ),
        limit: z.number().optional().default(100).describe(
          "Maximum number of summary days to return (cap, default 100, max 365)",
        ),
      },
    },
    wrapHandler(async ({ days, from, to, limit }) => {
      const { client, userId } = getContext(getAuth);
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (from && !dateRegex.test(from)) {
        throw new Error("Invalid from date format, expected YYYY-MM-DD");
      }
      if (to && !dateRegex.test(to)) {
        throw new Error("Invalid to date format, expected YYYY-MM-DD");
      }
      if (from && to && from > to) {
        throw new Error("from date must be less than or equal to to date");
      }

      let fromDate = from;
      let toDate = to;

      if (!fromDate) {
        const anchor = toDate ? new Date(toDate) : new Date();
        const effectiveDays = Math.max(days || 7, 1);
        const since = new Date(
          anchor.getTime() - (effectiveDays - 1) * 24 * 60 * 60 * 1000,
        );
        fromDate = since.toISOString().split("T")[0];
      }

      const cap = Math.min(Math.max(limit || 100, 1), 365);
      let q = client
        .from("health_summaries")
        .select("*")
        .eq("user_id", userId)
        .order("date", { ascending: false })
        .limit(cap + 1);

      if (fromDate) q = q.gte("date", fromDate);
      if (toDate) q = q.lte("date", toDate);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) {
        return "No summary computed yet. Use refresh_summary to generate one.";
      }

      const isTruncated = data.length > cap;
      const rows = isTruncated ? data.slice(0, cap) : data;

      const lines = rows.map((s: HealthSummaryRow) =>
        formatDailyHealthSummary(s)
      );

      let coverageDays = days || 7;
      if (from) {
        const fDate = new Date(from);
        const tDate = to ? new Date(to) : new Date();
        const diffMs = tDate.getTime() - fDate.getTime();
        coverageDays = Math.max(
          1,
          Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1,
        );
      }

      const { data: covData, error: covError } = await client.rpc(
        "compute_source_coverage",
        {
          target_days: coverageDays,
        },
      );

      let transitionMap: Record<string, TransitionRow> | undefined;
      const { data: transData, error: transError } = await client.rpc(
        "get_coverage_transition_report",
        { p_days: Math.max(coverageDays, 30) },
      );
      if (!transError && transData) {
        transitionMap = {};
        for (const t of transData as TransitionRow[]) {
          transitionMap[`${t.source_name}:${t.lane}`] = t;
        }
      }

      let warningsText = "";
      if (!covError && covData) {
        warningsText = formatCoverageWarnings(covData, transitionMap);
      }

      let summaryText = `${rows.length} day(s):\n\n${lines.join("\n\n")}`;
      if (isTruncated) {
        summaryText +=
          `\n\n[Warning: Summary results truncated at ${cap} days. Refine your date range to view all days.]`;
      }
      if (warningsText) {
        return `${summaryText}\n\n${warningsText}`;
      }
      return summaryText;
    }),
  );

  // 5. refresh_summary
  server.registerTool(
    "refresh_summary",
    {
      title: "Refresh Summary",
      description:
        "Compute or re-compute daily health summaries from raw health_entries and training_logs. Refresh is bounded, owner-scoped, and reports errors honestly.",
      inputSchema: {
        date: z.string().optional().describe(
          "Single date YYYY-MM-DD to refresh",
        ),
        days: z.number().min(1).max(365).optional().default(1).describe(
          "Number of recent days to refresh (used when date is omitted, max 365)",
        ),
        from: z.string().optional().describe(
          "Start date YYYY-MM-DD to refresh",
        ),
        to: z.string().optional().describe(
          "End date YYYY-MM-DD to refresh",
        ),
      },
    },
    wrapHandler(async ({ date, days, from, to }) => {
      const { client, userId } = getContext(getAuth);
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (date && !dateRegex.test(date)) {
        throw new Error("Invalid date format, expected YYYY-MM-DD");
      }
      if (from && !dateRegex.test(from)) {
        throw new Error("Invalid from date format, expected YYYY-MM-DD");
      }
      if (to && !dateRegex.test(to)) {
        throw new Error("Invalid to date format, expected YYYY-MM-DD");
      }
      if (from && to && from > to) {
        throw new Error("from date must be less than or equal to to date");
      }

      const dates: string[] = [];
      if (date) {
        dates.push(date);
      } else if (from) {
        const curr = new Date(from);
        const end = to ? new Date(to) : new Date();
        const maxRange = 365;
        let count = 0;
        while (curr <= end && count < maxRange) {
          dates.push(curr.toISOString().split("T")[0]);
          curr.setDate(curr.getDate() + 1);
          count++;
        }
      } else {
        const anchor = to ? new Date(to) : new Date();
        const effectiveDays = Math.min(days || 1, 365);
        for (let i = 0; i < effectiveDays; i++) {
          const d = new Date(anchor.getTime() - i * 24 * 60 * 60 * 1000);
          dates.push(d.toISOString().split("T")[0]);
        }
      }

      let computed = 0;
      const errors: string[] = [];

      for (const d of dates) {
        const { error: rpcError } = await client.rpc(
          "compute_daily_summary",
          {
            target_date: d,
            p_user_id: userId,
          },
        );
        if (rpcError) {
          errors.push(`${d}: ${rpcError.message}`);
        } else {
          computed++;
        }
      }

      let result = `Refreshed ${computed} of ${dates.length} summary(s).`;
      if (errors.length) {
        result += `\n\nErrors (${errors.length}):\n${errors.join("\n")}`;
      }
      return result;
    }),
  );

  // 6. delete_health_entry
  server.registerTool(
    "delete_health_entry",
    {
      title: "Delete Health Entry",
      description:
        "Permanently delete a health entry by ID. Scoped strictly to the authenticated owner.",
      inputSchema: {
        id: z.string().uuid().describe("Health entry ID to delete"),
      },
    },
    wrapHandler(async ({ id }) => {
      const { client, userId } = getContext(getAuth);
      const { data, error } = await client
        .from("health_entries")
        .delete()
        .eq("id", id)
        .eq("user_id", userId)
        .select("id, entry_type, timestamp")
        .maybeSingle();

      if (error) throw new Error(`Health entry delete failed: ${error.message}`);
      if (!data) {
        throw new Error(
          `Health entry ${id} not found or belongs to another owner.`,
        );
      }
      return `Deleted health entry: ${data.entry_type} at ${
        new Date(data.timestamp).toLocaleString()
      }`;
    }),
  );

  // 7. bodycomp_summary
  server.registerTool(
    "bodycomp_summary",
    {
      title: "Body Composition Summary",
      description:
        "View body composition trends, deltas, and goal progress. Includes weight, body fat, muscle mass, and body measurements.",
      inputSchema: {
        days: z.number().optional().default(30).describe(
          "How many days back to look",
        ),
        from: z.string().optional().describe("ISO date YYYY-MM-DD"),
        to: z.string().optional().describe("ISO date YYYY-MM-DD"),
      },
    },
    wrapHandler(async ({ days, from, to }) => {
      const { client, userId } = getContext(getAuth);
      const toDate = to ? new Date(to) : new Date();
      if (to && !to.includes("T")) toDate.setHours(23, 59, 59, 999);

      const fromDate = from ? new Date(from) : new Date(toDate);
      if (!from) {
        fromDate.setDate(fromDate.getDate() - (days || 30));
      }
      if (from && !from.includes("T")) fromDate.setHours(0, 0, 0, 0);

      const fromISO = fromDate.toISOString();
      const toISO = toDate.toISOString();

      const { data: entriesData, error: entriesError } = await client
        .from("health_entries")
        .select("timestamp, numeric_value, value, metadata")
        .eq("user_id", userId)
        .eq("entry_type", "body_composition")
        .gte("timestamp", fromISO)
        .lte("timestamp", toISO)
        .order("timestamp", { ascending: false })
        .limit(366);

      if (entriesError) throw new Error(entriesError.message);

      const { data: baselineData, error: baselineError } = await client
        .from("health_entries")
        .select("timestamp, numeric_value, value, metadata")
        .eq("user_id", userId)
        .eq("entry_type", "body_composition")
        .lt("timestamp", fromISO)
        .order("timestamp", { ascending: false })
        .limit(1);

      if (baselineError) throw new Error(baselineError.message);

      const { data: goalsData, error: goalsError } = await client
        .from("health_entries")
        .select("timestamp, value")
        .eq("user_id", userId)
        .eq("entry_type", "measurement_goal")
        .lte("timestamp", toISO)
        .order("timestamp", { ascending: false })
        .limit(100);

      if (goalsError) throw new Error(goalsError.message);

      if (!entriesData || entriesData.length === 0) {
        return "No body composition entries found in the selected period.";
      }

      const allEntries = [...entriesData, ...(baselineData || [])];
      const processedEntries = entriesData.map((e: any, i: number) => {
        const value = (e.value || {}) as Record<string, unknown>;
        if (e.numeric_value != null && value.weight_kg == null) {
          value.weight_kg = e.numeric_value;
        }
        const metrics = extractBodyCompMetrics(value);
        const prev = allEntries[i + 1];
        let delta;
        if (prev) {
          const previousValue = (prev.value || {}) as Record<string, unknown>;
          if (prev.numeric_value != null && previousValue.weight_kg == null) {
            previousValue.weight_kg = prev.numeric_value;
          }
          delta = computeBodyCompDelta(metrics, extractBodyCompMetrics(previousValue));
        }
        return {
          timestamp: e.timestamp,
          metrics,
          delta,
          context: e.metadata?.measurement_context,
          precision: e.metadata?.date_precision,
        };
      });

      const latestMetrics = processedEntries[0]?.metrics || {};
      const processedGoals = (goalsData || []).map((g: any) => {
        const v = g.value ?? {};
        const metricName = v.metric_name || v.metric || (v.target_weight_kg != null ? "weight_kg" : undefined);
        const targetValue = v.target_value ?? v.target ?? v.target_weight_kg;
        const status = v.status || (v.achieved === true ? "achieved" : "active");
        return {
          metric_name: metricName,
          target_value: targetValue,
          current_value: v.current_value ?? (metricName ? latestMetrics[metricName] ?? null : null),
          target_date: v.target_date ?? null,
          status,
        };
      }).filter((g: any) => g.metric_name && typeof g.target_value === "number" && Number.isFinite(g.target_value) && g.status !== "cancelled");

      return formatBodyCompSummary(
        processedEntries,
        processedGoals,
        {
          from: fromISO.split("T")[0],
          to: toISO.split("T")[0],
        },
      );
    }),
  );

  // 8. source_coverage_report
  server.registerTool(
    "source_coverage_report",
    {
      title: "Source Coverage Report",
      description:
        "Get diagnostic source/lane coverage health check. Grouped by status severity.",
      inputSchema: {
        days: z.number().optional().default(7).describe(
          "Number of recent days to evaluate coverage diagnostics",
        ),
      },
    },
    wrapHandler(async ({ days }) => {
      const { client } = getContext(getAuth);
      const { data, error } = await client.rpc("compute_source_coverage", {
        target_days: days || 7,
      });
      if (error) throw new Error(error.message);
      if (!data) return "No coverage data returned.";
      return formatCoverageReport(data);
    }),
  );

  // 9. coverage_transition_report
  server.registerTool(
    "coverage_transition_report",
    {
      title: "Coverage Transition Report",
      description:
        "Report coverage transitions from persisted snapshots: NEW, ONGOING, or RECOVERED degradation per lane, degradation streaks, and trust-blocking lanes. Requires coverage snapshots to exist.",
      inputSchema: {
        days: z.number().optional().default(30).describe(
          "Number of recent days to analyze transitions",
        ),
      },
    },
    wrapHandler(async ({ days }) => {
      const { client } = getContext(getAuth);
      const { data, error } = await client.rpc(
        "get_coverage_transition_report",
        {
          p_days: days || 30,
        },
      );
      if (error) throw new Error(error.message);
      if (!data) return "No coverage transition data returned.";
      const rows = data as TransitionRow[];
      return formatCoverageTransitions(rows);
    }),
  );
}
