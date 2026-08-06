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
  players: { display_name: string; position: string } | null;
};

type PlayerRow = {
  id: string;
  display_name: string;
  position: string;
  photo_url: string | null;
  availability: string | null;
  news: string | null;
  chance_of_playing: number | null;
  ep_next: number | null;
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
    .select("player_id, players (display_name, position)")
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
    .from("clubs")
    .select("id, name")
    .order("name")
    .returns<{ id: string; name: string }[]>();

  let query = supabase
    .from("players")
    .select(
      "id, display_name, position, photo_url, availability, news, chance_of_playing, ep_next, clubs (short_name)",
      { count: "exact" },
    )
    .eq("is_active", true);

  if (ownedIds.length > 0) query = query.not("id", "in", `(${ownedIds.join(",")})`);
  if (search) query = query.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  if (position) query = query.eq("position", position);
  if (filters.club) query = query.eq("club_id", filters.club);

  // Best available first — that's what you're here for.
  const sort = filters.sort === "name" ? "name" : "projected";

  query =
    sort === "name"
      ? query.order("display_name")
      : query.order("ep_next", { ascending: false, nullsFirst: false });

  const offset = (page - 1) * PAGE_SIZE;
  const { data: players, count } = await query
    .range(offset, offset + PAGE_SIZE - 1)
    .returns<PlayerRow[]>();

  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const queryFor = (targetPage: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (position) next.set("position", position);
    if (filters.club) next.set("club", filters.club);
    if (sort !== "projected") next.set("sort", sort);
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
          <option value="projected">Projected</option>
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
                  chance={player.chance_of_playing}
                />
              </span>
              <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
              <span
                className="numeric w-10 text-right text-sm"
                title="FPL's projected points for the next gameweek, on their scoring rules"
              >
                {player.ep_next ?? "–"}
              </span>

              <form action={swapPlayer} className="flex items-center gap-2">
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
