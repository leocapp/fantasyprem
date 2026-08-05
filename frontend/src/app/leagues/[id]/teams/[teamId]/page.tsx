import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

type LeagueRow = { id: string; name: string; status: string };

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  draft_position: number | null;
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

type RosterRow = {
  player_id: string;
  acquired_via: string;
  players: {
    display_name: string;
    position: string;
    photo_url: string | null;
    clubs: { short_name: string } | null;
  } | null;
};

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export const dynamic = "force-dynamic";

export default async function TeamDetailPage({
  params,
}: {
  params: Promise<{ id: string; teamId: string }>;
}) {
  const { id, teamId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, draft_position, profiles (display_name, username)")
    .eq("league_id", id)
    .returns<TeamRow[]>();

  const team = teams?.find((row) => row.id === teamId);
  if (!team) notFound();

  const nameBy = new Map((teams ?? []).map((row) => [row.id, row.name]));

  const { data: standings } = await supabase
    .from("league_standings")
    .select("team_id, games_played, wins, losses, draws, points_for, points_against")
    .eq("league_id", id)
    .eq("team_id", teamId)
    .maybeSingle<StandingRow>();

  const { data: matchups } = await supabase
    .from("matchups")
    .select(
      "id, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
    )
    .eq("league_id", id)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .returns<MatchupRow[]>();

  const { data: roster } = await supabase
    .from("roster_entries")
    .select("player_id, acquired_via, players (display_name, position, photo_url, clubs (short_name))")
    .eq("fantasy_team_id", teamId)
    .is("dropped_at", null)
    .returns<RosterRow[]>();

  const schedule = (matchups ?? [])
    .slice()
    .sort((a, b) => (a.gameweeks?.number ?? 0) - (b.gameweeks?.number ?? 0));

  const squad = (roster ?? []).slice().sort((a, b) => {
    const positionDiff =
      (POSITION_ORDER[a.players?.position ?? ""] ?? 9) -
      (POSITION_ORDER[b.players?.position ?? ""] ?? 9);
    return positionDiff || (a.players?.display_name ?? "").localeCompare(b.players?.display_name ?? "");
  });

  const isMine = team.owner_id === user.id;

  return (
    <main className="page">
      <div>
        <Link href={`/leagues/${league.id}`} className="text-sm dim hover:text-[var(--text)]">
          ← {league.name}
        </Link>
        <h1 className="page-title mt-1">{team.name}</h1>
        <p className="page-subtitle">
          {team.profiles?.display_name ?? team.profiles?.username ?? "Manager"}
          {isMine ? " · you" : ""}
          {standings
            ? ` · ${standings.wins}-${standings.draws}-${standings.losses} · ${standings.points_for} points for`
            : ""}
        </p>
      </div>

      <section>
        <h2 className="section-label">Season schedule</h2>
        <ul className="list mt-3">
          {schedule.map((matchup) => {
            const isHome = matchup.home_team_id === teamId;
            const opponentId = isHome ? matchup.away_team_id : matchup.home_team_id;
            const own = isHome ? matchup.home_points : matchup.away_points;
            const other = isHome ? matchup.away_points : matchup.home_points;
            const played = matchup.status === "final";

            const outcome = !played ? "" : own > other ? "W" : own < other ? "L" : "D";
            const outcomeColour =
              outcome === "W"
                ? "text-[var(--accent-hover)]"
                : outcome === "L"
                  ? "text-[var(--danger)]"
                  : "muted";

            return (
              <li key={matchup.id}>
                <Link href={`/leagues/${league.id}/matchups/${matchup.id}`} className="row-link">
                  <span className="numeric w-12 text-xs dim">
                    GW{matchup.gameweeks?.number}
                  </span>
                  <span className="w-4 text-xs dim">{opponentId ? (isHome ? "v" : "@") : ""}</span>
                  <span className="flex-1 truncate text-sm">
                    {opponentId ? (nameBy.get(opponentId) ?? "—") : "Bye"}
                  </span>
                  {played ? (
                    <>
                      <span className={`w-4 text-sm font-semibold ${outcomeColour}`}>{outcome}</span>
                      <span className="numeric text-sm">
                        {own} – {other}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs dim">{matchup.status}</span>
                  )}
                </Link>
              </li>
            );
          })}
          {schedule.length === 0 ? (
            <li className="row justify-center py-6 text-sm dim">
              No schedule yet — it&apos;s built when the draft finishes.
            </li>
          ) : null}
        </ul>
      </section>

      <section>
        <h2 className="section-label">Squad ({squad.length})</h2>
        <ul className="list mt-3">
          {squad.map((row) => (
            <li key={row.player_id} className="row">
              <PlayerAvatar
                src={row.players?.photo_url ?? null}
                name={row.players?.display_name ?? "?"}
              />
              <span className={`badge badge-${row.players?.position}`}>
                {row.players?.position}
              </span>
              <Link
                href={`/leagues/${league.id}/players/${row.player_id}`}
                className="flex-1 truncate font-medium hover:underline"
              >
                {row.players?.display_name}
              </Link>
              <span className="text-sm dim">{row.players?.clubs?.short_name ?? "—"}</span>
              {row.acquired_via !== "draft" ? (
                <span className="text-xs dim">{row.acquired_via.replace("_", " ")}</span>
              ) : null}
            </li>
          ))}
          {squad.length === 0 ? (
            <li className="row justify-center py-6 text-sm dim">No players yet.</li>
          ) : null}
        </ul>
      </section>
    </main>
  );
}
