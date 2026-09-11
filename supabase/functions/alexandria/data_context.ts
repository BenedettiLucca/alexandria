import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./config.ts";
import { getContext } from "./context.ts";
import type { Database } from "./types.ts";

export type DataContext = {
  client: SupabaseClient<Database>;
  userId: string;
  method: "jwt" | "key";
};

function requireRequestContext() {
  const context = getContext();
  if (!context) throw new Error("Request context is required");
  return context;
}

export function getDataContext(): DataContext {
  const context = requireRequestContext();
  if (context.auth.method === "jwt") {
    return {
      client: createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${context.auth.token}` } },
      }),
      userId: context.auth.userId,
      method: context.auth.method,
    };
  }
  return {
    client: createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY),
    userId: context.auth.userId,
    method: context.auth.method,
  };
}

export function getDataClient(): SupabaseClient<Database> {
  return getDataContext().client;
}
