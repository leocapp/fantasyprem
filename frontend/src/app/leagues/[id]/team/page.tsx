import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import AvailabilityKey from "@/components/AvailabilityKey";
import { formatDeadline } from "@/lib/datetime";
import { fetchAll } from "@/lib/fetchAll";
import { createClient } from "@/lib/supabase/server";

import InjuryReserve, { type ReserveEntry } from "./InjuryReserve";
import PitchLineup, { type Formation, type SquadPlayer } from "./PitchLineup";
import { saveLineup } from "./actions";

type LeagueRow = {
  id: string;
  name: string;
  status: string;
  carry_forward_lineups: boolean;
  roster_size: number;
};

type TeamRow = { id: string; name: string; owner_id: string };
type GameweekRow = { id: string; number: number; deadline_at: string };

type OpenSlotRow = {
  gameweek_id: string;
  gameweek_number: number;
  player_id: string;
  display_name: string;
  kickoff_at: string | null;
};

type PlayerRow = {
  id: string;
  display_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  photo_url: string | null;
  club_id: string | null;
  shirt_number: number | null;
  availability: string | null;
  news: string | null;
  expected_return: string | null;
  is_active: boolean;
  clubs: { short_name: string } | null;
};

type RosterRow = {
  player_id: string;
  reserved_at: string | null;
  players: PlayerRow | null;
};

type PreviousLineupRow = LineupRow & { gameweeks: { number: number } | null };

/**
 * "3 minutes ago", "yesterday". Computed here on the server and handed down as
 * a finished string, because doing it inside the client component would put
 * Date.now() in a render path — the exact hydration mismatch React warns about,
 * and one this codebase has already been bitten by twice.
 */
