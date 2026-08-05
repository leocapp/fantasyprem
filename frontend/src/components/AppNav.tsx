import { Suspense } from "react";

import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

import NavBar from "./NavBar";

type MembershipRow = {
  leagues: { id: string; name: string; status: string } | null;
};

/**
 * Server half of the navigation: works out who is signed in and which leagues
 * they belong to, then hands off to the client component for active states
 * and the mobile menu. Renders nothing for signed-out visitors.
 */
export default async function AppNav() {
  if (!getSupabaseEnv()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("leagues (id, name, status)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  const leagues = (memberships ?? [])
    .map((row) => row.leagues)
    .filter((row): row is NonNullable<MembershipRow["leagues"]> => Boolean(row));

  // NavBar reads search params, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <NavBar email={user.email ?? ""} leagues={leagues} />
    </Suspense>
  );
}
