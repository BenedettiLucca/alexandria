import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AuthContext } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import {
  DEFAULT_EMBEDDING_SPACE,
  IndexingWorker,
} from "../lifecycle.ts";

export function registerIndexingTools(
  server: McpServer,
  getAuth: () => AuthContext | undefined,
) {
  const worker = new IndexingWorker();

  // 1. get_indexing_status
  server.registerTool(
    "get_indexing_status",
    {
      title: "Get Indexing Lifecycle Status",
      description:
        "Get current observable status of the indexing lifecycle across all vector domains and outbox queue.",
    },
    wrapHandler(async () => {
      const auth = getAuth();
      const status = await worker.getLifecycleStatus(auth);
      return JSON.stringify(status, null, 2);
    }),
  );

  // 2. reconcile_indexing
  server.registerTool(
    "reconcile_indexing",
    {
      title: "Reconcile Indexing Outbox",
      description:
        "Execute a bounded batch reconciliation of pending indexing outbox jobs with strict cap and deadline.",
      inputSchema: {
        cap: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(20)
          .describe("Maximum number of jobs to process in this run"),
        deadline_ms: z
          .number()
          .min(500)
          .max(30000)
          .optional()
          .default(10000)
          .describe("Execution deadline in milliseconds"),
        target_space: z
          .string()
          .optional()
          .default(DEFAULT_EMBEDDING_SPACE)
          .describe("Target embedding space (e.g. openai/text-embedding-3-small)"),
        domain: z
          .enum(["memories", "briefs", "health_entries", "training_logs", "all"])
          .optional()
          .default("all")
          .describe("Limit reconciliation to a specific table or 'all'"),
      },
    },
    wrapHandler(async ({ cap, deadline_ms, target_space, domain }: {
      cap?: number;
      deadline_ms?: number;
      target_space?: string;
      domain?: "memories" | "briefs" | "health_entries" | "training_logs" | "all";
    }) => {
      const auth = getAuth();
      const result = await worker.reconcileBatch({
        cap: cap ?? 20,
        deadlineMs: deadline_ms ?? 10000,
        targetSpace: target_space ?? DEFAULT_EMBEDDING_SPACE,
        domain: domain ?? "all",
        authContext: auth,
      });
      return JSON.stringify(result, null, 2);
    }),
  );

  // 3. trigger_indexing_backfill
  server.registerTool(
    "trigger_indexing_backfill",
    {
      title: "Trigger Indexing Backfill",
      description:
        "Enqueue legacy rows for indexing backfill. Explicit target space and budget limit are strictly required.",
      inputSchema: {
        target_space: z
          .string()
          .min(1)
          .describe("Explicit target embedding space (e.g. 'openai/text-embedding-3-small')"),
        budget_limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .describe("Maximum number of rows to enqueue for backfill (bounded budget)"),
        domain: z
          .enum(["memories", "briefs", "health_entries", "training_logs", "all"])
          .optional()
          .default("all")
          .describe("Target specific domain or 'all'"),
      },
    },
    wrapHandler(async ({ target_space, budget_limit, domain }: {
      target_space: string;
      budget_limit: number;
      domain?: "memories" | "briefs" | "health_entries" | "training_logs" | "all";
    }) => {
      const auth = getAuth();
      const result = await worker.backfillLegacy({
        space: target_space,
        budget: budget_limit,
        domain: domain ?? "all",
        authContext: auth,
      });
      return JSON.stringify(result, null, 2);
    }),
  );
}
