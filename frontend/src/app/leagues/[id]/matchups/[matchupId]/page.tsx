import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { CSSProperties } from "react";

import BackLink from "@/components/BackLink";
import ManagerAvatar from "@/components/ManagerAvatar";
import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

type MatchupRow = {
  id: string;
  league_id: string;
  gameweek_id: string;
  home_team_id: string;
  away_team_id: string | null;
  home_points: number;
  away_points: number;
  status: string;
  gameweeks: { number: number } | null;
};

type TeamRow = {
  id: string;
  name: string;
  profiles: { username: string | null; avatar_url: string | null } | null;
};

type LineupPlayer = {
  player_id: string;
  role: string;
  is_captain: boolean;
  is_vice_captain: boolean;
  players: {
    display_name: string;
    position: string;
    photo_url: string | null;
    club_id: string | null;
    clubs: { short_name: string } | null;
  } | null;
};

type MatchFixture = {
  home_club_id: string;
  away_club_id: string;
  kickoff_at: string;
};

/**
 * Ninety minutes plus stoppage, half time and a margin. Mirrors
 * MATCH_SETTLED_AFTER in the ingestion, and for the same reason: past this
 * point a match without statistics is a data problem, not a match in progress,
 * and saying "playing" would be a lie the page tells indefinitely.
 */
const MATCH_WINDOW_MS = (2 * 60 + 45) * 60 * 1000;

/**
 * How a player's return reads at a glance: poor, ordinary, good — and the one
 * who carried the side.
 *
 * The MVP can't be told apart by colour: --warning is #fbbf24, which is already
 * gold, so a gold number beside a yellow number is just two yellow numbers. It
 * gets a filled pill and bold weight instead, so it reads as a badge rather
 * than a slightly different shade.
 */
function pointsStyle(value: number | null, mvp: boolean): CSSProperties | undefined {
  if (value === null) return undefined;

  if (mvp) {
    return {
      color: "#fde68a",
      background: "rgb(251 191 36 / 0.18)",
      borderRadius: "0.375rem",
      padding: "0.05rem 0.4rem",
      fontWeight: 700,
    };
  }

  if (value < 3) return { color: "var(--danger)" };
  if (value <= 8.5) return { color: "var(--warning)" };
  return { color: "var(--accent-hover)" };
}

/**
 * The MVP's row. A tint rather than a fill, and a bar down the left edge —
 * eleven names is a dense list, and a solid gold band would win the page away
 * from the scores themselves.
 */
const MVP_ROW: CSSProperties = {
  background: "rgb(251 191 36 / 0.09)",
  boxShadow: "inset 2px 0 0 #fbbf24",
  borderRadius: "0.375rem",
};

type LineupRow = {
  id: string;
  fantasy_team_id: string;
  formation: string;
  carried_forward: boolean;
  lineup_players: LineupPlayer[];
};

type ScoreRow = { player_id: string; points: number };

type StatRow = {
  player_id: string;
  minutes: number;
  goals: number;
  assists: number;
  clean_sheet: boolean;
  goals_conceded: number;
  saves: number;
  yellow_cards: number;
  red_cards: number;
};

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

/** Compact stat line, e.g. "90' · 1G · 1A · CS · 2B". */
function statSummary(stat: StatRow | undefined): string {
  if (!stat) return "did not play";
  if (stat.minutes === 0) return "did not play";

  const parts = [`${stat.minutes}'`];
  if (stat.goals) parts.push(`${stat.goals}G`);
  if (stat.assists) parts.push(`${stat.assists}A`);
  if (stat.clean_sheet) parts.push("CS");
  if (stat.saves) parts.push(`${stat.saves} saves`);
  if (stat.goals_conceded) parts.push(`${stat.goals_conceded} conceded`);
  if (stat.yellow_cards) parts.push("YC");
  if (stat.red_cards) parts.push("RC");

  return parts.join(" · ");
}

export const dynamic = "force-dynamic";

