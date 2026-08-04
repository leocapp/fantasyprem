import { createBrowserClient } from "@supabase/ssr";

import { requireSupabaseEnv } from "./env";

/** Supabase client for Client Components. */
export function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
