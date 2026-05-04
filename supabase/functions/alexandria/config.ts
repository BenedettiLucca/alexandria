import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = Deno.env.get("LOCAL_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("LOCAL_SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
export const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const EMBEDDING_MODEL = Deno.env.get("EMBEDDING_MODEL") || "openai/text-embedding-3-small";
export const CLASSIFICATION_MODEL = Deno.env.get("CLASSIFICATION_MODEL") || "openai/gpt-4o-mini";
export const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").filter(Boolean);

export function getCorsHeaders(origin: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id",
    "Access-Control-Max-Age": "86400",
  };
  if (ALLOWED_ORIGINS.length > 0 && origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  } else if (ALLOWED_ORIGINS.length === 0) {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  return headers;
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

export type AuthContext = {
  method: "jwt" | "key";
  userId: string;
  email?: string;
};

export function getUserClient(auth?: AuthContext) {
  if (auth?.method === "jwt") {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: { Authorization: `Bearer ${auth.userId}` },
      },
      auth: { persistSession: false },
    });
  }
  return supabase;
}
