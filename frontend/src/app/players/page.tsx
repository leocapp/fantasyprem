import Link from "next/link";
import { redirect } from "next/navigation";

import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

type PlayerRow = {
  id: string;
  display_name: string;
  position: string;
  shirt_number: number | null;
  photo_url: string | null;
  clubs: { short_name: string; name: string } | null;
};

type ClubOption = { id: string; name: string; short_name: string };

type MembershipRow = {
  leagues: { id: string; name: string } | null;
};

type OwnerRow = {
  player_id: string;
  fantasy_teams: { id: string; name: string } | null;
};

type SearchParams = Promise<{
  q?: string;
  position?: string;
  club?: string;
  page?: string;
  league?: string;
  owner?: string;
}>;

const PAGE_SIZE = 50;
const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

export const dynamic = "force-dynamic";

export default async function PlayersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("leagues (id, name)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  const myLeagues = (memberships ?? [])
    .map((row) => row.leagues)
    .filter((row): row is NonNullable<MembershipRow["leagues"]> => Boolean(row));

  // Ownership only means something inside a league, so pick one: the requested
  // league, otherwise the only one they're in.
  const activeLeagueId =
    myLeagues.find((row) => row.id === params.league)?.id ??
    (myLeagues.length === 1 ? myLeagues[0].id : undefined);

  const { data: owners } = activeLeagueId
    ? await supabase
        .from("roster_entries")
        .select("player_id, fantasy_teams (id, name)")
        .eq("league_id", activeLeagueId)
        .is("dropped_at", null)
        .returns<OwnerRow[]>()
    : { data: null };

  const ownerBy = new Map(
    (owners ?? []).map((row) => [row.player_id, row.fantasy_teams?.name ?? "Taken"]),
  );
  const ownedIds = (owners ?? []).map((row) => row.player_id);

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const position = POSITIONS.includes(params.position as (typeof POSITIONS)[number])
    ? params.position
    : undefined;
  // Commas and parentheses are syntax in PostgREST's or() filter, so strip them.
  const search = (params.q ?? "").replace(/[,()]/g, "").trim();
  const ownerFilter = params.owner === "free" || params.owner === "taken" ? params.owner : undefined;

  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, name, short_name")
    .order("name")
    .returns<ClubOption[]>();

  let query = supabase
    .from("players")
    .select("id, display_name, position, shirt_number, photo_url, clubs (short_name, name)", {
      count: "exact",
    })
    .eq("is_active", true);

  if (search) {
    query = query.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  }
  if (position) query = query.eq("position", position);
  if (params.club) query = query.eq("club_id", params.club);

  if (activeLeagueId && ownedIds.length > 0) {
    if (ownerFilter === "free") query = query.not("id", "in", `(${ownedIds.join(",")})`);
    if (ownerFilter === "taken") query = query.in("id", ownedIds);
  }

  const from = (page - 1) * PAGE_SIZE;
  const {
    data: players,
    count,
    error,
  } = await query
    .order("display_name")
    .range(from, from + PAGE_SIZE - 1)
    .returns<PlayerRow[]>();

  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const pageHref = (target: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (position) next.set("position", position);
    if (params.club) next.set("club", params.club);
    if (activeLeagueId) next.set("league", activeLeagueId);
    if (ownerFilter) next.set("owner", ownerFilter);
    if (target > 1) next.set("page", String(target));
    const value = next.toString();
    return value ? `/players?${value}` : "/players";
  };

  return (
    <main className="page">
      <div>
        <h1 className="page-title">Players</h1>
        {activeLeagueId ? (
          <p className="page-subtitle">
            Showing ownership in {myLeagues.find((row) => row.id === activeLeagueId)?.name}.
          </p>
        ) : null}
      </div>

      <form className="flex flex-wrap gap-2" suppressHydrationWarning>
        <input
          name="q"
          defaultValue={search}
          placeholder="Search name"
          className="input min-w-[12rem] flex-1"
          suppressHydrationWarning
        />
        <select
          name="position"
          defaultValue={position ?? ""}
          className="select"
          suppressHydrationWarning
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
          defaultValue={params.club ?? ""}
          className="select"
          suppressHydrationWarning
        >
          <option value="">All clubs</option>
          {clubs?.map((club) => (
            <option key={club.id} value={club.id}>
              {club.name}
            </option>
          ))}
        </select>

        {myLeagues.length > 1 ? (
          <select
            name="league"
            defaultValue={activeLeagueId ?? ""}
            className="select"
            suppressHydrationWarning
          >
            <option value="">No league</option>
            {myLeagues.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        ) : activeLeagueId ? (
          <input type="hidden" name="league" value={activeLeagueId} />
        ) : null}

        {activeLeagueId ? (
          <select
            name="owner"
            defaultValue={ownerFilter ?? ""}
            className="select"
            suppressHydrationWarning
          >
            <option value="">Everyone</option>
            <option value="free">Free agents</option>
            <option value="taken">Rostered</option>
          </select>
        ) : null}

        <button className="btn btn-ghost">Filter</button>
      </form>

      {error ? <p className="notice notice-error">{error.message}</p> : null}

      <p className="text-sm dim">
        {total} {total === 1 ? "player" : "players"}
        {total > PAGE_SIZE ? ` · page ${page} of ${lastPage}` : ""}
      </p>

      <ul className="list">
        {players?.map((player) => {
          const owner = ownerBy.get(player.id);

          return (
            <li key={player.id} className="row">
              <PlayerAvatar src={player.photo_url} name={player.display_name} />
              <span className={`badge badge-${player.position}`}>{player.position}</span>
              <span className="flex-1 truncate font-medium">{player.display_name}</span>
              <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
              {activeLeagueId ? (
                <span
                  className={`w-24 truncate text-right text-xs ${owner ? "muted" : "dim"}`}
                  title={owner ?? "Free agent"}
                >
                  {owner ?? "free agent"}
                </span>
              ) : (
                <span className="numeric w-8 text-right text-xs dim">
                  {player.shirt_number ?? ""}
                </span>
              )}
            </li>
          );
        })}
        {players?.length === 0 ? (
          <li className="row justify-center py-6 text-sm dim">No players match that.</li>
        ) : null}
      </ul>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between text-sm">
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
    </main>
  );
}
