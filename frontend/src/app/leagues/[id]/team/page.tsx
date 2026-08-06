import { notFound, redirect } from "next/navigation";

import AvailabilityKey from "@/components/AvailabilityKey";
import { createClient } from "@/lib/supabase/server";

import PitchLineup, { type Formation, type SquadPlayer } from "./PitchLineup";
import { saveLineup } from "./actions";

type LeagueRow = {
  id: string;
  name: string;
  status: string;
  carry_forward_lineups: boolean;
};

type TeamRow = { id: string; name: string; owner_id: string };
type GameweekRow = { id: string; number: number; deadline_at: string };

type PlayerRow = {
  id: string;
  display_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  photo_url: string | null;
  club_id: string | null;
  shirt_number: number | null;
  availability: string | null;
  news: string | null;
  chance_of_playing: number | null;
  clubs: { short_name: string } | null;
};

type RosterRow = {
  player_id: string;
  players: PlayerRow | null;
};

type LineupRow = {
  id: string;
  formation: string;
  lineup_players: {
    player_id: string;
    role: string;
    is_captain: boolean;
    is_vice_captain: boolean;
  }[];
};

type FixtureRow = {
  home_club_id: string;
  away_club_id: string;
  kickoff_at: string;
};

type ScoreRow = { player_id: string; points: number; breakdown: Record<string, number> };

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export const dynamic = "force-dynamic";

