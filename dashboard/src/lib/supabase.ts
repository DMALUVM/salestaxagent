import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase not configured");
    }
    _client = createClient(supabaseUrl, supabaseKey);
  }
  return _client;
}

export function isConfigured(): boolean {
  return supabaseUrl.length > 0 && supabaseKey.length > 0;
}
