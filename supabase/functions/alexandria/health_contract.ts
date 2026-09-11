export const CONTRACT_VERSION = "health.v1" as const;
export const ENTRY_TYPES = new Set([
  "steps", "weight", "heart_rate", "sleep", "exercise", "body_composition", "measurement_goal",
]);
const ALIASES: Record<string, string> = { heartRate: "heart_rate", "heart-rate": "heart_rate", hr: "heart_rate", bodyComp: "body_composition", "body-comp": "body_composition", goal: "measurement_goal", "measurement-goal": "measurement_goal" };
const FIELDS: Record<string, [string, string[]]> = {
  steps: ["count", ["steps"]], weight: ["weight_kg", ["weight"]], heart_rate: ["bpm", ["beats_per_minute", "heart_rate"]], sleep: ["duration_hours", ["duration_h"]], exercise: ["duration_s", ["duration_seconds"]],
};
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const timestamp = (value: unknown): string => {
  if (typeof value !== "string" || !value || !/[Zz]|[+-]\d\d:\d\d$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error("timestamp must be ISO-8601 with explicit offset");
  return value;
};
export function identity(record: Record<string, unknown>): string {
  const source = record.source as string | undefined;
  const stable = record.source_record_id || record.external_id;
  if (stable) return `${source || "unknown"}:${String(stable)}`;
  const start = record.start || record.timestamp;
  const end = record.end || record.timestamp;
  if (!source || !start || !end) throw new Error("identity requires source record id or provenance/source and start/end");
  return `fallback:${source}:${start}:${end}:${record.entry_type}`;
}
export function validateHealthEntry(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("health entry must be an object");
  const input = record as Record<string, unknown>;
  const entryType = ALIASES[String(input.entry_type)] || input.entry_type;
  if (typeof entryType !== "string" || !ENTRY_TYPES.has(entryType)) throw new Error("unsupported entry_type");
  const value = input.value;
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("value must be an object or null");
  if (input.numeric_value !== undefined && input.numeric_value !== null && !number(input.numeric_value)) throw new Error("numeric_value must be a number or null");
  if (input.duration_s !== undefined && input.duration_s !== null && (!number(input.duration_s) || input.duration_s < 0)) throw new Error("duration_s must be non-negative");
  if (input.source !== undefined && input.source !== null && !isStr(input.source)) throw new Error("source must be a string");
  return { entry_type: entryType, timestamp: timestamp(input.timestamp), value: value ?? null, numeric_value: input.numeric_value ?? null, duration_s: input.duration_s ?? null, source: input.source ?? null, external_id: input.external_id ?? null };
}
export function normalizeHealthEntry(record: Record<string, unknown>): Record<string, unknown> {
  const checked = validateHealthEntry(record);
  const value = { ...((checked.value as Record<string, unknown> | null) || {}) };
  const field = FIELDS[checked.entry_type as string];
  if (field && value[field[0]] === undefined) for (const alias of field[1]) if (value[alias] !== undefined) { value[field[0]] = value[alias]; break; }
  if (field && value[field[0]] !== undefined && !number(value[field[0]])) throw new Error(`${field[0]} must be a number`);
  if (checked.entry_type === "steps" && value.count !== undefined && (value.count as number) < 0) throw new Error("steps count must be non-negative");
  const result = { ...checked, value, identity: identity({ ...record, ...checked }), contract_version: CONTRACT_VERSION, raw_content: { untrusted: true, value: record } };
  return result;
}
export function projectHealthEntries(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const projected = new Map<string, Record<string, unknown>>();
  for (const record of records) { const item = normalizeHealthEntry(record); const key = item.identity as string; const prior = projected.get(key); if (prior) { if (JSON.stringify(prior) !== JSON.stringify(item)) throw new Error(`conflicting duplicate identity: ${key}`); } else projected.set(key, item); }
  return [...projected.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value);
}
