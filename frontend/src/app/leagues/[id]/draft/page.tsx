import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

import DraftRealtime from "./DraftRealtime";
import { makePick } from "./actions";

type LeagueDetail = {
  id: string;
  name: string;
  status: string;
  roster_size: number;
  slots_gk: number;
  slots_def: number;
  slots_mid: number;
  slots_fwd: number;
};

type TeamRow = { id: string; name: string; owner_id: string; draft_position: number | null };

type PickRow = {
  id: string;
  round: number;
  overall_pick: number;
  fantasy_team_id: string;
  player_id: string | null;
  players: { display_name: string; position: string } | null;
};

type PlayerRow = {
  id: string;
  display_name: string;
  position: string;
  photo_url: string | null;
  clubs: { short_name: string } | null;
};

type SearchParams = Promise<{
  q?: string;
  position?: string;
  club?: string;
  page?: string;
  error?: string;
}>;

type ClubOption = { id: string; name: string };

const PAGE_SIZE = 50;
const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export const dynamic = "force-dynamic";

export default async function DraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status, roster_size, slots_gk, slots_def, slots_mid, slots_fwd")
    .eq("id", id)
    .maybeSingle<LeagueDetail>();

  if (!league) notFound();
  if (league.status === "setup") redirect(`/leagues/${id}`);

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, draft_position")
    .eq("league_id", id)
    .order("draft_position")
    .returns<TeamRow[]>();

  const { data: picks } = await supabase
    .from("draft_picks")
    .select("id, round, overall_pick, fantasy_team_id, player_id, players (display_name, position)")
    .eq("league_id", id)
    .order("overall_pick")
    .returns<PickRow[]>();

  const teamsById = new Map((teams ?? []).map((team) => [team.id, team]));
  const myTeam = teams?.find((team) => team.owner_id === user.id);

  const madePicks = (picks ?? []).filter((pick) => pick.player_id);
  const nextPick = (picks ?? []).find((pick) => !pick.player_id);
  const onTheClock = nextPick ? teamsById.get(nextPick.fantasy_team_id) : undefined;
  const myTurn = Boolean(myTeam && nextPick && nextPick.fantasy_team_id === myTeam.id);

  const takenIds = madePicks.map((pick) => pick.player_id as string);

  const search = (filters.q ?? "").replace(/[,()]/g, "").trim();
  const position = POSITIONS.includes(filters.position as (typeof POSITIONS)[number])
    ? filters.position
    : undefined;

  const page = Math.max(1, Number(filters.page ?? 1) || 1);

  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, name")
    .order("name")
    .returns<ClubOption[]>();

  let available = supabase
    .from("players")
    .select("id, display_name, position, photo_url, clubs (short_name)", { count: "exact" })
    .eq("is_active", true);

  if (takenIds.length > 0) {
    available = available.not("id", "in", `(${takenIds.join(",")})`);
  }
  if (search) {
    available = available.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  }
  if (position) {
    available = available.eq("position", position);
  }
  if (filters.club) {
    available = available.eq("club_id", filters.club);
  }

  const offset = (page - 1) * PAGE_SIZE;
  const { data: players, count: availableCount } = await available
    .order("display_name")
    .range(offset, offset + PAGE_SIZE - 1)
    .returns<PlayerRow[]>();

  const totalAvailable = availableCount ?? 0;
  const lastPage = Math.max(1, Math.ceil(totalAvailable / PAGE_SIZE));

  const myRoster = madePicks.filter((pick) => pick.fantasy_team_id === myTeam?.id);

  // Squad slots. The database enforces these too — this only saves a round trip.
  const slotLimits: Record<string, number> = {
    GK: league.slots_gk,
    DEF: league.slots_def,
    MID: league.slots_mid,
    FWD: league.slots_fwd,
  };

  const slotsUsed: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pick of myRoster) {
    const position = pick.players?.position;
    if (position && position in slotsUsed) slotsUsed[position] += 1;
  }

  const positionFull = (position: string) =>
    (slotsUsed[position] ?? 0) >= (slotLimits[position] ?? Infinity);

  const queryFor = (targetPage: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (position) next.set("position", position);
    if (filters.club) next.set("club", filters.club);
    if (targetPage > 1) next.set("page", String(targetPage));
    const value = next.toString();
    return value ? `?${value}` : "";
  };

  // Picking returns you to the page and filters you were browsing.
  const returnQuery = queryFor(page);
  const pageHref = (targetPage: number) =>
    `/leagues/${league.id}/draft${queryFor(targetPage)}`;

  const isComplete = !nextPick;

  return (
    <main className="page">
      <DraftRealtime leagueId={league.id} />

      <div className="flex items-baseline justify-between gap-4">
        <h1 className="page-title">Draft room</h1>
        <span className="numeric text-sm dim">
          {madePicks.length} / {picks?.length ?? 0} picks
        </span>
      </div>

      {filters.error ? <p className="notice notice-error">{filters.error}</p> : null}

      <section className={`card ${myTurn ? "card-accent" : ""}`}>
        {isComplete ? (
          <p className="font-medium" style={{ color: "var(--accent-hover)" }}>
            Draft complete.
          </p>
        ) : (
          <>
            <h2 className="section-label">On the clock</h2>
            <p className="mt-1 text-xl font-semibold">
              {onTheClock?.name}
              {myTurn ? " — that's you" : ""}
            </p>
            <p className="mt-1 text-sm dim">
              Round {nextPick?.round} · pick {nextPick?.overall_pick}
            </p>
          </>
        )}
      </section>

      {!isComplete ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="section-label">Available players</h2>
            {!myTurn ? <span className="text-xs dim">Waiting for your turn</span> : null}
          </div>

          <form className="mt-3 flex flex-wrap gap-2" suppressHydrationWarning>
            <input
              name="q"
              defaultValue={search}
              placeholder="Search name"
              suppressHydrationWarning
              className="input min-w-[10rem] flex-1"
            />
            <select
              name="position"
              defaultValue={position ?? ""}
              suppressHydrationWarning
              className="select"
            >
              <option value="">All positions</option>
              {POSITIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              name="club"
              defaultValue={filters.club ?? ""}
              suppressHydrationWarning
              className="select"
            >
              <option value="">All clubs</option>
              {clubs?.map((club) => (
                <option key={club.id} value={club.id}>
                  {club.name}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost">Filter</button>
          </form>

          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="dim">
              {totalAvailable} available
              {lastPage > 1 ? ` · page ${page} of ${lastPage}` : ""}
            </span>
            <span className="numeric flex gap-3 text-xs">
              {POSITIONS.map((value) => (
                <span key={value} className={positionFull(value) ? "dim line-through" : "muted"}>
                  {value} {slotsUsed[value]}/{slotLimits[value]}
                </span>
              ))}
            </span>
          </div>

          <ul className="list mt-2">
            {players?.map((player) => (
              <li key={player.id} className="row">
                <PlayerAvatar src={player.photo_url} name={player.display_name} />
                <span className={`badge badge-${player.position}`}>{player.position}</span>
                <span className="flex-1 truncate font-medium">{player.display_name}</span>
                <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
                <form action={makePick}>
                  <input type="hidden" name="league_id" value={league.id} />
                  <input type="hidden" name="player_id" value={player.id} />
                  <input type="hidden" name="return_query" value={returnQuery} />
                  <button
                    disabled={!myTurn || positionFull(player.position)}
                    title={
                      positionFull(player.position)
                        ? `Your ${player.position} slots are full`
                        : undefined
                    }
                    className="btn btn-primary btn-sm"
                  >
                    Draft
                  </button>
                </form>
              </li>
            ))}
            {players?.length === 0 ? (
              <li className="row justify-center py-6 text-sm dim">
                No available players match that.
              </li>
            ) : null}
          </ul>

          {lastPage > 1 ? (
            <div className="mt-3 flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="muted hover:text-[var(--text)]">
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="numeric text-xs dim">
                {page} / {lastPage}
              </span>
              {page < lastPage ? (
                <Link href={pageHref(page + 1)} className="muted hover:text-[var(--text)]">
                  Next →
                </Link>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <h2 className="section-label">
            Your roster ({myRoster.length}/{league.roster_size})
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {myRoster.map((pick) => (
              <li key={pick.id} className="flex gap-2">
                <span className="w-9 dim">{pick.players?.position}</span>
                <span className="truncate">{pick.players?.display_name}</span>
              </li>
            ))}
            {myRoster.length === 0 ? <li className="dim">No picks yet.</li> : null}
          </ul>
        </section>

        <section>
          <h2 className="section-label">Recent picks</h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {madePicks
              .slice(-10)
              .reverse()
              .map((pick) => (
                <li key={pick.id} className="flex gap-2">
                  <span className="numeric w-8 text-xs dim">{pick.overall_pick}</span>
                  <span className="flex-1 truncate">{pick.players?.display_name}</span>
                  <span className="truncate dim">{teamsById.get(pick.fantasy_team_id)?.name}</span>
                </li>
              ))}
            {madePicks.length === 0 ? <li className="dim">Nobody has picked.</li> : null}
          </ul>
        </section>
      </div>
    </main>
  );
}