export default async function TeamPage({
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

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status, carry_forward_lineups")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: team } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id")
    .eq("league_id", id)
    .eq("owner_id", user.id)
    .maybeSingle<TeamRow>();

  if (!team) notFound();

  // The gameweek to set a lineup for is the team's next unplayed matchup, not
  // whatever the FPL calendar says is next. Re-running the ingestion job
  // rewrites deadlines from the live feed, which would otherwise drag this
  // screen back to gameweek 1 while the league is on gameweek 5.
  const { data: upcoming } = await supabase
    .from("matchups")
    .select("gameweeks (id, number, deadline_at)")
    .eq("league_id", id)
    .eq("status", "scheduled")
    .or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`)
    .returns<{ gameweeks: GameweekRow | null }[]>();

  const scheduled = (upcoming ?? [])
    .map((row) => row.gameweeks)
    .filter((row): row is GameweekRow => Boolean(row))
    .sort((a, b) => a.number - b.number);

  // Before a draft there's no schedule yet, so fall back to the calendar.
  const { data: byDeadline } =
    scheduled.length === 0
      ? await supabase
          .from("gameweeks")
          .select("id, number, deadline_at")
          .gt("deadline_at", new Date().toISOString())
          .order("deadline_at")
          .limit(1)
          .maybeSingle<GameweekRow>()
      : { data: null };

  const gameweek = scheduled[0] ?? byDeadline;

  const { data: roster } = await supabase
    .from("roster_entries")
    .select(
      "player_id, players (id, display_name, position, photo_url, club_id, shirt_number, availability, news, chance_of_playing, clubs (short_name))",
    )
    .eq("fantasy_team_id", team.id)
    .is("dropped_at", null)
    .returns<RosterRow[]>();

  const { data: formations } = await supabase
    .from("formations")
    .select("code, defenders, midfielders, forwards")
    .order("sort_order")
    .returns<Formation[]>();

  const { data: lineup } = gameweek
    ? await supabase
        .from("lineups")
        .select("id, formation, lineup_players (player_id, role, is_captain, is_vice_captain)")
        .eq("fantasy_team_id", team.id)
        .eq("gameweek_id", gameweek.id)
        .maybeSingle<LineupRow>()
    : { data: null };

  // Who each club plays this gameweek, so managers can see the fixture without
  // leaving the page.
  const { data: fixtures } = gameweek
    ? await supabase
        .from("fixtures")
        .select("home_club_id, away_club_id, kickoff_at")
        .eq("gameweek_id", gameweek.id)
        .returns<FixtureRow[]>()
    : { data: [] };

  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, short_name")
    .returns<{ id: string; short_name: string }[]>();

  const clubName = new Map((clubs ?? []).map((club) => [club.id, club.short_name]));

  // club id -> "v ARS" / "@ MCI", or several for a double gameweek.
  const opponents = new Map<string, string[]>();
  for (const fixture of fixtures ?? []) {
    const home = clubName.get(fixture.home_club_id) ?? "?";
    const away = clubName.get(fixture.away_club_id) ?? "?";
    opponents.set(fixture.home_club_id, [...(opponents.get(fixture.home_club_id) ?? []), `v ${away}`]);
    opponents.set(fixture.away_club_id, [...(opponents.get(fixture.away_club_id) ?? []), `@ ${home}`]);
  }

  // Last gameweek's return for each player, as a form guide.
  const { data: previousGameweek } = gameweek
    ? await supabase
        .from("gameweeks")
        .select("id, number")
        .lt("number", gameweek.number)
        .order("number", { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; number: number }>()
    : { data: null };

  const { data: previousScores } = previousGameweek
    ? await supabase
        .from("player_gameweek_scores")
        .select("player_id, points, breakdown")
        .eq("league_id", id)
        .eq("gameweek_id", previousGameweek.id)
        .returns<ScoreRow[]>()
    : { data: [] };

  const lastGameweek = new Map((previousScores ?? []).map((row) => [row.player_id, row]));

  const captainId = lineup?.lineup_players.find((row) => row.is_captain)?.player_id;
  const viceId = lineup?.lineup_players.find((row) => row.is_vice_captain)?.player_id;

  const players = (roster ?? [])
    .map((row) => row.players)
    .filter((player): player is PlayerRow => Boolean(player))
    .sort(
      (a, b) =>
        POSITION_ORDER[a.position] - POSITION_ORDER[b.position] ||
        a.display_name.localeCompare(b.display_name),
    );

  // Flattened for the pitch component: it shouldn't have to know about Supabase
  // row shapes or how the fixture string was assembled.
  const squad: SquadPlayer[] = players.map((player) => {
    const last = lastGameweek.get(player.id);
    const fixtures = player.club_id ? opponents.get(player.club_id) : undefined;

    return {
      id: player.id,
      name: player.display_name,
      position: player.position,
      shirtNumber: player.shirt_number,
      club: player.clubs?.short_name ?? "—",
      availability: player.availability,
      news: player.news,
      chance: player.chance_of_playing,
      fixture: fixtures?.length ? fixtures.join(", ") : "no fixture",
      lastPoints: last ? Number(last.points) : null,
      lastMinutes: last?.breakdown?.minutes ?? null,
    };
  });

  const starterIds = (lineup?.lineup_players ?? [])
    .filter((row) => row.role === "starter")
    .map((row) => row.player_id);

  return (
    <main className="page">
      <h1 className="page-title">{team.name}</h1>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      {gameweek && !lineup ? (
        <p className="text-sm muted">
          {league.carry_forward_lineups
            ? "No lineup set for this gameweek yet — last week's will be used if you don't change it."
            : "No lineup set for this gameweek. Without one you'll score nothing."}
        </p>
      ) : null}

      {players.length === 0 ? (
        <p className="muted">Your roster is empty — it fills up when the draft runs.</p>
      ) : !gameweek ? (
        <p className="muted">
          No gameweek is open for edits. Re-run the ingestion job if the season has moved on.
        </p>
      ) : (
        <form action={saveLineup} className="flex flex-col gap-4" suppressHydrationWarning>
          <input type="hidden" name="league_id" value={league.id} />
          <input type="hidden" name="team_id" value={team.id} />
          <input type="hidden" name="gameweek_id" value={gameweek.id} />

          <AvailabilityKey />

          <PitchLineup
            players={squad}
            formations={formations ?? []}
            initialFormation={lineup?.formation ?? "4-4-2"}
            initialStarters={starterIds}
            initialCaptain={captainId ?? null}
            initialVice={viceId ?? null}
            gameweekNumber={gameweek.number}
            teamName={team.name}
            leagueId={league.id}
            deadlineLabel={new Date(gameweek.deadline_at).toLocaleString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          />
        </form>
      )}
    </main>
  );
}
