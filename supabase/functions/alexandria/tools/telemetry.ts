import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { supabase } from "../config.ts";
import type { AuthContext } from "../config.ts";
import { wrapHandler } from "../helpers.ts";
import { formatToolActivationReport } from "../lib.ts";
import type { ToolActivationRow } from "../types.ts";

export function registerTelemetryTools(
  server: McpServer,
  _getAuth: () => AuthContext | undefined,
): void {
  server.registerTool(
    "get_tool_activation_report",
    {
      title: "Tool Activation Report",
      description:
        "Get MCP tool activation heatmap: which tools have been called in the last 7/30/90 days, never-called tools, call frequency trends, client diversity, success rate, and latency.",
      inputSchema: {
        days: z.number().optional().default(90).describe(
          "Lookback window in days (default 90)",
        ),
      },
    },
    wrapHandler(async ({ days }) => {
      const { data, error } = await supabase.rpc("get_tool_activation_report", {
        p_days: days ?? 90,
      });
      if (error) throw new Error(error.message);
      if (!data) return "No tool activation data returned.";
      return formatToolActivationReport(data as ToolActivationRow[]);
    }),
  );
}