function savedAgo(value: string | null | undefined): string | null {
  if (!value) return null;

  const then = new Date(String(value).replace(" ", "T")).getTime();
  if (Number.isNaN(then)) return null;

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

type LineupRow = {
  id: string;
  formation: string;
  updated_at?: string;
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
  status: string;
};

type ScoreRow = { player_id: string; points: number; breakdown: Record<string, number> };

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

export const dynamic = "force-dynamic";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string; gw?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { error, message } = query;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status, carry_forward_lineups, roster_size")
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

  // Slots in an already-started gameweek whose own match hasn't been played —
  // only ever non-empty when a club's fixture was deferred to a later date.
  const { data: openSlots } = await supabase.rpc("open_lineup_slots", {
    p_team_id: team.id,
  });

  const open = (openSlots ?? []) as OpenSlotRow[];

  // ?gw= opens a past gameweek that still has an editable slot. Restricted to
  // those: without the check this would be a way to rewrite any historical
  // lineup by editing the URL.
  const requestedNumber = Number(query.gw);
  const requested = open.find((row) => row.gameweek_number === requestedNumber);

  const { data: requestedGameweek } = requested
    ? await supabase
        .from("gameweeks")
        .select("id, number, deadline_at")
        .eq("id", requested.gameweek_id)
        .maybeSingle<GameweekRow>()
    : { data: null };

  const gameweek = requestedGameweek ?? scheduled[0] ?? byDeadline;
  const editingPast = Boolean(requestedGameweek);

  const openGameweekNumbers = [...new Set(open.map((row) => row.gameweek_number))].sort(
    (a, b) => a - b,
  );

  // Everything below depends only on team and gameweek, so it goes out in one
  // batch rather than six sequential round trips.
  const [{ data: roster }, { data: formations }, { data: lineup }, { data: fixtures }, { data: clubs }] =
    await Promise.all([
      supabase
        .from("roster_entries")
        .select(
          "player_id, reserved_at, players (id, display_name, position, photo_url, club_id, shirt_number, availability, news, expected_return, is_active, clubs (short_name))",
        )
        .eq("fantasy_team_id", team.id)
        .is("dropped_at", null)
        .returns<RosterRow[]>(),

      supabase
        .from("formations")
        .select("code, defenders, midfielders, forwards")
        .order("sort_order")
        .returns<Formation[]>(),

      gameweek
        ? supabase
            .from("lineups")
            .select(
              "id, formation, updated_at, lineup_players (player_id, role, is_captain, is_vice_captain)",
            )
            .eq("fantasy_team_id", team.id)
            .eq("gameweek_id", gameweek.id)
            .maybeSingle<LineupRow>()
        : Promise.resolve({ data: null }),

      // Who each club plays this gameweek, so managers see the fixture without
      // leaving the page.
      gameweek
        ? supabase
            .from("fixtures")
            .select("home_club_id, away_club_id, kickoff_at, status")
            .eq("gameweek_id", gameweek.id)
            .returns<FixtureRow[]>()
        : Promise.resolve({ data: [] as FixtureRow[] }),

      supabase
        .from("clubs")
        .select("id, short_name")
        .returns<{ id: string; short_name: string }[]>(),
    ]);

  // Nobody should face an empty pitch after their first week. When this
  // gameweek has no lineup yet, the last one saved becomes the starting point —
  // the same XI carry_forward_lineup would use if they never came back.
  //
  // Fetched whole and sorted here rather than ordered in the query: PostgREST
  // can't order parent rows by an embedded column, and a season is at most
  // thirty-eight rows per team.
  const { data: history } =
    gameweek && !lineup
      ? await supabase
          .from("lineups")
          .select(
            "id, formation, lineup_players (player_id, role, is_captain, is_vice_captain), gameweeks!inner (number)",
          )
          .eq("fantasy_team_id", team.id)
          .returns<PreviousLineupRow[]>()
      : { data: null };

  const previous =
    gameweek && history
      ? (history
          .filter((row) => (row.gameweeks?.number ?? 0) < gameweek.number)
          .sort((a, b) => (b.gameweeks?.number ?? 0) - (a.gameweeks?.number ?? 0))[0] ?? null)
      : null;

  const previousNumber = previous?.gameweeks?.number ?? null;
  const source: LineupRow | null = lineup ?? previous;
  const prefilled = !lineup && previous !== null;

  const clubName = new Map((clubs ?? []).map((club) => [club.id, club.short_name]));

  // club id -> earliest kickoff this gameweek. A player is locked from that
  // moment: the same rule save_lineup enforces, mirrored here so the pitch
  // doesn't offer a move the database will refuse.
  const kickoffByClub = new Map<string, number>();
  for (const fixture of fixtures ?? []) {
    // Matches the database rule: a fixture already started or finished locks
    // now, whatever its scheduled time says.
    const at =
      fixture.status === "live" || fixture.status === "finished"
        ? -Infinity
        : new Date(fixture.kickoff_at).getTime();
    for (const club of [fixture.home_club_id, fixture.away_club_id]) {
      const known = kickoffByClub.get(club);
      if (known === undefined || at < known) kickoffByClub.set(club, at);
    }
  }

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


  // Our projection for the coming gameweek, under this league's rules. A squad
  // is roughly fifteen players, so one call each is cheap and they go together.
  const rosterIds = (roster ?? [])
    .map((row) => row.players?.id)
    .filter((value): value is string => Boolean(value));

  // Season totals, so the squad can be sorted by who has actually delivered.
  // Scoped to this roster and paged: a thirty-man squad over thirty-eight
  // gameweeks is 1,140 rows, and PostgREST would silently return the first
  // thousand — which would look like a few players quietly having a bad season.
  const seasonRows = rosterIds.length
    ? await fetchAll<{ player_id: string; points: number }>(
        supabase
          .from("player_gameweek_scores")
          .select("player_id, points")
          .eq("league_id", id)
          .in("player_id", rosterIds),
      )
    : [];

  const seasonPoints = new Map<string, number>();
  for (const row of seasonRows) {
    seasonPoints.set(row.player_id, (seasonPoints.get(row.player_id) ?? 0) + Number(row.points));
  }

  const projections = gameweek
    ? await Promise.all(
        rosterIds.map(async (playerId) => {
          const { data } = await supabase.rpc("projected_points", {
            p_league_id: id,
            p_player_id: playerId,
            p_gameweek_id: gameweek.id,
          });
          return [playerId, data as number | null] as const;
        }),
      )
    : [];

  const projectedBy = new Map(projections);


  // ------------------------------------------------------- injury reserve ----
  // The same rule the database uses, and for the same reason: reserved_at is
  // the manager's intent, but the spot only stops counting while the provider
  // still has him out. A cleared player takes his roster place back here too,
  // without anything having to notice he recovered.
  const OUT = new Set(["i", "s"]);
  const isReserved = (row: RosterRow) =>
    row.reserved_at !== null && OUT.has(row.players?.availability ?? "");

  const entryOf = (player: PlayerRow): ReserveEntry => ({
    id: player.id,
    name: player.display_name,
    position: player.position,
    club: player.clubs?.short_name ?? "—",
    availability: player.availability,
    news: player.news,
    expectedReturn: player.expected_return,
  });

  const reservedPlayer = (roster ?? []).find(isReserved)?.players ?? null;

  // Reserved, then cleared to play: he is occupying a normal slot again and
  // his team is very likely one over the limit.
  const returnedPlayer =
    (roster ?? []).find((row) => row.reserved_at !== null && !isReserved(row))?.players ?? null;

  const activeRows = (roster ?? []).filter((row) => !isReserved(row));
  const overBy = activeRows.length - league.roster_size;

  const eligibleToReserve = (roster ?? [])
    .filter((row) => !isReserved(row) && OUT.has(row.players?.availability ?? ""))
    .map((row) => row.players)
    .filter((player): player is PlayerRow => Boolean(player))
    .map(entryOf);

  const players = activeRows
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
      expectedReturn: player.expected_return,
      locked:
        player.club_id !== null &&
        (kickoffByClub.get(player.club_id) ?? Infinity) <= Date.now(),
      // A departed player's old club still has fixtures — showing one would
      // imply they're playing in it.
      departed: !player.is_active,
      fixture: !player.is_active
        ? "no longer in the Premier League"
        : fixtures?.length
          ? fixtures.join(", ")
          : "no fixture",
      projected: projectedBy.get(player.id) ?? null,
      lastPoints: last ? Number(last.points) : null,
      lastMinutes: last?.breakdown?.minutes ?? null,
      // Rounded: a sum of two-decimal scores turns into 41.900000000000006 the
      // moment floating point gets involved, and nobody wants that in a list.
      seasonPoints: seasonPoints.has(player.id)
        ? Math.round(seasonPoints.get(player.id)! * 10) / 10
        : null,
    };
  });

  // A saved lineup is shown exactly as saved, locked players and all — it is a
  // record of a decision. A prefill is a proposal, so anyone it can't legally
  // propose is dropped and the slot left open: players since transferred away,
  // players now on injury reserve, and — in a gameweek already underway —
  // anyone whose match has kicked off, since save_lineup would refuse them.
  const selectable = new Set(squad.filter((player) => !player.locked).map((player) => player.id));

  const sourceStarters = (source?.lineup_players ?? [])
    .filter((row) => row.role === "starter")
    .map((row) => row.player_id);

  const starterIds = prefilled
    ? sourceStarters.filter((playerId) => selectable.has(playerId))
    : sourceStarters;

  const dropped = prefilled ? sourceStarters.length - starterIds.length : 0;

  // The armband follows only if the player it belonged to is still in the XI.
  const proposed = new Set(starterIds);
  const rawCaptain = source?.lineup_players.find((row) => row.is_captain)?.player_id;
  const rawVice = source?.lineup_players.find((row) => row.is_vice_captain)?.player_id;

  const captainId = !prefilled || (rawCaptain && proposed.has(rawCaptain)) ? rawCaptain : undefined;
  const viceId = !prefilled || (rawVice && proposed.has(rawVice)) ? rawVice : undefined;

  return (
    <main className="page page-wide">
      <h1 className="page-title">{team.name}</h1>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      {/* First thing on the page, because it blocks saving a lineup. The drop
          buttons live in the injury reserve section rather than being repeated
          here — two copies of a destructive control is how someone releases a
          player twice. */}
      {returnedPlayer && overBy > 0 ? (
        <div className="notice notice-error">
          <p className="text-sm">
            <strong>{returnedPlayer.display_name}</strong> is fit again and has taken his
            roster place back, so you&apos;re{" "}
            {overBy === 1 ? "one player" : `${overBy} players`} over the limit.{" "}
            <strong>You can&apos;t save a lineup until you drop someone.</strong>
          </p>
          <p className="mt-2">
            <a href="#injury-reserve" className="btn btn-ghost btn-sm">
              Choose who to drop
            </a>
          </p>
        </div>
      ) : null}

      {/* Only shown when there is genuinely something to do: a gameweek that has
          started but still holds one of your players whose match hasn't. In an
          ordinary week this is absent entirely. */}
      {open.length > 0 && !editingPast ? (
        <div className="notice">
          <p className="text-sm">
            {openGameweekNumbers.length === 1
              ? `Gameweek ${openGameweekNumbers[0]} is still open.`
              : `Gameweeks ${openGameweekNumbers.join(", ")} are still open.`}{" "}
            {open.length === 1
              ? `${open[0].display_name} hasn't played their match yet`
              : `${open.length} of your players haven't played their matches yet`}
            , so you can still change {open.length === 1 ? "that slot" : "those slots"}.
          </p>
          <p className="mt-2 flex flex-wrap gap-2">
            {openGameweekNumbers.map((number) => (
              <Link
                key={number}
                href={`/leagues/${league.id}/team?gw=${number}`}
                className="btn btn-ghost btn-sm"
              >
                Edit gameweek {number}
              </Link>
            ))}
          </p>
        </div>
      ) : null}

      {editingPast && gameweek ? (
        <div className="notice">
          <p className="text-sm">
            Editing <strong>gameweek {gameweek.number}</strong>, which has already started.
            Only players whose match is still to come can be moved — everyone else is
            locked, and the captain is fixed. Points from a deferred match count towards
            gameweek {gameweek.number}, so this matchup&apos;s result can still change.
          </p>
          <p className="mt-2">
            <Link href={`/leagues/${league.id}/team`} className="btn btn-ghost btn-sm">
              Back to the current gameweek
            </Link>
          </p>
        </div>
      ) : null}

      {/* The pitch is populated from the last saved lineup, so this text is
          what stops a filled-in pitch reading as a saved one. With carry-forward
          on it genuinely is what will happen; with it off, it is only a
          suggestion, and the difference is worth a sentence. */}
      {/* The pitch header says whether anything is saved. This says what happens
          if it stays that way, which is a different question and the one that
          actually costs points. */}
      {gameweek && !lineup ? (
        <p className="text-sm muted">
          {league.carry_forward_lineups
            ? prefilled
              ? `If you don't save, your gameweek ${previousNumber} lineup carries over as it stands.`
              : "If you don't set one, last week's lineup carries over."
            : "Without a saved lineup you'll score nothing this week."}
          {dropped > 0
            ? ` ${
                dropped === 1 ? "One place is" : `${dropped} places are`
              } empty: those players have either left your squad or already kicked off.`
            : ""}
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
            initialFormation={source?.formation ?? "4-4-2"}
            initialStarters={starterIds}
            initialCaptain={captainId ?? null}
            initialVice={viceId ?? null}
            gameweekNumber={gameweek.number}
            teamName={team.name}
            leagueId={league.id}
            deadlineLabel={formatDeadline(gameweek.deadline_at)}
            savedLabel={savedAgo(lineup?.updated_at)}
            prefilled={prefilled}
          />
        </form>
      )}

      {/* Below the pitch rather than on it. Reserving somebody is roster
          management, not team selection — it happens once a month, and it
          shouldn't compete for attention with the XI. */}
      {league.status === "active" ? (
        <InjuryReserve
          leagueId={league.id}
          reserved={reservedPlayer ? entryOf(reservedPlayer) : null}
          returned={returnedPlayer ? entryOf(returnedPlayer) : null}
          eligible={eligibleToReserve}
          overBy={overBy}
          droppable={players.map(entryOf)}
        />
      ) : null}
    </main>
  );
}
