import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async () => {
  const { data, error } = await supabase.rpc("capture_coverage_snapshot", {
    p_target_days: 7,
    p_source_kind: "health",
    p_producer: "scheduler",
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ ok: true, snapshots_inserted: data ?? 0 }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});