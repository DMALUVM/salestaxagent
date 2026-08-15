import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _serverClient: SupabaseClient | null = null;

/**
 * Server-side Supabase client for API routes.
 * Uses the service role key if available, falls back to anon key.
 */
export function getServerSupabase(): SupabaseClient {
  if (!_serverClient) {
    const url =
      process.env.SUPABASE_URL ??
      process.env.NEXT_PUBLIC_SUPABASE_URL ??
      "";
    const key =
      process.env.SUPABASE_SERVICE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      "";

    if (!url || !key) {
      throw new Error("Supabase not configured for server");
    }
    _serverClient = createClient(url, key);
  }
  return _serverClient;
}
