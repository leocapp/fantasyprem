import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import ManagerAvatar from "@/components/ManagerAvatar";
import PlayerAvatar from "@/components/PlayerAvatar";
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
  playoff_teams: number;
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
  gameweek_id: string;
  home_team_id: string;
  away_team_id: string | null;
  home_points: number;
  away_points: number;
  status: string;
  stage: string;
  gameweeks: { number: number } | null;
};

type RecapLineup = {
  fantasy_team_id: string;
  lineup_players: { player_id: string; role: string }[];
};

type RecapScore = {
  player_id: string;
  points: number;
  players: {
    display_name: string;
    position: string;
    photo_url: string | null;
    clubs: { short_name: string } | null;
  } | null;
};

type RecapStat = {
  minutes: number;
  goals: number;
  assists: number;
  clean_sheet: boolean;
  goals_conceded: number;
  saves: number;
  yellow_cards: number;
  red_cards: number;
};

/** "90' · 2G · 1A · CS" — what he actually did, not what it was worth. */
function statLine(stats: RecapStat[] | null | undefined): string {
  if (!stats || stats.length === 0) return "";

  const total = stats.reduce(
    (sum, row) => ({
      minutes: sum.minutes + row.minutes,
      goals: sum.goals + row.goals,
      assists: sum.assists + row.assists,
      clean_sheet: sum.clean_sheet || row.clean_sheet,
      goals_conceded: sum.goals_conceded + row.goals_conceded,
      saves: sum.saves + row.saves,
      yellow_cards: sum.yellow_cards + row.yellow_cards,
      red_cards: sum.red_cards + row.red_cards,
    }),
    {
      minutes: 0,
      goals: 0,
      assists: 0,
      clean_sheet: false,
      goals_conceded: 0,
      saves: 0,
      yellow_cards: 0,
      red_cards: 0,
    },
  );

  const parts = [`${total.minutes}'`];
  if (total.goals) parts.push(`${total.goals}G`);
  if (total.assists) parts.push(`${total.assists}A`);
  if (total.clean_sheet) parts.push("clean sheet");
  if (total.saves) parts.push(`${total.saves} saves`);
  if (total.goals_conceded) parts.push(`${total.goals_conceded} conceded`);
  if (total.yellow_cards) parts.push("yellow");
  if (total.red_cards) parts.push("red");

  return parts.join(" · ");
}

export const dynamic = "force-dynamic";

