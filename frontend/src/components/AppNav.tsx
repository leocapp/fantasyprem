import { cookies } from "next/headers";
import { Suspense } from "react";

import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

import NavBar from "./NavBar";

type MembershipRow = {
  leagues: { id: string; name: string; status: string; commissioner_id: string } | null;
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
    .select("leagues (id, name, status, commissioner_id)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  // Co-commissioners live in their own table, so owning the league is only one
  // of the two ways to be a commissioner.
  const { data: grants } = await supabase
    .from("league_commissioners")
    .select("league_id")
    .eq("profile_id", user.id)
    .returns<{ league_id: string }[]>();

  const coCommissionerOf = new Set((grants ?? []).map((row) => row.league_id));

  const leagues = (memberships ?? [])
    .map((row) => row.leagues)
    .filter((row): row is NonNullable<MembershipRow["leagues"]> => Boolean(row))
    .map((league) => ({
      ...league,
      isCommissioner: league.commissioner_id === user.id || coCommissionerOf.has(league.id),
    }));

  // Set by middleware whenever a league page is viewed.
  const lastLeague = (await cookies()).get("fp_last_league")?.value ?? null;

  // NavBar reads search params, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <NavBar email={user.email ?? ""} leagues={leagues} lastLeagueId={lastLeague} />
    </Suspense>
  );
}
