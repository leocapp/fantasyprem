import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { setDraftOrder, startDraft } from "./actions";

type LeagueDetail = {
  id: string;
  name: string;
  join_code: string;
  status: string;
  max_teams: number;
  roster_size: number;
  commissioner_id: string;
};

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  draft_position: number | null;
  created_at: string;
  profiles: { display_name: string | null; username: string | null } | null;
};

export const dynamic = "force-dynamic";

export default async function LeaguePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { id } = await params;
  const { error, message } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Returns nothing if the user has no team here — RLS, not an app-level check.
  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, join_code, status, max_teams, roster_size, commissioner_id")
    .eq("id", id)
    .maybeSingle<LeagueDetail>();

  if (!league) notFound();

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, draft_position, created_at, profiles (display_name, username)")
    .eq("league_id", id)
    .order("draft_position", { nullsFirst: false })
    .order("created_at")
    .returns<TeamRow[]>();

  const isCommissioner = league.commissioner_id === user.id;
  const slotsLeft = league.max_teams - (teams?.length ?? 0);
  const inSetup = league.status === "setup";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8 pt-16">
      <div>
        <Link href="/leagues" className="text-sm text-slate-500 hover:text-slate-300">
          ← All leagues
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{league.name}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {league.status} · {teams?.length ?? 0} of {league.max_teams} teams · {league.roster_size}{" "}
          players per roster
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {message}
        </p>
      ) : null}

      {league.status !== "setup" ? (
        <Link
          href={`/leagues/${league.id}/draft`}
          className="rounded-md bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-500"
        >
          {league.status === "drafting" ? "Enter draft room" : "View draft results"}
        </Link>
      ) : null}

      {inSetup ? (
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Join code</h2>
          <p className="mt-2 font-mono text-2xl tracking-widest">{league.join_code}</p>
          <p className="mt-2 text-sm text-slate-500">
            {slotsLeft > 0
              ? `Share this with friends — ${slotsLeft} ${slotsLeft === 1 ? "slot" : "slots"} left.`
              : "This league is full."}
          </p>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Teams</h2>
        <ul className="mt-3 flex flex-col gap-2">
          {teams?.map((team, index) => (
            <li
              key={team.id}
              className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
            >
              <span className="w-6 font-mono text-xs text-slate-600">
                {team.draft_position ?? index + 1}
              </span>
              <span className="flex-1 font-medium">{team.name}</span>
              <span className="text-sm text-slate-500">
                {team.profiles?.display_name ?? team.profiles?.username ?? "Manager"}
                {team.owner_id === league.commissioner_id ? " · commissioner" : ""}
                {team.owner_id === user.id ? " · you" : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isCommissioner && inSetup ? (
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-5">
          <h2 className="font-semibold">Start the draft</h2>
          <p className="mt-1 text-sm text-slate-400">
            Leave the order alone and it will be randomised, or set each team&apos;s slot below.
          </p>

          <form action={setDraftOrder} className="mt-4 flex flex-col gap-2 text-sm">
            <input type="hidden" name="league_id" value={league.id} />
            {teams?.map((team, index) => (
              <label key={team.id} className="flex items-center gap-3">
                <span className="w-6 font-mono text-xs text-slate-600">{index + 1}</span>
                <select
                  name="team_id"
                  defaultValue={team.id}
                  suppressHydrationWarning
                  className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-slate-500"
                >
                  {teams.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button className="mt-1 rounded-md border border-slate-600 px-4 py-2 font-medium text-slate-200 hover:border-slate-400">
              Save order
            </button>
          </form>

          <form action={startDraft} className="mt-4">
            <input type="hidden" name="league_id" value={league.id} />
            <button className="w-full rounded-md bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500">
              Start draft
            </button>
          </form>
        </section>
      ) : null}

      {!isCommissioner && inSetup ? (
        <p className="text-sm text-slate-500">Waiting on the commissioner to start the draft.</p>
      ) : null}
    </main>
  );
}
