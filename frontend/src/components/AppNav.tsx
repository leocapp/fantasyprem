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

  const { data: memberships, error: membershipError } = await supabase
    .from("fantasy_teams")
    .select("leagues (id, name, status, commissioner_id)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  // A failed query and an empty result are the same shape here, and that cost
  // real time: adding playoff_seeds accidentally gave leagues and fantasy_teams
  // a second relationship, PostgREST refused the ambiguous embed, and this
  // rendered as "you belong to no leagues" for every user in every league. No
  // error page, nothing in the console, nothing to search for.
  //
  // So say so. The nav still renders — being unable to list leagues shouldn't
  // take the whole site down — but it says it failed rather than implying an
  // answer it doesn't have.
  if (membershipError) {
    console.error("AppNav: could not load leagues —", membershipError.message);
  }

  // Co-commissioners live in their own table, so owning the league is only one
  // of the two ways to be a commissioner.
  const { data: grants, error: grantError } = await supabase
    .from("league_commissioners")
    .select("league_id")
    .eq("profile_id", user.id)
    .returns<{ league_id: string }[]>();

  if (grantError) {
    console.error("AppNav: could not load commissioner grants —", grantError.message);
  }

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
      <NavBar
        email={user.email ?? ""}
        leagues={leagues}
        lastLeagueId={lastLeague}
        failed={Boolean(membershipError)}
      />
    </Suspense>
  );
}
