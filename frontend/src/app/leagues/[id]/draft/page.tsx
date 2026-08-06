import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import ManagerAvatar from "@/components/ManagerAvatar";
import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

import RealtimeRefresh from "@/components/RealtimeRefresh";

import { makePick } from "./actions";

type LeagueDetail = {
  id: string;
  name: string;
  status: string;
  roster_size: number;
  min_gk: number;
  min_def: number;
  min_mid: number;
  min_fwd: number;
};

type TeamRow = {
  id: string;
  name: string;
  owner_id: string;
  draft_position: number | null;
  profiles: { username: string | null; avatar_url: string | null } | null;
};

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
    .select("id, name, status, roster_size, min_gk, min_def, min_mid, min_fwd")
    .eq("id", id)
    .maybeSingle<LeagueDetail>();

  if (!league) notFound();
  if (league.status === "setup") redirect(`/leagues/${id}`);

  const { data: teams } = await supabase
    .from("fantasy_teams")
    .select("id, name, owner_id, draft_position, profiles (username, avatar_url)")
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

  // Squad minimums. The database enforces all of this too — mirroring it here
  // only saves a round trip and lets the button explain itself.
  const minimums: Record<string, number> = {
    GK: league.min_gk,
    DEF: league.min_def,
    MID: league.min_mid,
    FWD: league.min_fwd,
  };

  const held: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const pick of myRoster) {
    const position = pick.players?.position;
    if (position && position in held) held[position] += 1;
  }

  // A pick is legal only if the picks left afterwards can still cover every
  // unmet minimum.
  const positionBlocked = (position: string) => {
    const after = { ...held, [position]: (held[position] ?? 0) + 1 };
    const total = Object.values(after).reduce((sum, value) => sum + value, 0);
    const remaining = league.roster_size - total;
    const shortfall = POSITIONS.reduce(
      (sum, key) => sum + Math.max(0, minimums[key] - after[key]),
      0,
    );
    return shortfall > remaining;
  };

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
      {/* The draft is the one page where being seconds stale is costly, so it
          polls harder than the rest and says so when the socket drops. */}
      <RealtimeRefresh
        channel={`draft:${league.id}`}
        sources={[
          { table: "draft_picks", filter: `league_id=eq.${league.id}`, event: "UPDATE" },
          { table: "roster_entries", filter: `league_id=eq.${league.id}`, event: "INSERT" },
        ]}
        pollMs={isComplete ? 0 : 4000}
        showWhenDegraded={!isComplete}
      />

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
            <div className="mt-2 flex items-center gap-3">
              <ManagerAvatar
                src={onTheClock?.profiles?.avatar_url}
                username={onTheClock?.profiles?.username}
                size="md"
              />
              <div>
                <p className="text-xl font-semibold">
                  {onTheClock?.name}
                  {myTurn ? " — that's you" : ""}
                </p>
                {onTheClock?.profiles?.username ? (
                  <p className="text-sm dim">@{onTheClock.profiles.username}</p>
                ) : null}
              </div>
            </div>
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
                <span
                  key={value}
                  className={positionBlocked(value) ? "dim line-through" : "muted"}
                  title={`Minimum ${minimums[value]}`}
                >
                  {value} {held[value]}
                  <span className="dim">/{minimums[value]}</span>
                </span>
              ))}
            </span>
          </div>

          <ul className="list mt-2">
            {players?.map((player) => (
              <li key={player.id} className="row">
                <PlayerAvatar src={player.photo_url} name={player.display_name} />
                <span className={`badge badge-${player.position}`}>{player.position}</span>
                <Link
                  href={`/leagues/${league.id}/players/${player.id}`}
                  className="flex-1 truncate font-medium hover:underline"
                >
                  {player.display_name}
                </Link>
                <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
                <form action={makePick}>
                  <input type="hidden" name="league_id" value={league.id} />
                  <input type="hidden" name="player_id" value={player.id} />
                  <input type="hidden" name="return_query" value={returnQuery} />
                  <button
                    disabled={!myTurn || positionBlocked(player.position)}
                    title={
                      positionBlocked(player.position)
                        ? `Another ${player.position} would leave too few picks to meet your minimums`
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
                  <span className="truncate dim">
                    {teamsById.get(pick.fantasy_team_id)?.profiles?.username
                      ? `@${teamsById.get(pick.fantasy_team_id)?.profiles?.username}`
                      : teamsById.get(pick.fantasy_team_id)?.name}
                  </span>
                </li>
              ))}
            {madePicks.length === 0 ? <li className="dim">Nobody has picked.</li> : null}
          </ul>
        </section>
      </div>
    </main>
  );
}
