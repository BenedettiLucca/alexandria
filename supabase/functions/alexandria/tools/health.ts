import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";
import { HealthEntryRow, HealthSummaryRow } from "../types.ts";
import { recordToText } from "../lib.ts";

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
        (e: any, i: number) => {          const ts = new Date(e.timestamp).toLocaleString();
          const dur = e.duration_s
            ? ` (${Math.round(e.duration_s / 60)}min)`
            : "";
          const numVal = e.numeric_value != null ? ` [${e.numeric_value}]` : "";
          return `${i + 1}. [${ts}] ${e.entry_type}${dur}${numVal}\n   ${
            JSON.stringify(e.value)
          }`;
        },
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

      const lines = data.map((s: any) => {
        const parts = [`== ${s.date} ==`];
        if (s.sleep_total_hours != null) {
          parts.push(
            `Sleep: ${s.sleep_total_hours}h (${s.sleep_sessions || 0} sessions)`,
          );
        }
        if (s.steps_total != null) {
          parts.push(
            `Steps: ${s.steps_total}${
              s.steps_active_minutes
                ? ` (${s.steps_active_minutes}min active)`
                : ""
            }`,
          );
        }
        if (s.hr_avg != null) {
          parts.push(
            `HR: avg ${s.hr_avg} / min ${s.hr_min} / max ${s.hr_max} bpm (${s.hr_samples} samples)`,
          );
        }
        if (s.weight_kg != null) parts.push(`Weight: ${s.weight_kg}kg`);
        if (s.exercise_count > 0) {
          parts.push(
            `Exercise: ${s.exercise_count} sessions, ${s.exercise_total_minutes}min${
              s.exercise_types?.length ? ` [${s.exercise_types.join(", ")}]` : ""
            }`,
          );
        }
        if (s.workout_count > 0) {
          parts.push(
            `Training: ${s.workout_count} workouts${
              s.training_volume_kg ? `, ${s.training_volume_kg}kg vol` : ""
            }${
              s.training_types?.length ? ` [${s.training_types.join(", ")}]` : ""
            }`,
          );
        }
        if (s.sources?.length) parts.push(`Sources: ${s.sources.join(", ")}`);
        if (s.computed_at) {
          parts.push(`Computed: ${new Date(s.computed_at).toLocaleString()}`);
        }
        return parts.join("\n");
      });

      return `${data.length} day(s):\n\n${lines.join("\n\n")}`;
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
}
