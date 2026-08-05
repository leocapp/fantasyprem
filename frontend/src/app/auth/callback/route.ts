import { redirect } from "next/navigation";
import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * OAuth landing point. Providers send the user back here with a one-time code,
 * which is exchanged for a session cookie. The code verifier was stored as a
 * cookie when the flow started, which is why this must run on the server.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  // Providers report user-facing failures (e.g. consent declined) this way.
  const providerError = searchParams.get("error_description") ?? searchParams.get("error");
  if (providerError) {
    redirect(`/login?error=${encodeURIComponent(providerError)}`);
  }

  if (!code) {
    redirect("/login?error=Sign-in+was+cancelled.");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect(next);
}
