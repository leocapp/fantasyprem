import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import TeamLabel from "@/components/TeamLabel";
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
  profiles: {
    display_name: string | null;
    username: string | null;
    avatar_url: string | null;
  } | null;
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

  // Independent queries, so they go out together. Run sequentially these were
  // four round trips to the database; now they're one.
  const [{ data: teams }, { data: standings }, { data: allMatchups }, { data: grant }] =
    await Promise.all([
      supabase
        .from("fantasy_teams")
        .select(
          "id, name, owner_id, draft_position, created_at, profiles (display_name, username, avatar_url)",
        )
        .eq("league_id", id)
        .order("draft_position", { nullsFirst: false })
        .order("created_at")
        .returns<TeamRow[]>(),

      league.status === "setup"
        ? Promise.resolve({ data: null })
        : supabase
            .from("league_standings")
            .select("team_id, games_played, wins, losses, draws, points_for, points_against")
            .eq("league_id", id)
            .returns<StandingRow[]>(),

      league.status === "setup"
        ? Promise.resolve({ data: null })
        : supabase
            .from("matchups")
            .select(
              "id, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
            )
            .eq("league_id", id)
            .returns<MatchupRow[]>(),

      supabase
        .from("league_commissioners")
        .select("profile_id")
        .eq("league_id", id)
        .eq("profile_id", user.id)
        .maybeSingle(),
    ]);

  const teamName = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const managerOf = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.username ?? null]),
  );
  const avatarOf = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.avatar_url ?? null]),
  );
  const myTeamId = teams?.find((team) => team.owner_id === user.id)?.id;

  const table = (standings ?? [])
    .slice()
    .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for || a.losses - b.losses);

  const ordered = (allMatchups ?? [])
    .slice()
    .sort((a, b) => (a.gameweeks?.number ?? 0) - (b.gameweeks?.number ?? 0));

  // "Current" gameweek: one in progress, else the next one due, else the last
  // one played once the season is over.
  const currentGameweek =
    ordered.find((matchup) => matchup.status === "live")?.gameweeks?.number ??
    ordered.find((matchup) => matchup.status === "scheduled")?.gameweeks?.number ??
    ordered.at(-1)?.gameweeks?.number;

  const fixtures = ordered.filter(
    (matchup) => matchup.gameweeks?.number === currentGameweek,
  );

  // Co-commissioners have every commissioner power here, so the check can't
  // just compare against the league's owner.
  const isCommissioner = league.commissioner_id === user.id || Boolean(grant);
  const slotsLeft = league.max_teams - (teams?.length ?? 0);
  const inSetup = league.status === "setup";

  return (
    <main className="page">
      <div>
        <h1 className="page-title">{league.name}</h1>
        <p className="page-subtitle">
          {league.status} · {teams?.length ?? 0} of {league.max_teams} teams · {league.roster_size}{" "}
          players per roster
        </p>
      </div>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      {league.status === "drafting" ? (
        <Link href={`/leagues/${league.id}/draft`} className="btn btn-primary">
          Enter draft room
        </Link>
      ) : null}

      {inSetup ? (
        <section className="card">
          <h2 className="section-label">Join code</h2>
          <p className="numeric mt-2 text-2xl tracking-[0.3em]">{league.join_code}</p>
          <p className="mt-2 text-sm dim">
            {slotsLeft > 0
              ? `Share this with friends — ${slotsLeft} ${slotsLeft === 1 ? "slot" : "slots"} left.`
              : "This league is full."}
          </p>
        </section>
      ) : null}

      {fixtures.length > 0 ? (
        <section>
          <h2 className="section-label">Gameweek {currentGameweek}</h2>
          <ul className="mt-3 flex flex-col gap-1.5">
            {fixtures.map((matchup) => {
              const mine = matchup.home_team_id === myTeamId || matchup.away_team_id === myTeamId;
              const played = matchup.status !== "scheduled";

              return (
                <li key={matchup.id}>
                  <Link
                    href={`/leagues/${league.id}/matchups/${matchup.id}`}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm transition-colors hover:border-[var(--border-strong)] ${
                      mine
                        ? "border-[var(--border-strong)] bg-[var(--surface)]"
                        : "border-[var(--border)]"
                    }`}
                  >
                    <TeamLabel
                      name={teamName.get(matchup.home_team_id)}
                      username={managerOf.get(matchup.home_team_id)}
                      avatarUrl={avatarOf.get(matchup.home_team_id)}
                      align="right"
                      className="flex-1"
                    />
                    <span className="numeric text-xs muted">
                      {played
                        ? `${matchup.home_points} – ${matchup.away_points}`
                        : matchup.away_team_id
                          ? "v"
                          : "bye"}
                    </span>
                    <span className="flex-1">
                      {matchup.away_team_id ? (
                        <TeamLabel
                          name={teamName.get(matchup.away_team_id)}
                          username={managerOf.get(matchup.away_team_id)}
                          avatarUrl={avatarOf.get(matchup.away_team_id)}
                        />
                      ) : null}
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
          <h2 className="section-label">Standings</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide dim">
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
                <tr
                  key={row.team_id}
                  className={`border-b border-[var(--border)] ${
                    row.team_id === myTeamId ? "bg-[var(--surface)]" : ""
                  }`}
                >
                  <td className="py-2 font-medium">
                    <Link
                      href={`/leagues/${league.id}/teams/${row.team_id}`}
                      className="hover:underline"
                    >
                      <TeamLabel
                        name={teamName.get(row.team_id)}
                        username={managerOf.get(row.team_id)}
                        avatarUrl={avatarOf.get(row.team_id)}
                      />
                    </Link>
                  </td>
                  <td className="numeric px-2 py-2 text-right muted">{row.games_played}</td>
                  <td className="numeric px-2 py-2 text-right">{row.wins}</td>
                  <td className="numeric px-2 py-2 text-right muted">{row.draws}</td>
                  <td className="numeric px-2 py-2 text-right muted">{row.losses}</td>
                  <td className="numeric px-2 py-2 text-right text-xs">{row.points_for}</td>
                  <td className="numeric px-2 py-2 text-right text-xs dim">
                    {row.points_against}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section>
        <h2 className="section-label">Teams</h2>
        <ul className="list mt-3">
          {teams?.map((team, index) => (
            <li key={team.id}>
              <Link href={`/leagues/${league.id}/teams/${team.id}`} className="row-link">
                <span className="numeric w-6 text-xs dim">{team.draft_position ?? index + 1}</span>
                <TeamLabel
                  name={team.name}
                  username={team.profiles?.username}
                  avatarUrl={team.profiles?.avatar_url}
                  className="flex-1 font-medium"
                />
                <span className="truncate text-sm dim">
                  {team.profiles?.display_name ?? ""}
                  {team.owner_id === league.commissioner_id ? " · commissioner" : ""}
                  {team.owner_id === user.id ? " · you" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {isCommissioner && inSetup ? (
        <section className="card">
          <h2 className="font-semibold">Start the draft</h2>
          <p className="mt-1 text-sm muted">
            Leave the order alone and it will be randomised, or set each team&apos;s slot below.
          </p>

          <form action={setDraftOrder} className="mt-4 flex flex-col gap-2 text-sm">
            <input type="hidden" name="league_id" value={league.id} />
            {teams?.map((team, index) => (
              <label key={team.id} className="flex items-center gap-3">
                <span className="numeric w-6 text-xs dim">{index + 1}</span>
                <select
                  name="team_id"
                  defaultValue={team.id}
                  suppressHydrationWarning
                  className="select flex-1"
                >
                  {teams.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <button className="btn btn-ghost mt-1">Save order</button>
          </form>

          <form action={startDraft} className="mt-4">
            <input type="hidden" name="league_id" value={league.id} />
            <button className="btn btn-primary w-full">Start draft</button>
          </form>
        </section>
      ) : null}

      {!isCommissioner && inSetup ? (
        <p className="text-sm dim">Waiting on the commissioner to start the draft.</p>
      ) : null}
    </main>
  );
}
