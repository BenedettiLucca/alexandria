import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SCHEDULER_SECRET = Deno.env.get("COVERAGE_CAPTURE_SECRET") ?? "";
const OWNER_USER_ID = Deno.env.get("ALEXANDRIA_OWNER_USER_ID") ?? "";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function equalSecret(provided: string): boolean {
  if (!SCHEDULER_SECRET || provided.length !== SCHEDULER_SECRET.length) return false;
  let result = 0;
  for (let i = 0; i < provided.length; i++) result |= provided.charCodeAt(i) ^ SCHEDULER_SECRET.charCodeAt(i);
  return result === 0;
}

Deno.serve(async (request) => {
  if (!equalSecret(request.headers.get("x-coverage-capture-secret") ?? "")) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!OWNER_USER_ID) {
    return new Response(JSON.stringify({ ok: false, error: "owner_not_configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const executionId = request.headers.get("x-coverage-execution-id") ?? crypto.randomUUID();
  const { data, error } = await supabase.rpc("capture_coverage_snapshot", {
    p_target_days: 7,
    p_source_kind: "health",
    p_producer: "scheduler",
    p_user_id: OWNER_USER_ID,
    p_execution_id: executionId,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, snapshots_inserted: data ?? 0, execution_id: executionId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
