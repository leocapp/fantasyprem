import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseEnv } from "./env";

/** Annotated explicitly: the client's overloads don't give TypeScript enough
 *  to infer this callback's parameter. */
type CookiesToSet = { name: string; value: string; options?: CookieOptions }[];

/**
 * How long to wait for Supabase Auth before giving up and letting the request
 * through unrefreshed. A token refresh that takes longer than this is a service
 * in trouble, not a slow network.
 */
const AUTH_TIMEOUT_MS = 2000;

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
  //
  // Raced against a timer rather than plainly awaited. This call had nothing to
  // stop it hanging, so when Supabase Auth went unhealthy the middleware ran
  // until Vercel killed it and the whole site returned 504
  // MIDDLEWARE_INVOCATION_TIMEOUT — every route, including the ones that never
  // needed a session.
  //
  // Failing open is safe: all this does is refresh the session, and every page
  // performs its own getUser() and redirects to /login. The worst outcome of
  // losing the race is somebody landing on the login screen, which beats the
  // site being unreachable.
  await Promise.race([
    supabase.auth.getUser().catch(() => null),
    new Promise((resolve) => setTimeout(resolve, AUTH_TIMEOUT_MS)),
  ]);

  return response;
}
