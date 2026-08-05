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

type StandingRow = {
  team_id: string;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
  points_against: number;
};

type MatchupRow = {
  id: string;
  home_team_id: string;
  away_team_id: string | null;
  home_points: number;
  away_points: number;
  status: string;
  gameweeks: { number: number } | null;
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

  const { data: standings } =
    league.status === "setup"
      ? { data: null }
      : await supabase
          .from("league_standings")
          .select("team_id, games_played, wins, losses, draws, points_for, points_against")
          .eq("league_id", id)
          .returns<StandingRow[]>();

  const teamName = new Map((teams ?? []).map((team) => [team.id, team.name]));

  const table = (standings ?? []).slice().sort(
    (a, b) =>
      b.wins - a.wins || b.points_for - a.points_for || a.losses - b.losses,
  );

  const { data: allMatchups } =
    league.status === "setup"
      ? { data: null }
      : await supabase
          .from("matchups")
          .select(
            "id, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
          )
          .eq("league_id", id)
          .returns<MatchupRow[]>();

  const myTeamId = teams?.find((team) => team.owner_id === user.id)?.id;

  // Show a window around the action: the last two played plus the next three.
  const ordered = (allMatchups ?? [])
    .slice()
    .sort((a, b) => (a.gameweeks?.number ?? 0) - (b.gameweeks?.number ?? 0));
  const firstUpcoming = ordered.findIndex((matchup) => matchup.status === "scheduled");
  const windowStart = Math.max(0, (firstUpcoming === -1 ? ordered.length : firstUpcoming) - 2);
  const fixtures = ordered.slice(windowStart, windowStart + 5);

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
        <div className="flex gap-3">
          <Link
            href={`/leagues/${league.id}/draft`}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-2 text-center font-medium text-white hover:bg-emerald-500"
          >
            {league.status === "drafting" ? "Enter draft room" : "View draft results"}
          </Link>
          <Link
            href={`/leagues/${league.id}/team`}
            className="flex-1 rounded-md border border-slate-600 px-4 py-2 text-center font-medium text-slate-200 hover:border-slate-400"
          >
            Set lineup
          </Link>
          {league.status === "active" ? (
            <Link
              href={`/leagues/${league.id}/free-agents`}
              className="flex-1 rounded-md border border-slate-600 px-4 py-2 text-center font-medium text-slate-200 hover:border-slate-400"
            >
              Free agents
            </Link>
          ) : null}
        </div>
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

      {fixtures.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Fixtures</h2>
          <ul className="mt-3 flex flex-col gap-1">
            {fixtures.map((matchup) => {
              const mine =
                matchup.home_team_id === myTeamId || matchup.away_team_id === myTeamId;
              const played = matchup.status !== "scheduled";

              return (
                <li key={matchup.id}>
                  <Link
                    href={`/leagues/${league.id}/matchups/${matchup.id}`}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm hover:border-slate-500 ${
                      mine ? "border-slate-600 bg-slate-900/60" : "border-slate-800 bg-slate-900/20"
                    }`}
                  >
                    <span className="w-12 font-mono text-xs text-slate-600">
                      GW{matchup.gameweeks?.number}
                    </span>
                    <span className="flex-1 text-right">
                      {teamName.get(matchup.home_team_id) ?? "—"}
                    </span>
                    <span className="font-mono text-xs text-slate-400">
                      {played
                        ? `${matchup.home_points} – ${matchup.away_points}`
                        : matchup.away_team_id
                          ? "v"
                          : "bye"}
                    </span>
                    <span className="flex-1">
                      {matchup.away_team_id ? (teamName.get(matchup.away_team_id) ?? "—") : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {table.length > 0 ? (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Standings
          </h2>
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr className="border-b border-slate-800">
                <th className="py-2 text-left font-medium">Team</th>
                <th className="px-2 py-2 text-right font-medium">P</th>
                <th className="px-2 py-2 text-right font-medium">W</th>
                <th className="px-2 py-2 text-right font-medium">D</th>
                <th className="px-2 py-2 text-right font-medium">L</th>
                <th className="px-2 py-2 text-right font-medium">PF</th>
                <th className="px-2 py-2 text-right font-medium">PA</th>
              </tr>
            </thead>
            <tbody>
              {table.map((row) => (
                <tr key={row.team_id} className="border-b border-slate-900">
                  <td className="py-2 font-medium">{teamName.get(row.team_id) ?? "—"}</td>
                  <td className="px-2 py-2 text-right text-slate-400">{row.games_played}</td>
                  <td className="px-2 py-2 text-right">{row.wins}</td>
                  <td className="px-2 py-2 text-right text-slate-400">{row.draws}</td>
                  <td className="px-2 py-2 text-right text-slate-400">{row.losses}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs">{row.points_for}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-slate-500">
                    {row.points_against}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
