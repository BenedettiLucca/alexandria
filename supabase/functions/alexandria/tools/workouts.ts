import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase, AuthContext } from "../config.ts";
import { getEmbedding, wrapHandler } from "../helpers.ts";
import { TrainingLogRow } from "../types.ts";
import { workoutToText } from "../lib.ts";

export function registerWorkoutsTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
) {
  server.registerTool(
    "log_workout",
    {
      title: "Log Workout",
      description:
        "Record a training session. Use for manual logging or Iron-Log imports.",
      inputSchema: {
        workout_date: z.string().describe("Date YYYY-MM-DD"),
        workout_type: z.string().describe(
          "Type: strength, cardio, flexibility, other",
        ),
        name: z.string().describe("Workout name (e.g. 'Push Day', '5K Run')"),
        exercises: z.array(z.record(z.any())).describe(
          "Array of exercises: [{name, sets, reps, weight_kg, rpe, notes}]",
        ),
        duration_s: z.number().optional().describe("Duration in seconds"),
        volume_kg: z.number().optional().describe("Total volume in kg"),
        rpe: z.number().optional().describe("Overall RPE 1-10"),
        notes: z.string().optional(),
        tags: z.array(z.string()).optional(),
        external_id: z.string().optional().describe(
          "External record ID from source system for upsert dedup",
        ),
      },
    },
    wrapHandler(
      async (
        {
          workout_date,
          workout_type,
          name,
          exercises,
          duration_s,
          volume_kg,
          rpe,
          notes,
          tags,
          external_id,
        },
      ) => {
        const row: Record<string, unknown> = {
          workout_date,
          workout_type,
          name,
          exercises,
          duration_s: duration_s || null,
          volume_kg: volume_kg || null,
          rpe: rpe || null,
          notes: notes || null,
          tags: tags || [],
        };
        if (external_id !== undefined) row.external_id = external_id;

        const { data, error } = await supabase
          .from("training_logs")
          .insert(row)
          .select("id")
          .single();

        if (error) throw new Error("Workout log failed");
        const id = data?.id;

        try {
          const text = workoutToText({ ...row });
          const embedding = await getEmbedding(text);
          await supabase.from("training_logs").update({ embedding }).eq("id", id);
        } catch { /* non-blocking */ }

        return `Workout logged: ${name} (${workout_type}) on ${workout_date}`;
      },
    ),
  );

  server.registerTool(
    "query_workouts",
    {
      title: "Query Workouts",
      description:
        "Search training history. Use when the user asks about past workouts, progress, or training patterns.",
      inputSchema: {
        workout_type: z.string().optional().describe(
          "Filter: strength, cardio, flexibility, other",
        ),
        days: z.number().optional().describe("Last N days"),
        limit: z.number().optional().default(20),
      },
    },
    wrapHandler(async ({ workout_type, days, limit }) => {
      let q = supabase
        .from("training_logs")
        .select(
          "workout_date, workout_type, name, exercises, volume_kg, rpe, notes",
        )
        .order("workout_date", { ascending: false })
        .limit(limit);

      if (workout_type) q = q.eq("workout_type", workout_type);
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("workout_date", since.toISOString().split("T")[0]);
      }

      const { data, error } = await q;
      if (error) throw new Error(error.message);
      if (!data?.length) return "No workouts found.";

      const results = data.map((w: any, i: number) => {
        const vol = w.volume_kg ? ` | Vol: ${w.volume_kg}kg` : "";
        const rpe = w.rpe ? ` | RPE: ${w.rpe}` : "";
        const exCount = Array.isArray(w.exercises)
          ? `${w.exercises.length} exercises`
          : "";
        return `${
          i + 1
        }. [${w.workout_date}] ${w.name} (${w.workout_type})${vol}${rpe}\n   ${exCount}${
          w.notes ? " -- " + w.notes : ""
        }`;
      });
      return `${data.length} workout(s):\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "search_workouts",
    {
      title: "Search Workouts (Semantic)",
      description:
        "Search training logs by semantic meaning. Use when the user asks about training patterns like 'heavy bench press days', 'cardio sessions last month', 'high volume workouts'.",
      inputSchema: {
        query: z.string().describe("Natural language search query"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.3),
        workout_type: z.string().optional().describe(
          "Filter: strength, cardio, flexibility, other",
        ),
      },
    },
    wrapHandler(async ({ query, limit, threshold, workout_type }) => {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("search_training_logs", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter_workout_type: workout_type || null,
      });

      if (error) throw new Error("Workout search failed");
      if (!data || data.length === 0) {
        return `No workouts found matching "${query}".`;
      }

      const results = data.map(
        (t: any, i: number) => {          const parts = [
            `--- ${i + 1}. ${(t.similarity! * 100).toFixed(1)}% match ---`,
            `Workout: ${t.name} (${t.workout_type}) on ${t.workout_date}`,
          ];
          if (t.volume_kg != null) parts.push(`Volume: ${t.volume_kg}kg`);
          if (t.rpe != null) parts.push(`RPE: ${t.rpe}`);
          if (t.duration_s) {
            parts.push(`Duration: ${Math.round(t.duration_s / 60)}min`);
          }
          if (t.exercises?.length) {
            const exList = t.exercises!.map((e: Record<string, unknown>) => {
              const sets = e.sets != null ? `${e.sets}x` : "";
              const reps = e.reps != null ? `${e.reps}` : "";
              const w = e.weight_kg != null ? `@${e.weight_kg}kg` : "";
              return `  - ${e.name} ${sets}${reps}${w}`.trim();
            });
            parts.push(`Exercises:\n${exList.join("\n")}`);
          }
          if (t.notes) parts.push(`Notes: ${t.notes}`);
          return parts.join("\n");
        },
      );

      return `Found ${data.length} workout(s):\n\n${results.join("\n\n")}`;
    }),
  );

  server.registerTool(
    "update_workout",
    {
      title: "Update Workout",
      description: "Update an existing training log entry.",
      inputSchema: {
        id: z.string().uuid().describe("Workout ID to update"),
        name: z.string().optional(),
        workout_type: z.string().optional(),
        exercises: z.array(z.record(z.any())).optional().describe(
          "Array of exercises: [{name, sets, reps, weight_kg, rpe, notes}]",
        ),
        duration_s: z.number().optional(),
        volume_kg: z.number().optional(),
        rpe: z.number().min(1).max(10).optional(),
        notes: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    wrapHandler(
      async (
        {
          id,
          name,
          workout_type,
          exercises,
          duration_s,
          volume_kg,
          rpe,
          notes,
          tags,
        },
      ) => {
        const update: Record<string, unknown> = {};
        if (name !== undefined) update.name = name;
        if (workout_type !== undefined) update.workout_type = workout_type;
        if (exercises !== undefined) update.exercises = exercises;
        if (duration_s !== undefined) update.duration_s = duration_s;
        if (volume_kg !== undefined) update.volume_kg = volume_kg;
        if (rpe !== undefined) update.rpe = rpe;
        if (notes !== undefined) update.notes = notes;
        if (tags !== undefined) update.tags = tags;

        const { data, error } = await supabase
          .from("training_logs")
          .update(update)
          .eq("id", id)
          .select("id, name, workout_type, workout_date")
          .single();

        if (error) throw new Error("Workout update failed");
        if (!data) throw new Error(`Workout ${id} not found.`);
        return `Workout updated: "${data.name}" (${data.workout_type}) on ${data.workout_date}`;
      },
    ),
  );
}
