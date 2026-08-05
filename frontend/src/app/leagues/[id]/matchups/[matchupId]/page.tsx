import Link from "next/link";
import { notFound, redirect } from "next/navigation";

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

type TeamRow = { id: string; name: string };

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
  bonus: number;
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
  if (stat.bonus) parts.push(`${stat.bonus}B`);

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

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name")
    .in("id", teamIds)
    .returns<TeamRow[]>();

  const { data: lineups } = await supabase
    .from("lineups")
    .select(
      "id, fantasy_team_id, formation, lineup_players (player_id, role, is_captain, is_vice_captain, players (display_name, position, photo_url, clubs (short_name)))",
    )
    .eq("gameweek_id", matchup.gameweek_id)
    .in("fantasy_team_id", teamIds)
    .returns<LineupRow[]>();

  const playerIds = (lineups ?? []).flatMap((lineup) =>
    lineup.lineup_players.filter((row) => row.role === "starter").map((row) => row.player_id),
  );

  const { data: scores } = playerIds.length
    ? await supabase
        .from("player_gameweek_scores")
        .select("player_id, points")
        .eq("league_id", id)
        .eq("gameweek_id", matchup.gameweek_id)
        .in("player_id", playerIds)
        .returns<ScoreRow[]>()
    : { data: [] };

  // !inner keeps only stats rows whose fixture is in this gameweek.
  const { data: stats } = playerIds.length
    ? await supabase
        .from("player_match_stats")
        .select(
          "player_id, minutes, goals, assists, clean_sheet, goals_conceded, saves, yellow_cards, red_cards, bonus, fixtures!inner(gameweek_id)",
        )
        .eq("fixtures.gameweek_id", matchup.gameweek_id)
        .in("player_id", playerIds)
        .returns<StatRow[]>()
    : { data: [] };

  const pointsBy = new Map((scores ?? []).map((row) => [row.player_id, row.points]));
  const statsBy = new Map((stats ?? []).map((row) => [row.player_id, row]));
  const nameBy = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const lineupBy = new Map((lineups ?? []).map((lineup) => [lineup.fantasy_team_id, lineup]));

  const played = matchup.status !== "scheduled";

  const renderSide = (teamId: string | null, points: number) => {
    if (!teamId) {
      return (
        <section className="flex-1">
          <h2 className="font-semibold text-slate-500">Bye week</h2>
        </section>
      );
    }

    const lineup = lineupBy.get(teamId);
    const starters = (lineup?.lineup_players ?? [])
      .filter((row) => row.role === "starter")
      .sort(
        (a, b) =>
          (POSITION_ORDER[a.players?.position ?? ""] ?? 9) -
            (POSITION_ORDER[b.players?.position ?? ""] ?? 9) ||
          (a.players?.display_name ?? "").localeCompare(b.players?.display_name ?? ""),
      );

    return (
      <section className="flex-1">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">{nameBy.get(teamId) ?? "—"}</h2>
          <span className="font-mono text-lg">{played ? points : "–"}</span>
        </div>
        <p className="text-xs text-slate-600">{lineup?.formation ?? "no lineup set"}</p>

        <ul className="mt-3 divide-y divide-slate-800 rounded-lg border border-slate-800">
          {starters.map((row) => (
            <li key={row.player_id} className="flex items-center gap-2 px-3 py-2">
              <PlayerAvatar src={row.players?.photo_url ?? null} name={row.players?.display_name ?? "?"} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {row.players?.display_name}
                  </span>
                  {row.is_captain ? (
                    <span className="rounded bg-amber-500/20 px-1 text-[10px] font-bold text-amber-300">
                      C
                    </span>
                  ) : null}
                  {row.is_vice_captain ? (
                    <span className="rounded bg-slate-700 px-1 text-[10px] font-bold text-slate-300">
                      V
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-slate-500">
                  {row.players?.position} · {row.players?.clubs?.short_name ?? "—"} ·{" "}
                  {statSummary(statsBy.get(row.player_id))}
                </span>
              </span>
              <span className="font-mono text-sm">
                {played ? (pointsBy.get(row.player_id) ?? 0) : "–"}
              </span>
            </li>
          ))}
          {starters.length === 0 ? (
            <li className="px-3 py-4 text-center text-xs text-slate-600">
              No lineup was set for this gameweek.
            </li>
          ) : null}
        </ul>
      </section>
    );
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8 pt-16">
      <div>
        <Link href={`/leagues/${id}`} className="text-sm text-slate-500 hover:text-slate-300">
          ← Back to league
        </Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          Gameweek {matchup.gameweeks?.number}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          {played ? `Final · ${matchup.home_points} – ${matchup.away_points}` : "Not yet played"}
        </p>
      </div>

      <div className="flex flex-col gap-8 sm:flex-row">
        {renderSide(matchup.home_team_id, matchup.home_points)}
        {renderSide(matchup.away_team_id, matchup.away_points)}
      </div>

      <p className="text-xs text-slate-600">
        Captain&apos;s points are doubled in the team total, so the column above will not sum to the
        score.
      </p>
    </main>
  );
}
