import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "./env";

/** Annotated explicitly: the client's overloads don't give TypeScript enough
 *  to infer this callback's parameter. */
type CookiesToSet = { name: string; value: string; options?: CookieOptions }[];

/**
 * Refreshes the Supabase auth session and forwards updated cookies.
 * No-ops when Supabase env vars are not set, so the skeleton runs unconfigured.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = getSupabaseEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // IMPORTANT: do not run logic between createServerClient and getUser().
  await supabase.auth.getUser();

  return response;
}