export default async function LeaguePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string; gw?: string }>;
}) {
  const { id } = await params;
  const { error, message, gw } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Returns nothing if the user has no team here — RLS, not an app-level check.
  const { data: league } = await supabase
    .from("leagues")
    .select(
      "id, name, join_code, status, max_teams, roster_size, playoff_teams, commissioner_id",
    )
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
              "id, gameweek_id, home_team_id, away_team_id, home_points, away_points, status, stage, gameweeks (number)",
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

  // The field's own record, from the other side of every bye.
  //
  // Deliberately computed here rather than added to league_standings. That view
  // is seeded into the playoff bracket and mailed out in the weekly recap, and a
  // synthetic row with no team behind it would end up holding a seed and
  // receiving an email. It belongs on the page, not in the data model.
  //
  // With an odd league there is exactly one bye a week, so the field plays as
  // many games as everyone else and the numbers line up column for column.
  const field = (allMatchups ?? []).reduce(
    (running, matchup) => {
      if (
        matchup.away_team_id !== null ||
        matchup.stage !== "regular" ||
        matchup.status !== "final"
      ) {
        return running;
      }

      const scored = Number(matchup.away_points);
      const conceded = Number(matchup.home_points);

      return {
        games: running.games + 1,
        wins: running.wins + (scored > conceded ? 1 : 0),
        losses: running.losses + (scored < conceded ? 1 : 0),
        draws: running.draws + (scored === conceded ? 1 : 0),
        points_for: running.points_for + scored,
        points_against: running.points_against + conceded,
      };
    },
    { games: 0, wins: 0, losses: 0, draws: 0, points_for: 0, points_against: 0 },
  );

  const ordered = (allMatchups ?? [])
    .slice()
    .sort((a, b) => (a.gameweeks?.number ?? 0) - (b.gameweeks?.number ?? 0));

  // "Current" gameweek: one in progress, else the next one due, else the last
  // one played once the season is over.
  const currentGameweek =
    ordered.find((matchup) => matchup.status === "live")?.gameweeks?.number ??
    ordered.find((matchup) => matchup.status === "scheduled")?.gameweeks?.number ??
    ordered.at(-1)?.gameweeks?.number;

  // Every gameweek that actually has matchups, in order. Derived from the
  // schedule rather than from the gameweeks table so the arrows can never walk
  // into a week this league doesn't play.
  const weeks = [
    ...new Set(
      ordered
        .map((matchup) => matchup.gameweeks?.number)
        .filter((number): number is number => typeof number === "number"),
    ),
  ].sort((a, b) => a - b);

  const asked = Number(gw);
  const viewing = weeks.includes(asked) ? asked : currentGameweek;

  const at = viewing !== undefined ? weeks.indexOf(viewing) : -1;
  const previousWeek = at > 0 ? weeks[at - 1] : null;
  const nextWeek = at >= 0 && at < weeks.length - 1 ? weeks[at + 1] : null;

  const fixtures = ordered.filter((matchup) => matchup.gameweeks?.number === viewing);

  // ------------------------------------------------------------- recap ----
  // The most recent gameweek where *every* matchup is final. A deferred fixture
  // leaves a week provisional for days, and recapping a result that later
  // changes would be worse than saying nothing.
  const settledWeeks = weeks.filter((week) => {
    const inWeek = ordered.filter((matchup) => matchup.gameweeks?.number === week);
    return inWeek.length > 0 && inWeek.every((matchup) => matchup.status === "final");
  });

  const recapWeek = settledWeeks.at(-1) ?? null;
  const recapId =
    recapWeek === null
      ? null
      : (ordered.find((matchup) => matchup.gameweeks?.number === recapWeek)?.gameweek_id ?? null);

  // Team of the week, straight out of the matchups already in hand. Only real
  // sides count — a bye's away_points is the league average, not a team.
  let bestTeam: { teamId: string; points: number } | null = null;

  if (recapWeek !== null) {
    for (const matchup of ordered) {
      if (matchup.gameweeks?.number !== recapWeek) continue;

      const sides: { teamId: string; points: number }[] = [
        { teamId: matchup.home_team_id, points: Number(matchup.home_points) },
      ];
      if (matchup.away_team_id) {
        sides.push({ teamId: matchup.away_team_id, points: Number(matchup.away_points) });
      }

      for (const side of sides) {
        if (!bestTeam || side.points > bestTeam.points) bestTeam = side;
      }
    }
  }

  // Player of the week, among those actually started. A free agent who scored
  // twenty is a different story and not this one — this is about the league.
  const { data: recapLineups } = recapId
    ? await supabase
        .from("lineups")
        .select("fantasy_team_id, lineup_players (player_id, role)")
        .eq("gameweek_id", recapId)
        .in("fantasy_team_id", (teams ?? []).map((team) => team.id))
        .returns<RecapLineup[]>()
    : { data: null };

  const startedBy = new Map<string, string>();
  for (const lineup of recapLineups ?? []) {
    for (const row of lineup.lineup_players) {
      if (row.role === "starter") startedBy.set(row.player_id, lineup.fantasy_team_id);
    }
  }

  const { data: topScores } = startedBy.size
    ? await supabase
        .from("player_gameweek_scores")
        .select(
          "player_id, points, players (display_name, position, photo_url, clubs (short_name))",
        )
        .eq("league_id", id)
        .eq("gameweek_id", recapId!)
        .in("player_id", [...startedBy.keys()])
        .order("points", { ascending: false })
        .limit(1)
        .returns<RecapScore[]>()
    : { data: null };

  const bestPlayer = topScores?.[0] ?? null;

  const { data: bestPlayerStats } = bestPlayer
    ? await supabase
        .from("player_match_stats")
        .select(
          "minutes, goals, assists, clean_sheet, goals_conceded, saves, yellow_cards, red_cards, fixtures!inner(gameweek_id)",
        )
        .eq("player_id", bestPlayer.player_id)
        .eq("fixtures.gameweek_id", recapId!)
        .returns<RecapStat[]>()
    : { data: null };

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
          <div className="flex items-center justify-between gap-2">
            <h2 className="section-label">Gameweek {viewing}</h2>

            {/* replace and scroll={false}, for the reason the team page tabs
                learned the hard way: stepping through weeks is browsing, not
                travelling, and the back button should return you to wherever
                you came from rather than replaying every week you looked at. */}
            <span className="flex items-center gap-1">
              {previousWeek !== null ? (
                <Link
                  href={`/leagues/${league.id}?gw=${previousWeek}`}
                  replace
                  scroll={false}
                  className="btn btn-ghost btn-sm"
                  aria-label={`Gameweek ${previousWeek}`}
                >
                  ‹
                </Link>
              ) : (
                <span className="btn btn-ghost btn-sm opacity-30" aria-hidden>
                  ‹
                </span>
              )}

              {nextWeek !== null ? (
                <Link
                  href={`/leagues/${league.id}?gw=${nextWeek}`}
                  replace
                  scroll={false}
                  className="btn btn-ghost btn-sm"
                  aria-label={`Gameweek ${nextWeek}`}
                >
                  ›
                </Link>
              ) : (
                <span className="btn btn-ghost btn-sm opacity-30" aria-hidden>
                  ›
                </span>
              )}

              {/* Only when you've wandered off. Thirty-eight weeks is a long way
                  back by April. */}
              {viewing !== currentGameweek ? (
                <Link
                  href={`/leagues/${league.id}`}
                  replace
                  scroll={false}
                  className="btn btn-ghost btn-sm"
                >
                  Now
                </Link>
              ) : null}
            </span>
          </div>
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
                      {played ? `${matchup.home_points} – ${matchup.away_points}` : "v"}
                    </span>
                    <span className="flex-1">
                      {matchup.away_team_id ? (
                        <TeamLabel
                          name={teamName.get(matchup.away_team_id)}
                          username={managerOf.get(matchup.away_team_id)}
                          avatarUrl={avatarOf.get(matchup.away_team_id)}
                        />
                      ) : matchup.stage === "playoff" ? (
                        // In the bracket a null opponent is nobody, not the
                        // average — this seed was rested and is already through.
                        <span className="text-sm dim">Bye</span>
                      ) : (
                        // Everywhere else a bye has a real opponent: the average
                        // of everyone else. It gets a score like any other
                        // fixture, so it shouldn't read as an empty week.
                        <span className="text-sm dim">The field</span>
                      )}
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
          <div className="flex items-center justify-between gap-2">
            <h2 className="section-label">Standings</h2>
            {/* The table decides the league title on its own. The link is what
                tells you it also decides who gets in. */}
            {league.playoff_teams > 0 ? (
              <Link
                href={`/leagues/${league.id}/playoffs`}
                className="btn btn-ghost btn-sm"
              >
                Playoff picture
              </Link>
            ) : null}
          </div>
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

              {/* Below a heavy rule, permanently last: the field isn't in the
                  running for anything, it's the yardstick. Beating it is the
                  same as being above average that week. */}
              {field.games > 0 ? (
                <tr className="border-t-2 border-[var(--border-strong)]">
                  <td className="py-2">
                    <span className="text-sm dim">The field</span>
                    <span className="block text-[10px] dim">every bye week</span>
                  </td>
                  <td className="numeric px-2 py-2 text-right muted">{field.games}</td>
                  <td className="numeric px-2 py-2 text-right dim">{field.wins}</td>
                  <td className="numeric px-2 py-2 text-right muted">{field.draws}</td>
                  <td className="numeric px-2 py-2 text-right muted">{field.losses}</td>
                  <td className="numeric px-2 py-2 text-right text-xs dim">
                    {field.points_for.toFixed(1)}
                  </td>
                  <td className="numeric px-2 py-2 text-right text-xs dim">
                    {field.points_against.toFixed(1)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {field.games > 0 ? (
            <p className="mt-2 text-xs dim">
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Only for a week where every fixture is final. A deferred match leaves a
          gameweek provisional for days, and crowning a team of the week whose
          score later changes is worse than saying nothing. */}
      {recapWeek !== null && (bestTeam || bestPlayer) ? (
        <section className="card">
          <h2 className="section-label">Gameweek {recapWeek} recap</h2>

          <div className="mt-3 flex flex-col gap-4 sm:flex-row">
            {bestTeam ? (
              <div className="flex flex-1 items-start gap-3">
                <ManagerAvatar
                  src={avatarOf.get(bestTeam.teamId)}
                  username={managerOf.get(bestTeam.teamId)}
                  size="lg"
                />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide dim">Team of the week</p>
                  <p className="mt-1">
                    <Link
                      href={`/leagues/${league.id}/teams/${bestTeam.teamId}`}
                      className="font-semibold hover:underline"
                    >
                      {teamName.get(bestTeam.teamId) ?? "—"}
                    </Link>
                  </p>
                  <p className="numeric text-2xl" style={{ color: "var(--accent-hover)" }}>
                    {bestTeam.points}
                  </p>
                  {managerOf.get(bestTeam.teamId) ? (
                    <p className="text-xs dim">@{managerOf.get(bestTeam.teamId)}</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {bestPlayer ? (
              <div className="flex flex-1 items-start gap-3">
                <PlayerAvatar
                  src={bestPlayer.players?.photo_url ?? null}
                  name={bestPlayer.players?.display_name ?? "?"}
                  size="lg"
                />
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wide dim">Player of the week</p>
                  <p className="mt-1">
                    <Link
                      href={`/leagues/${league.id}/players/${bestPlayer.player_id}?gw=${recapWeek}`}
                      className="font-semibold hover:underline"
                    >
                      {bestPlayer.players?.display_name ?? "—"}
                    </Link>
                    <span className="text-xs dim">
                      {" "}
                      {bestPlayer.players?.position} ·{" "}
                      {bestPlayer.players?.clubs?.short_name ?? "—"}
                    </span>
                  </p>
                  <p className="numeric text-2xl" style={{ color: "var(--accent-hover)" }}>
                    {bestPlayer.points}
                  </p>
                  <p className="text-xs dim">{statLine(bestPlayerStats)}</p>
                  {startedBy.get(bestPlayer.player_id) ? (
                    <p className="mt-1 text-xs dim">
                      started by{" "}
                      {teamName.get(startedBy.get(bestPlayer.player_id)!) ?? "someone"}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
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
