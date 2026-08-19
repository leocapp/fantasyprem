import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import BackLink from "@/components/BackLink";
import ManagerAvatar from "@/components/ManagerAvatar";
import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

type LeagueRow = { id: string; name: string; status: string };

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  draft_position: number | null;
  profiles: {
    display_name: string | null;
    username: string | null;
    avatar_url: string | null;
    bio: string | null;
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

const TABS = ["squad", "schedule"] as const;
type Tab = (typeof TABS)[number];

export default async function TeamDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; teamId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id, teamId } = await params;
  const { tab } = await searchParams;
  const supabase = await createClient();

  // In the URL rather than in component state: the page stays a server
  // component, the back button works, and a tab is linkable — useful when
  // someone wants to point at a rival's squad in the chat.
  //
  // Squad first, because "what has he actually got?" is the question people
  // click a team name to answer.
  const active: Tab = TABS.includes(tab as Tab) ? (tab as Tab) : "squad";

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
    .select(
      "id, name, owner_id, draft_position, profiles (display_name, username, avatar_url, bio)",
    )
    .eq("league_id", id)
    .returns<TeamRow[]>();

  const team = teams?.find((row) => row.id === teamId);
  if (!team) notFound();

  const nameBy = new Map((teams ?? []).map((row) => [row.id, row.name]));

  const [{ data: standings }, { data: matchups }, { data: roster }] = await Promise.all([
    supabase
      .from("league_standings")
      .select("team_id, games_played, wins, losses, draws, points_for, points_against")
      .eq("league_id", id)
      .eq("team_id", teamId)
      .maybeSingle<StandingRow>(),

    supabase
      .from("matchups")
      .select(
        "id, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
      )
      .eq("league_id", id)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      .returns<MatchupRow[]>(),

    supabase
      .from("roster_entries")
      .select(
        "player_id, acquired_via, players (display_name, position, photo_url, clubs (short_name))",
      )
      .eq("fantasy_team_id", teamId)
      .is("dropped_at", null)
      .returns<RosterRow[]>(),
  ]);

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
        <BackLink fallbackHref={`/leagues/${league.id}`} fallbackLabel={league.name} />
        <div className="mt-2 flex items-center gap-3">
          <ManagerAvatar
            src={team.profiles?.avatar_url}
            username={team.profiles?.username}
            size="lg"
          />
          <div className="min-w-0">
            <h1 className="page-title">{team.name}</h1>
            <p className="page-subtitle">
              {team.profiles?.username ? `@${team.profiles.username}` : "Manager"}
              {team.profiles?.display_name ? ` · ${team.profiles.display_name}` : ""}
              {isMine ? " · you" : ""}
              {standings
                ? ` · ${standings.wins}-${standings.draws}-${standings.losses} · ${standings.points_for} points for`
                : ""}
            </p>
          </div>
        </div>

        {team.profiles?.bio ? (
          <p className="mt-3 max-w-prose text-sm muted">{team.profiles.bio}</p>
        ) : null}
      </div>

      {/* Counts on the tabs themselves, so the page answers "how big is his
          squad" before you've clicked anything. */}
      <nav className="flex gap-2">
        {(
          [
            ["squad", `Squad (${squad.length})`],
            ["schedule", `Schedule (${schedule.length})`],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={`/leagues/${league.id}/teams/${teamId}${key === "squad" ? "" : `?tab=${key}`}`}
            scroll={false}
            // Changing tab changes what's shown, it isn't a new destination —
            // so it replaces the history entry instead of stacking one.
            // Otherwise Back walks you through every tab you looked at before
            // it finally returns to the league, which is the same trap the
            // gameweek strip on the player page had.
            replace
            aria-current={active === key ? "page" : undefined}
            className="rounded-md border px-3 py-1.5 text-sm transition-colors"
            style={
              active === key
                ? {
                    background: "var(--accent-soft)",
                    borderColor: "var(--accent)",
                    color: "var(--text)",
                  }
                : { borderColor: "var(--border)", color: "var(--text-muted)" }
            }
          >
            {label}
          </Link>
        ))}
      </nav>

      <section hidden={active !== "schedule"}>
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

      <section hidden={active !== "squad"}>
        <h2 className="section-label">
          Squad ({squad.length})
          <span className="ml-2 font-normal dim">
            {(["GK", "DEF", "MID", "FWD"] as const)
              .map(
                (position) =>
                  `${squad.filter((row) => row.players?.position === position).length} ${position}`,
              )
              .join(" · ")}
          </span>
        </h2>
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