export default async function MatchupPage({
  params,
}: {
  params: Promise<{ id: string; matchupId: string }>;
}) {
  const { id, matchupId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: matchup } = await supabase
    .from("matchups")
    .select(
      "id, league_id, gameweek_id, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
    )
    .eq("id", matchupId)
    .maybeSingle<MatchupRow>();

  if (!matchup || matchup.league_id !== id) notFound();

  const isBye = matchup.away_team_id === null;

  const sideIds = [matchup.home_team_id, matchup.away_team_id].filter(
    (value): value is string => Boolean(value),
  );

  // Every team in the league, not only the ones named on this matchup: a bye is
  // played against the field, so its score and its projection are both averages
  // over everybody else.
  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, profiles (username, avatar_url)")
    .eq("league_id", id)
    .returns<TeamRow[]>();

  // Sequential rather than parallel with the above, because on a bye we can't
  // know whose lineups to ask for until we know who is in the league.
  const { data: lineups } = await supabase
    .from("lineups")
    .select(
      "id, fantasy_team_id, formation, carried_forward, lineup_players (player_id, role, is_captain, is_vice_captain, players (display_name, position, photo_url, club_id, clubs (short_name)))",
    )
    .eq("gameweek_id", matchup.gameweek_id)
    .in("fantasy_team_id", isBye ? (teams ?? []).map((team) => team.id) : sideIds)
    .returns<LineupRow[]>();

  // Only the XIs actually rendered. The other teams' lineups are here to be
  // averaged into a projection, and nobody needs their per-player stat lines.
  const playerIds = (lineups ?? [])
    .filter((lineup) => sideIds.includes(lineup.fantasy_team_id))
    .flatMap((lineup) =>
      lineup.lineup_players.filter((row) => row.role === "starter").map((row) => row.player_id),
    );

  const [{ data: scores }, { data: stats }] = await Promise.all([
    playerIds.length
      ? supabase
          .from("player_gameweek_scores")
          .select("player_id, points")
          .eq("league_id", id)
          .eq("gameweek_id", matchup.gameweek_id)
          .in("player_id", playerIds)
          .returns<ScoreRow[]>()
      : Promise.resolve({ data: [] as ScoreRow[] }),

    // !inner keeps only stats rows whose fixture is in this gameweek.
    playerIds.length
      ? supabase
          .from("player_match_stats")
          .select(
            "player_id, minutes, goals, assists, clean_sheet, goals_conceded, saves, yellow_cards, red_cards, fixtures!inner(gameweek_id)",
          )
          .eq("fixtures.gameweek_id", matchup.gameweek_id)
          .in("player_id", playerIds)
          .returns<StatRow[]>()
      : Promise.resolve({ data: [] as StatRow[] }),
  ]);

  // One call for the whole gameweek rather than one per player. Scored under
  // this league's rules, so it's directly comparable to the real points beside
  // it once the matches start.
  const { data: projections } = await supabase.rpc("projected_points_for_league", {
    p_league_id: id,
    p_gameweek_id: matchup.gameweek_id,
  });

  // Kickoff per club, so a player whose match is underway can be marked as
  // such. Statistics only land at full time, so without this a striker who has
  // just scored is indistinguishable from one who was left on the bench — both
  // show a dash, and the obvious conclusion is that the site is broken.
  const { data: matchFixtures } = await supabase
    .from("fixtures")
    .select("home_club_id, away_club_id, kickoff_at")
    .eq("gameweek_id", matchup.gameweek_id)
    .returns<MatchFixture[]>();

  const kickoffByClub = new Map<string, number>();
  for (const fixture of matchFixtures ?? []) {
    const at = new Date(String(fixture.kickoff_at).replace(" ", "T")).getTime();
    if (Number.isNaN(at)) continue;
    for (const club of [fixture.home_club_id, fixture.away_club_id]) {
      const known = kickoffByClub.get(club);
      if (known === undefined || at < known) kickoffByClub.set(club, at);
    }
  }

  const projectedBy = new Map(
    ((projections ?? []) as { player_id: string; points: number | null }[]).map((row) => [
      row.player_id,
      row.points === null ? null : Number(row.points),
    ]),
  );

  const pointsBy = new Map((scores ?? []).map((row) => [row.player_id, row.points]));
  const statsBy = new Map((stats ?? []).map((row) => [row.player_id, row]));
  const nameBy = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const managerBy = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.username ?? null]),
  );
  const avatarBy = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.avatar_url ?? null]),
  );
  const lineupBy = new Map((lineups ?? []).map((lineup) => [lineup.fantasy_team_id, lineup]));

  const played = matchup.status !== "scheduled";

  /**
   * Is this player's club match underway right now?
   *
   * "Kicked off, and we have no statistics for him yet." The absence of a row
   * is the honest end condition — the ingestion writes a row for everyone in
   * the squad list, including unused substitutes, so a row appearing means that
   * fixture has been read. The window stops a fixture that never ingested from
   * claiming to be in progress for the rest of the season.
   */
  const isPlaying = (playerId: string, clubId: string | null | undefined) => {
    if (!clubId) return false;

    const kickoff = kickoffByClub.get(clubId);
    if (kickoff === undefined) return false;

    const since = Date.now() - kickoff;
    return since >= 0 && since < MATCH_WINDOW_MS && !statsBy.has(playerId);
  };

  /**
   * What a team's starting XI is expected to score, captain doubled.
   *
   * Uses the captain rather than whoever actually doubled: before kickoff the
   * vice hasn't inherited anything, and the point of the number is to say what
   * should happen, not what did.
   */
  const projectedFor = (teamId: string | null) => {
    if (!teamId) return null;

    const starters = (lineupBy.get(teamId)?.lineup_players ?? []).filter(
      (row) => row.role === "starter",
    );
    if (starters.length === 0) return null;

    const captainId = starters.find((row) => row.is_captain)?.player_id;

    let total = 0;
    let missing = 0;

    for (const row of starters) {
      const value = projectedBy.get(row.player_id);
      if (value === null || value === undefined) {
        missing += 1;
        continue;
      }
      total += value * (row.player_id === captainId ? 2 : 1);
    }

    return { total, missing };
  };

  const homeProjection = projectedFor(matchup.home_team_id);
  const awayProjection = projectedFor(matchup.away_team_id);

  /**
   * What the field is expected to score — the mean of every other team's XI.
   *
   * Averaged rather than summed: the manager is being measured against one
   * typical rival, which is what the bye's actual points are an average of too.
   */
  const fieldProjection = (() => {
    if (!isBye) return null;

    const others = (teams ?? [])
      .filter((team) => team.id !== matchup.home_team_id)
      .map((team) => projectedFor(team.id))
      .filter((value): value is { total: number; missing: number } => value !== null);

    if (others.length === 0) return null;

    return {
      total: others.reduce((sum, row) => sum + row.total, 0) / others.length,
      teams: others.length,
    };
  })();

  const rivals = Math.max((teams ?? []).length - 1, 0);

  // Whoever the home team is actually up against, real or averaged.
  const opponentProjection = isBye ? fieldProjection : awayProjection;
  const opponentName = isBye ? "The field" : nameBy.get(matchup.away_team_id ?? "");

  const renderSide = (teamId: string | null, points: number, projection: ReturnType<typeof projectedFor>) => {
    if (!teamId) {
      return (
        <section className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <h2 className="truncate font-semibold">The field</h2>
              <span className="block text-xs dim">
                bye week · average of {rivals === 1 ? "the other team" : `the other ${rivals} teams`}
              </span>
            </span>
            <span className="flex flex-col items-end">
              <span className="numeric text-lg">{played ? points : "–"}</span>
              {fieldProjection ? (
                <span
                  className="numeric text-xs dim"
                  title="What a typical rival is projected to score this week."
                >
                  {fieldProjection.total.toFixed(1)} projected
                </span>
              ) : null}
            </span>
          </div>

          <p className="mt-3 text-xs dim">
            Nobody is scheduled against you this week, so you play the league average
            instead. Beat it and it counts as a win.
          </p>
        </section>
      );
    }

    const lineup = lineupBy.get(teamId);
    const allStarters = (lineup?.lineup_players ?? []).filter((row) => row.role === "starter");

    // The armband passes to the vice if the captain didn't play, so work out
    // who actually doubled rather than assuming it was the captain.
    const captainId = allStarters.find((row) => row.is_captain)?.player_id;
    const viceId = allStarters.find((row) => row.is_vice_captain)?.player_id;
    const captainPlayed = (statsBy.get(captainId ?? "")?.minutes ?? 0) > 0;
    const doubledId = captainPlayed ? captainId : viceId;

    /** What a player's cell shows, captain doubled — or null if not yet scored. */
    const scoreOf = (playerId: string) =>
      pointsBy.has(playerId)
        ? (pointsBy.get(playerId) ?? 0) * (playerId === doubledId ? 2 : 1)
        : null;

    // The best return on this side. Per side rather than across the matchup, so
    // each column has its own — the interesting comparison is your best against
    // theirs. Ties all get it: picking one arbitrarily would be a lie about the
    // other. Nobody is an MVP in a week where the best return was nothing.
    const returns = allStarters
      .map((row) => scoreOf(row.player_id))
      .filter((value): value is number => value !== null);

    const best = returns.length ? Math.max(...returns) : null;
    const mvpScore = best !== null && best > 0 ? best : null;

    const starters = allStarters
      .sort(
        (a, b) =>
          (POSITION_ORDER[a.players?.position ?? ""] ?? 9) -
            (POSITION_ORDER[b.players?.position ?? ""] ?? 9) ||
          (a.players?.display_name ?? "").localeCompare(b.players?.display_name ?? ""),
      );

    return (
      <section className="flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <ManagerAvatar
              src={avatarBy.get(teamId)}
              username={managerBy.get(teamId)}
              size="md"
            />
            <span className="min-w-0">
              <h2 className="truncate font-semibold">{nameBy.get(teamId) ?? "—"}</h2>
              <span className="block text-xs dim">
                {managerBy.get(teamId) ? `@${managerBy.get(teamId)} · ` : ""}
                {lineup?.formation ?? "no lineup set"}
                {lineup?.carried_forward ? " · carried over" : ""}
              </span>
            </span>
          </span>
          <span className="flex flex-col items-end">
            <span className="numeric text-lg">{played ? points : "–"}</span>
            {projection ? (
              <span className="flex flex-col items-end">
                <span
                  className="numeric text-xs dim"
                  title="Projected total for this XI under your league's rules, captain doubled."
                >
                  {projection.total.toFixed(1)} projected
                </span>
                {/* Spelled out rather than a symbol. A "+1?" badge meant
                    nothing to anyone who hadn't written it. */}
                {projection.missing > 0 ? (
                  <span className="text-[10px]" style={{ color: "var(--warning)" }}>
                    {projection.missing} of {11} not projected
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </div>

        <ul className="list mt-3">
          {starters.map((row) => {
            const value = scoreOf(row.player_id);
            const mvp = value !== null && mvpScore !== null && value === mvpScore;

            return (
            <li
              key={row.player_id}
              className="row gap-2"
              style={mvp ? MVP_ROW : undefined}
              title={mvp ? "Best return in this XI" : undefined}
            >
              <PlayerAvatar
                src={row.players?.photo_url ?? null}
                name={row.players?.display_name ?? "?"}
              />
              <Link
                href={`/leagues/${id}/players/${row.player_id}?gw=${matchup.gameweeks?.number}`}
                className="min-w-0 flex-1 hover:underline"
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{row.players?.display_name}</span>
                  {row.is_captain ? (
                    <span className="rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-300">
                      C
                    </span>
                  ) : null}
                  {row.is_vice_captain ? (
                    <span className="rounded bg-[var(--surface-raised)] px-1 text-[10px] font-bold text-[var(--text-muted)]">
                      V
                    </span>
                  ) : null}
                  {played && row.player_id === doubledId ? (
                    <span className="rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-300">
                      ×2
                    </span>
                  ) : null}
                  {/* Statistics only arrive at full time, so this is what
                      separates "hasn't scored" from "hasn't finished". */}
                  {isPlaying(row.player_id, row.players?.club_id) ? (
                    <span
                      className="rounded px-1 text-[10px] font-bold"
                      style={{ background: "rgb(16 185 129 / 0.2)", color: "var(--accent-hover)" }}
                      title="His match is under way. Points land when it finishes."
                    >
                      LIVE
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs dim">
                  {row.players?.position} · {row.players?.clubs?.short_name ?? "—"} ·{" "}
                  {isPlaying(row.player_id, row.players?.club_id)
                    ? "playing now"
                    : statSummary(statsBy.get(row.player_id))}
                </span>
              </Link>
              {/* Zero is a claim: he played and earned nothing. A dash is the
                  absence of one. So the number appears only where a score has
                  actually been computed for him — which covers not kicked off,
                  still playing, finished but not yet ingested, and a blank
                  gameweek, all of which were previously reported as zero. */}
              <span className="numeric text-sm" style={pointsStyle(value, mvp)}>
                {value === null ? "–" : value}
              </span>
            </li>
            );
          })}
          {starters.length === 0 ? (
            <li className="row justify-center py-4 text-xs dim">
              No lineup was set for this gameweek.
            </li>
          ) : null}
        </ul>
      </section>
    );
  };

  const { data: unplayedCount } = await supabase.rpc("gameweek_unplayed_fixtures", {
    p_gameweek_id: matchup.gameweek_id,
  });

  const unplayed = Number(unplayedCount ?? 0);

  return (
    <main className="page">
      <div>
        <BackLink fallbackHref={`/leagues/${id}`} fallbackLabel="league" />
        <h1 className="page-title mt-1">Gameweek {matchup.gameweeks?.number}</h1>
        <p className="page-subtitle">
          {unplayed > 0
            ? `Provisional · ${matchup.home_points} – ${matchup.away_points}`
            : played
              ? `Final · ${matchup.home_points} – ${matchup.away_points}`
              : "Not yet played"}
        </p>
      </div>

      {/* The Premier League doesn't always play a full round in a week. A
          deferred match still counts towards the gameweek it belongs to, so
          this score can move long after the weekend — better to say so than to
          have someone find their win has quietly become a loss. */}
      {unplayed > 0 ? (
        <p className="notice text-xs">
          {unplayed === 1
            ? "One match from this gameweek hasn't been played yet"
            : `${unplayed} matches from this gameweek haven't been played yet`}
          , so this score is not final. Points from those matches will be added to this
          gameweek when they&apos;re played, and the result can change.
        </p>
      ) : null}

      {/* A projected winner is only interesting while the result is open. Once
          the gameweek is final the actual score is right there and a
          prediction of it would just be noise. */}
      {homeProjection && opponentProjection && !played ? (
        <p className="text-xs dim">
          {Math.abs(homeProjection.total - opponentProjection.total) < 1
            ? "Projected too close to call."
            : `${
                homeProjection.total > opponentProjection.total
                  ? nameBy.get(matchup.home_team_id)
                  : opponentName
              } projected to win by ${Math.abs(
                homeProjection.total - opponentProjection.total,
              ).toFixed(1)}.`}{" "}
          Projections are mostly a guess about who plays, so treat a small gap as no gap.
        </p>
      ) : null}

      <div className="flex flex-col gap-8 sm:flex-row">
        {renderSide(matchup.home_team_id, matchup.home_points, homeProjection)}
        {renderSide(matchup.away_team_id, matchup.away_points, awayProjection)}
      </div>

      <p className="text-xs dim">
        The ×2 player is the captain — or the vice-captain, if the captain didn&apos;t play. Their
        score is shown already doubled, so each column adds up to the team total.
      </p>

      {/* A colour system nobody can read is decoration. */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs dim">
        <span>Returns:</span>
        <span style={{ color: "var(--danger)" }}>under 3</span>
        <span style={{ color: "var(--warning)" }}>3 to 8.5</span>
        <span style={{ color: "var(--accent-hover)" }}>above 8.5</span>
        <span style={pointsStyle(10, true)}>best in the XI</span>
      </p>
    </main>
  );
}
