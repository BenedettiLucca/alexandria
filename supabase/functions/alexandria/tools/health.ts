import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";

import {
  computeBodyCompDelta,
  extractBodyCompMetrics,
  formatBodyCompSummary,
  formatDailyHealthSummary,
  formatHealthEntry,
  recordToText,
  formatCoverageWarnings,
  formatCoverageReport,
} from "../lib.ts";


export function registerHealthTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "log_health",
    {
      title: "Log Health Entry",
      description:
        "Record a health data point. Use for manual logging or data imports from Health Connect.",
      inputSchema: {
        entry_type: z.string().describe(
          "Type: sleep, exercise, heart_rate, steps, weight, water, nutrition, blood_pressure, stress, cycle, body_composition",
        ),
        timestamp: z.string().describe("ISO 8601 timestamp"),
        duration_s: z.number().optional().describe("Duration in seconds"),
        value: z.record(z.any()).describe("Health data as JSON (varies by type)"),
        tags: z.array(z.string()).optional(),
        numeric_value: z.number().optional().describe(
          "Primary numeric value (e.g. bpm for heart_rate, kg for weight, duration_hours for sleep)",
        ),
        external_id: z.string().optional().describe(
          "External record ID from source system for upsert dedup",
        ),
      },
    },
    wrapHandler(
      async (
        {
          entry_type,
          timestamp,
          duration_s,
          value,
          tags,
          numeric_value,
          external_id,
        },
      ) => {
        const row: Record<string, unknown> = {
          entry_type,
          timestamp,
          duration_s: duration_s || null,
          value,
          tags: tags || [],
          source: "mcp",
        };
        if (numeric_value !== undefined) row.numeric_value = numeric_value;
        if (external_id !== undefined) row.external_id = external_id;

        const { data, error } = await supabase
          .from("health_entries")
          .insert(row)
          .select("id")
          .single();

        if (error) throw new Error("Health log failed");
        const id = data?.id;

        try {
          const text = recordToText(entry_type, {
            ...row,
            timestamp: row.timestamp,
          });
          const embedding = await getEmbedding(text);
          await supabase.from("health_entries").update({ embedding }).eq(
            "id",
            id,
          );
        } catch { /* non-blocking */ }

        return `Health entry logged: ${entry_type} at ${
          new Date(timestamp).toLocaleString()
        }`;
      },
    ),
  );

  server.registerTool(
    "query_health",
    {
      title: "Query Health Data",
      description:
        "Search and filter health entries. Use when the user asks about their health history.",
      inputSchema: {
        entry_type: z.string().optional().describe("Filter by type"),
        days: z.number().optional().describe("Last N days"),
        limit: z.number().optional().default(20),
        event_from: z.string().optional().describe(
          "Filter from timestamp (ISO 8601)",
        ),
        event_to: z.string().optional().describe(
          "Filter to timestamp (ISO 8601)",
        ),
      },
    },
    wrapHandler(async ({ entry_type, days, limit, event_from, event_to }) => {
      let q = supabase
        .from("health_entries")
        .select("entry_type, timestamp, duration_s, numeric_value, value, tags")
        .order("timestamp", { ascending: false })
        .limit(limit);

      if (entry_type) q = q.eq("entry_type", entry_type);
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("timestamp", since.toISOString());
      }
      if (event_from) q = q.gte("timestamp", event_from);
      if (event_to) q = q.lte("timestamp", event_to);

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) return "No health entries found.";

      const results = data.map(
        (e: any, i: number) => formatHealthEntry(e, i),
      );
      return `${data.length} health entries:\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "search_health",
    {
      title: "Search Health (Semantic)",
      description:
        "Search health entries by semantic meaning. Use when the user asks about health patterns like 'days I slept poorly', 'high heart rate episodes', 'when did I walk a lot'.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.3),
        entry_type: z.string().optional().describe(
          "Filter by entry type (e.g. sleep, steps, heart_rate)",
        ),
      },
    },
    wrapHandler(async ({ query, limit, threshold, entry_type }) => {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_health_entries", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_entry_type: entry_type || null,
      });

      if (error) throw new Error("Health search failed");
      if (!data || data.length === 0) {
        return `No health entries found matching "${query}".`;
      }

      const results = data.map(
        (
          t: any,
          i: number,
        ) => {          const parts = [
            `--- ${i + 1}. ${(t.similarity! * 100).toFixed(1)}% match ---`,
            `Type: ${t.entry_type}`,
            `Date: ${new Date(t.timestamp).toLocaleString()}`,
          ];
          if (t.numeric_value != null) parts.push(`Value: ${t.numeric_value}`);
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

  server.registerTool(
    "health_summary",
    {
      title: "Health Summary",
      description:
        "View daily aggregated health summaries. Use when the user asks about their daily or weekly health overview, sleep stats, step counts, heart rate trends, or training volume.",
      inputSchema: {
        days: z.number().optional().default(7).describe(
          "Number of recent days to show",
        ),
        from: z.string().optional().describe(
          "Start date YYYY-MM-DD (overrides days)",
        ),
        to: z.string().optional().describe(
          "End date YYYY-MM-DD (overrides days)",
        ),
      },
    },
    wrapHandler(async ({ days, from, to }) => {
      let q = supabase
        .from("health_summaries")
        .select("*")
        .order("date", { ascending: false })
        .limit(days);

      if (from) q = q.gte("date", from);
      if (to) q = q.lte("date", to);
      if (!from) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("date", since.toISOString().split("T")[0]);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) {
        return "No summary computed yet. Use refresh_summary to generate one.";
      }

      const lines = data.map((s: any) => formatDailyHealthSummary(s));

      let coverageDays = days || 7;
      if (from) {
        const fromDate = new Date(from);
        const toDate = to ? new Date(to) : new Date();
        const diffMs = toDate.getTime() - fromDate.getTime();
        coverageDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
      }

      const { data: covData, error: covError } = await supabase.rpc("compute_source_coverage", {
        target_days: coverageDays,
      });

      let warningsText = "";
      if (!covError && covData) {
        warningsText = formatCoverageWarnings(covData);
      }

      const summaryText = `${data.length} day(s):\n\n${lines.join("\n\n")}`;
      if (warningsText) {
        return `${summaryText}\n\n${warningsText}`;
      }
      return summaryText;
    }),
  );

  server.registerTool(
    "refresh_summary",
    {
      title: "Refresh Summary",
      description:
        "Compute or re-compute daily health summaries from raw health_entries and training_logs. Use after importing new data or to recalculate summaries.",
      inputSchema: {
        date: z.string().optional().describe("Single date YYYY-MM-DD to refresh"),
        days: z.number().optional().default(1).describe(
          "Number of recent days to refresh (used when date is omitted)",
        ),
      },
    },
    wrapHandler(async ({ date, days }) => {
      const dates: string[] = [];
      if (date) {
        dates.push(date);
      } else {
        for (let i = 0; i < days; i++) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          dates.push(d.toISOString().split("T")[0]);
        }
      }

      let computed = 0;
      const errors: string[] = [];

      for (const d of dates) {
        const { error: rpcError } = await supabase.rpc("compute_daily_summary", {
          target_date: d,
        });
        if (rpcError) {
          errors.push(`${d}: ${rpcError.message}`);
        } else {
          computed++;
        }
      }

      let result = `Refreshed ${computed} of ${dates.length} summary(s).`;
      if (errors.length) result += `\n\nErrors:\n${errors.join("\n")}`;
      return result;
    }),
  );

  server.registerTool(
    "delete_health_entry",
    {
      title: "Delete Health Entry",
      description: "Permanently delete a health entry by ID.",
      inputSchema: {
        id: z.string().uuid().describe("Health entry ID to delete"),
      },
    },
    wrapHandler(async ({ id }) => {
      const { data, error } = await supabase
        .from("health_entries")
        .delete()
        .eq("id", id)
        .select("id, entry_type, timestamp")
        .single();

      if (error) throw new Error("Health entry delete failed");
      if (!data) throw new Error(`Health entry ${id} not found.`);
      return `Deleted health entry: ${data.entry_type} at ${
        new Date(data.timestamp).toLocaleString()
      }`;
    }),
  );

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
      const toDate = to ? new Date(to) : new Date();
      if (to && !to.includes("T")) toDate.setHours(23, 59, 59, 999);

      const fromDate = from ? new Date(from) : new Date(toDate);
      if (!from) {
        fromDate.setDate(fromDate.getDate() - (days || 30));
      }
      if (from && !from.includes("T")) fromDate.setHours(0, 0, 0, 0);

      const fromISO = fromDate.toISOString();
      const toISO = toDate.toISOString();

      const { data: entriesData, error: entriesError } = await supabase
        .from("health_entries")
        .select("timestamp, value, metadata")
        .eq("entry_type", "body_composition")
        .gte("timestamp", fromISO)
        .lte("timestamp", toISO)
        .order("timestamp", { ascending: false });

      if (entriesError) throw new Error(entriesError.message);

      const { data: goalsData, error: goalsError } = await supabase
        .from("health_entries")
        .select("value")
        .eq("entry_type", "measurement_goal")
        .gte("timestamp", fromISO)
        .lte("timestamp", toISO);

      if (goalsError) throw new Error(goalsError.message);

      if (!entriesData || entriesData.length === 0) {
        return "No body composition entries found in the selected period.";
      }

      const processedEntries = entriesData.map((e, i) => {
        const metrics = extractBodyCompMetrics(
          e.value as Record<string, unknown>,
        );
        const prev = entriesData[i + 1];
        let delta;
        if (prev) {
          const prevMetrics = extractBodyCompMetrics(
            prev.value as Record<string, unknown>,
          );
          delta = computeBodyCompDelta(metrics, prevMetrics);
        }
        return {
          timestamp: e.timestamp,
          metrics,
          delta,
          context: (e.metadata as any)?.measurement_context,
          precision: (e.metadata as any)?.date_precision,
        };
      });

      const processedGoals = (goalsData || []).map((g) => {
        const v = g.value as any;
        return {
          metric_name: v.metric_name,
          target_value: v.target_value,
          current_value: v.current_value,
          target_date: v.target_date,
          status: v.status,
        };
      });

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
      const { data, error } = await supabase.rpc("compute_source_coverage", {
        target_days: days || 7,
      });
      if (error) throw new Error(error.message);
      if (!data) return "No coverage data returned.";
      return formatCoverageReport(data);
    }),
  );
}

