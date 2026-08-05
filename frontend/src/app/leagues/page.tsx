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

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500";

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
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8 pt-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Your leagues</h1>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300">
          Dashboard
        </Link>
      </div>

      {error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {memberships && memberships.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {memberships.map((membership) => (
            <li key={membership.id}>
              <Link
                href={`/leagues/${membership.leagues?.id}`}
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900/50 px-4 py-3 hover:border-slate-500"
              >
                <span>
                  <span className="font-medium">{membership.leagues?.name}</span>
                  <span className="ml-2 text-sm text-slate-500">as {membership.name}</span>
                </span>
                <span className="font-mono text-xs uppercase text-slate-500">
                  {membership.leagues?.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-slate-400">
          You&apos;re not in a league yet. Create one, or join with a friend&apos;s code.
        </p>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
          <h2 className="font-semibold">Create a league</h2>
          <form action={createLeague} className="mt-4 flex flex-col gap-3 text-sm">
            <input name="league_name" required minLength={3} placeholder="League name" className={inputClass} />
            <input name="team_name" required minLength={2} placeholder="Your team name" className={inputClass} />
            <label className="flex items-center justify-between gap-2 text-slate-400">
              Teams
              <input
                name="max_teams"
                type="number"
                min={2}
                max={20}
                defaultValue={10}
                className={`${inputClass} w-20`}
              />
            </label>
            <button className="rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500">
              Create
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
          <h2 className="font-semibold">Join a league</h2>
          <form action={joinLeague} className="mt-4 flex flex-col gap-3 text-sm">
            <input
              name="join_code"
              required
              placeholder="Join code"
              className={`${inputClass} font-mono uppercase`}
            />
            <input name="team_name" required minLength={2} placeholder="Your team name" className={inputClass} />
            <button className="rounded-md border border-slate-600 px-4 py-2 font-medium text-slate-200 hover:border-slate-400">
              Join
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
