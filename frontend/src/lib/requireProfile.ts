import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

/**
 * Requires a signed-in user with a username, redirecting otherwise.
 *
 * Usernames appear next to team names throughout the app, so every page can
 * assume one exists rather than carrying a fallback for people who skipped it.
 */
export async function requireProfile(): Promise<{ userId: string; profile: Profile }> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_url")
    .eq("id", user.id)
    .maybeSingle<Profile>();

  if (!profile?.username) {
    redirect("/account?message=Pick+a+username+to+continue.");
  }

  return { userId: user.id, profile };
}
