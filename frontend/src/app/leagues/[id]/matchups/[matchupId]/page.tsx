import Link from "next/link";
import { notFound, redirect } from "next/navigation";

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
    clubs: { short_name: string } | null;
  } | null;
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

  const teamIds = [matchup.home_team_id, matchup.away_team_id].filter(
    (value): value is string => Boolean(value),
  );

  const [{ data: teams }, { data: lineups }] = await Promise.all([
    supabase
      .from("fantasy_teams")
      .select("id, name, profiles (username, avatar_url)")
      .in("id", teamIds)
      .returns<TeamRow[]>(),

    supabase
      .from("lineups")
      .select(
        "id, fantasy_team_id, formation, carried_forward, lineup_players (player_id, role, is_captain, is_vice_captain, players (display_name, position, photo_url, clubs (short_name)))",
      )
      .eq("gameweek_id", matchup.gameweek_id)
      .in("fantasy_team_id", teamIds)
      .returns<LineupRow[]>(),
  ]);

  const playerIds = (lineups ?? []).flatMap((lineup) =>
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

  const renderSide = (teamId: string | null, points: number) => {
    if (!teamId) {
      return (
        <section className="flex-1">
          <h2 className="font-semibold dim">Bye week</h2>
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
          <span className="numeric text-lg">{played ? points : "–"}</span>
        </div>

        <ul className="list mt-3">
          {starters.map((row) => (
            <li key={row.player_id} className="row gap-2">
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
                </span>
                <span className="block truncate text-xs dim">
                  {row.players?.position} · {row.players?.clubs?.short_name ?? "—"} ·{" "}
                  {statSummary(statsBy.get(row.player_id))}
                </span>
              </Link>
              <span className="numeric text-sm">
                {played
                  ? (pointsBy.get(row.player_id) ?? 0) * (row.player_id === doubledId ? 2 : 1)
                  : "–"}
              </span>
            </li>
          ))}
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

      <div className="flex flex-col gap-8 sm:flex-row">
        {renderSide(matchup.home_team_id, matchup.home_points)}
        {renderSide(matchup.away_team_id, matchup.away_points)}
      </div>

      <p className="text-xs dim">
        The ×2 player is the captain — or the vice-captain, if the captain didn&apos;t play. Their
        score is shown already doubled, so each column adds up to the team total.
      </p>
    </main>
  );
}
