import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { createLeague, joinLeague } from "./actions";

type LeagueSummary = {
  id: string;
  name: string;
  join_code: string;
  status: string;
  max_teams: number;
};

type MembershipRow = {
  id: string;
  name: string;
  leagues: LeagueSummary | null;
};

export const dynamic = "force-dynamic";

export default async function LeaguesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // RLS restricts this to the current user's own teams.
  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("id, name, leagues (id, name, join_code, status, max_teams)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  return (
    <main className="page page-narrow">
      <h1 className="page-title">Your leagues</h1>

      {error ? <p className="notice notice-error">{error}</p> : null}

      {memberships && memberships.length > 0 ? (
        <ul className="list">
          {memberships.map((membership) => (
            <li key={membership.id}>
              <Link href={`/leagues/${membership.leagues?.id}`} className="row-link">
                <span className="flex-1">
                  <span className="font-medium">{membership.leagues?.name}</span>
                  <span className="ml-2 text-sm dim">as {membership.name}</span>
                </span>
                <span className="text-xs uppercase dim">{membership.leagues?.status}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          You&apos;re not in a league yet. Create one, or join with a friend&apos;s code.
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <section className="card">
          <h2 className="font-semibold">Create a league</h2>
          {/* suppressHydrationWarning: browser autofill mutates these fields
              before React hydrates. */}
          <form action={createLeague} className="mt-4 flex flex-col gap-3" suppressHydrationWarning>
            <input
              name="league_name"
              required
              minLength={3}
              placeholder="League name"
              className="input"
              suppressHydrationWarning
            />
            <input
              name="team_name"
              required
              minLength={2}
              placeholder="Your team name"
              className="input"
              suppressHydrationWarning
            />
            <label className="flex items-center justify-between gap-2 text-sm muted">
              Teams
              <input
                name="max_teams"
                type="number"
                min={2}
                max={20}
                defaultValue={10}
                className="input w-20"
                suppressHydrationWarning
              />
            </label>
            <button className="btn btn-primary">Create</button>
          </form>
        </section>

        <section className="card">
          <h2 className="font-semibold">Join a league</h2>
          <form action={joinLeague} className="mt-4 flex flex-col gap-3" suppressHydrationWarning>
            <input
              name="join_code"
              required
              placeholder="Join code"
              className="input numeric uppercase"
              suppressHydrationWarning
            />
            <input
              name="team_name"
              required
              minLength={2}
              placeholder="Your team name"
              className="input"
              suppressHydrationWarning
            />
            <button className="btn btn-ghost">Join</button>
          </form>
        </section>
      </div>
    </main>
  );
}
