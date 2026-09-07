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
  //
  // Plainly awaited, and it must stay that way. This was briefly raced against a
  // two-second timer to stop a Supabase Auth outage taking the whole site down
  // with a 504. The reasoning was that failing open is safe because every page
  // does its own getUser() and would redirect to /login — and that was wrong.
  //
  // This call is not a check, it is the refresh. Skip it and the browser keeps
  // an access token that quietly expires; the user still looks signed in, but
  // every RLS-protected read returns an empty list instead of an error. The nav
  // renders as though they belong to no leagues, their team vanishes, and
  // nothing anywhere says why.
  //
  // A loud 504 during a rare platform incident is a better failure than a silent
  // one that makes a working account look empty.
  await supabase.auth.getUser();

  return response;
}
