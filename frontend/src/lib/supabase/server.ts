import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

import { requireSupabaseEnv } from "./env";

/** Annotated explicitly: the client's overloads don't give TypeScript enough
 *  to infer this callback's parameter. */
type CookiesToSet = { name: string; value: string; options?: CookieOptions }[];

/** Supabase client for Server Components, Route Handlers and Server Actions. */
export async function createClient() {
  const { url, anonKey } = requireSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component — cookies are read-only here.
          // Session refresh is handled by middleware instead.
        }
      },
    },
  });
}
