import { supabase } from "./config.ts";
import { getContext } from "./context.ts";

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
  );
  return `{${parts.join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function paramsHash(args: unknown): Promise<string> {
  return sha256Hex(canonicalJson(args));
}

export interface ToolCallEvent {
  toolName: string;
  args: unknown;
  success: boolean;
  latencyMs: number;
}

export async function recordToolCall(event: ToolCallEvent): Promise<void> {
  try {
    const ctx = getContext();
    await supabase.from("tool_call_log").insert({
      tool_name: event.toolName,
      caller_client: ctx?.callerClient ?? "unknown",
      params_hash: await paramsHash(event.args),
      success: event.success,
      latency_ms: Math.round(event.latencyMs),
      owner_id: ctx?.auth.userId ?? null,
    });
  } catch {
    // Telemetry must never break the tool call it observes.
  }
}
