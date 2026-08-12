import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import AvailabilityFlag from "@/components/AvailabilityFlag";
import AvailabilityKey from "@/components/AvailabilityKey";
import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

import { swapPlayer } from "./actions";

type LeagueRow = { id: string; name: string; status: string };
type TeamRow = { id: string; name: string };

type RosterRow = {
  player_id: string;
  players: { display_name: string; position: string; is_active: boolean } | null;
};

type PlayerRow = {
  id: string;
  display_name: string;
  position: string;
  photo_url: string | null;
  availability: string | null;
  news: string | null;
  expected_return: string | null;
  clubs: { short_name: string } | null;
};

type SearchParams = Promise<{
  q?: string;
  position?: string;
  club?: string;
  page?: string;
  sort?: string;
  error?: string;
  message?: string;
}>;

const PAGE_SIZE = 25;
const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;
const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

const COLUMN_HELP: Record<string, string> = {
  points: "Points this season, under this league's scoring rules",
  last: "Points last season, rescored under this league's rules",
  projected: "Projected points for the next gameweek, under this league's rules",
  name: "",
};

export const dynamic = "force-dynamic";

export default async function FreeAgentsPage({
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
    .select("id, name, status")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: team } = await supabase
    .from("fantasy_teams")
    .select("id, name")
    .eq("league_id", id)
    .eq("owner_id", user.id)
    .maybeSingle<TeamRow>();

  if (!team) notFound();

  const { data: roster } = await supabase
    .from("roster_entries")
    .select("player_id, players (display_name, position, is_active)")
    .eq("fantasy_team_id", team.id)
    .is("dropped_at", null)
    .returns<RosterRow[]>();

  // Everyone already owned in this league is off the market.
  const { data: owned } = await supabase
    .from("roster_entries")
    .select("player_id")
    .eq("league_id", id)
    .is("dropped_at", null)
    .returns<{ player_id: string }[]>();

  const ownedIds = (owned ?? []).map((row) => row.player_id);

  const page = Math.max(1, Number(filters.page ?? 1) || 1);
  const search = (filters.q ?? "").replace(/[,()]/g, "").trim();
  const position = POSITIONS.includes(filters.position as (typeof POSITIONS)[number])
    ? filters.position
    : undefined;

  const { data: clubs } = await supabase
    .from("current_clubs")
    .select("id, name")
    .order("name")
    .returns<{ id: string; name: string }[]>();

  let query = supabase
    .from("players")
    .select(
      "id, display_name, position, photo_url, availability, news, expected_return, clubs (short_name)",
      { count: "exact" },
    )
    .eq("is_active", true);

  if (ownedIds.length > 0) query = query.not("id", "in", `(${ownedIds.join(",")})`);
  if (search) query = query.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  if (position) query = query.eq("position", position);
  if (filters.club) query = query.eq("club_id", filters.club);

  // The next gameweek still to be played, for the projection sort.
  const { data: nextGameweek } = await supabase
    .from("gameweeks")
    .select("id, number")
    .neq("status", "complete")
    .order("number")
    .limit(1)
    .maybeSingle<{ id: string; number: number }>();

  // None of these can be ordered by PostgREST — they all live in other tables
  // or come from a function — so the candidates are fetched whole and sorted
  // here. A few hundred rows, once.
  const [{ data: candidates, count }, { data: earned }, { data: lastSeason }, { data: projected }] =
    await Promise.all([
      query.order("display_name").limit(1000).returns<PlayerRow[]>(),

      supabase
        .from("player_league_season_points")
        .select("player_id, total_points")
        .eq("league_id", id)
        .order("total_points", { ascending: false })
        .limit(1000)
        .returns<{ player_id: string; total_points: number }[]>(),

      // Last season scored under THIS league's rules, which is what the draft
      // board ranks on — not a raw goal count.
      supabase
        .from("draft_values")
        .select("player_id, points")
        .eq("league_id", id)
        .limit(2000)
        .returns<{ player_id: string; points: number }[]>(),

      nextGameweek
        ? supabase.rpc("projected_points_for_league", {
            p_league_id: id,
            p_gameweek_id: nextGameweek.id,
          })
        : Promise.resolve({ data: [] }),
    ]);

  const pointsBy = new Map((earned ?? []).map((row) => [row.player_id, Number(row.total_points)]));
  const lastSeasonBy = new Map(
    (lastSeason ?? []).map((row) => [row.player_id, Number(row.points)]),
  );
  const projectedBy = new Map(
    ((projected ?? []) as { player_id: string; points: number | null }[]).map((row) => [
      row.player_id,
      row.points === null ? null : Number(row.points),
    ]),
  );

  // Before a ball is kicked nobody has scored, so defaulting to this season's
  // points would sort the whole list by zero. Fall back to last season until
  // there is something to rank on.
  const anyScored = (earned ?? []).some((row) => Number(row.total_points) !== 0);
  const fallback = anyScored ? "points" : "last";

  const SORTS = ["points", "last", "projected", "name"] as const;
  type Sort = (typeof SORTS)[number];
  const sort: Sort = SORTS.includes(filters.sort as Sort) ? (filters.sort as Sort) : fallback;

  const valueFor = (playerId: string): number | null => {
    if (sort === "last") return lastSeasonBy.get(playerId) ?? null;
    if (sort === "projected") return projectedBy.get(playerId) ?? null;
    return pointsBy.get(playerId) ?? null;
  };

  const sorted = (candidates ?? []).slice().sort((a, b) => {
    if (sort === "name") return a.display_name.localeCompare(b.display_name);
    // No figure at all sorts below a genuine zero: someone who played and
    // scored nothing is a different proposition from someone with no history.
    return (valueFor(b.id) ?? -1) - (valueFor(a.id) ?? -1);
  });

  // Named rather than counted vaguely: "47 have no record" invites the
  // question this note exists to answer.
  const withoutHistory = (candidates ?? []).filter(
    (player) => !lastSeasonBy.has(player.id),
  ).length;

  const offset = (page - 1) * PAGE_SIZE;
  const players = sorted.slice(offset, offset + PAGE_SIZE);

  const total = count ?? sorted.length;
  const lastPage = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));

  const queryFor = (targetPage: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (position) next.set("position", position);
    if (filters.club) next.set("club", filters.club);
    if (sort !== fallback) next.set("sort", sort);
    if (targetPage > 1) next.set("page", String(targetPage));
    const value = next.toString();
    return value ? `?${value}` : "";
  };

  const returnQuery = queryFor(page);

  // Any player can be dropped now — the database checks whether the resulting
  // squad still meets its minimums.
  const myPlayers = (roster ?? [])
    .slice()
    .sort(
      (a, b) =>
        (POSITION_ORDER[a.players?.position ?? ""] ?? 9) -
          (POSITION_ORDER[b.players?.position ?? ""] ?? 9) ||
        (a.players?.display_name ?? "").localeCompare(b.players?.display_name ?? ""),
    );

  return (
    <main className="page">
      <div>
        <h1 className="page-title">Free agents</h1>
        <p className="page-subtitle">
          Drop anyone for anyone, as long as your squad still meets its position minimums.
        </p>
      </div>

      {filters.error ? <p className="notice notice-error">{filters.error}</p> : null}
      {filters.message ? <p className="notice notice-success">{filters.message}</p> : null}

      <form className="flex flex-wrap gap-2" suppressHydrationWarning>
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
        <select name="sort" defaultValue={sort} suppressHydrationWarning className="select">
          <option value="points">Points this season</option>
          <option value="last">Points last season</option>
          <option value="projected">
            {nextGameweek ? `Projected GW${nextGameweek.number}` : "Projected"}
          </option>
          <option value="name">Name</option>
        </select>
        <button className="btn btn-ghost">Filter</button>
      </form>

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-sm dim">
          {total} available{lastPage > 1 ? ` · page ${page} of ${lastPage}` : ""}
        </p>
        <AvailabilityKey />
      </div>

      {sort === "last" && withoutHistory > 0 ? (
        <p className="notice text-xs">
          {withoutHistory} of these have no last-season total. A dash means we hold no
          Premier League record for them — players at promoted clubs and signings from
          abroad — not that they scored nothing. Sort by projection to rank those too.
        </p>
      ) : null}

      {sort === "points" && !anyScored ? (
        <p className="notice text-xs">
          No gameweek has been scored yet, so every total here is zero.
        </p>
      ) : null}

      <ul className="list">
        {players?.map((player) => {
          return (
            <li key={player.id} className="row">
              <PlayerAvatar src={player.photo_url} name={player.display_name} />
              <span className={`badge badge-${player.position}`}>{player.position}</span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <Link
                  href={`/leagues/${league.id}/players/${player.id}`}
                  className="truncate font-medium hover:underline"
                >
                  {player.display_name}
                </Link>
                <AvailabilityFlag
                  availability={player.availability}
                  news={player.news}
                  expectedReturn={player.expected_return}
                />
              </span>
              <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
              <span
                className="numeric w-10 text-right text-sm"
                title={COLUMN_HELP[sort]}
              >
                {sort === "name" ? "" : (valueFor(player.id) ?? "–")}
              </span>

              {/* suppressHydrationWarning: browser autofill stamps signature
                  attributes onto any form it thinks it could fill. */}
              <form action={swapPlayer} className="flex items-center gap-2" suppressHydrationWarning>
                <input type="hidden" name="league_id" value={league.id} />
                <input type="hidden" name="add_player_id" value={player.id} />
                <input type="hidden" name="return_query" value={returnQuery} />
                <select
                  name="drop_player_id"
                  defaultValue=""
                  suppressHydrationWarning
                  className="select select-sm max-w-[9rem]"
                >
                  <option value="">Drop…</option>
                  {myPlayers.map((row) => (
                    <option key={row.player_id} value={row.player_id}>
                      {row.players?.position} {row.players?.display_name}
                      {row.players?.is_active === false ? " (left the league)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  disabled={league.status !== "active" || myPlayers.length === 0}
                  className="btn btn-primary btn-sm"
                >
                  Swap
                </button>
              </form>
            </li>
          );
        })}
        {players?.length === 0 ? (
          <li className="row justify-center py-6 text-sm dim">No free agents match that.</li>
        ) : null}
      </ul>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={`/leagues/${league.id}/free-agents${queryFor(page - 1)}`}
              className="muted hover:text-[var(--text)]"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="numeric text-xs dim">
            {page} / {lastPage}
          </span>
          {page < lastPage ? (
            <Link
              href={`/leagues/${league.id}/free-agents${queryFor(page + 1)}`}
              className="muted hover:text-[var(--text)]"
            >
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </main>
  );
}
