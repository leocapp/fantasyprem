import Link from "next/link";
import { notFound, redirect } from "next/navigation";

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
  clubs: { short_name: string } | null;
};

type SearchParams = Promise<{
  q?: string;
  position?: string;
  club?: string;
  page?: string;
  error?: string;
  message?: string;
}>;

const PAGE_SIZE = 25;
const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

const POSITION_STYLES: Record<string, string> = {
  GK: "bg-amber-500/15 text-amber-300",
  DEF: "bg-sky-500/15 text-sky-300",
  MID: "bg-emerald-500/15 text-emerald-300",
  FWD: "bg-rose-500/15 text-rose-300",
};

const controlClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500";

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
    .select("id, display_name, position, photo_url, clubs (short_name)", { count: "exact" })
    .eq("is_active", true);

  if (ownedIds.length > 0) query = query.not("id", "in", `(${ownedIds.join(",")})`);
  if (search) query = query.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  if (position) query = query.eq("position", position);
  if (filters.club) query = query.eq("club_id", filters.club);

  const offset = (page - 1) * PAGE_SIZE;
  const { data: players, count } = await query
    .order("display_name")
    .range(offset, offset + PAGE_SIZE - 1)
    .returns<PlayerRow[]>();

  const total = count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const queryFor = (targetPage: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (position) next.set("position", position);
    if (filters.club) next.set("club", filters.club);
    if (targetPage > 1) next.set("page", String(targetPage));
    const value = next.toString();
    return value ? `?${value}` : "";
  };

  const returnQuery = queryFor(page);

  const myPlayersByPosition = (target: string) =>
    (roster ?? []).filter((row) => row.players?.position === target);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8 pt-16">
      <div>
        <Link href={`/leagues/${league.id}`} className="text-sm text-slate-500 hover:text-slate-300">
          ← {league.name}
        </Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Free agents</h1>
        <p className="mt-1 text-sm text-slate-400">
          Swaps are like for like — drop a midfielder to add a midfielder.
        </p>
      </div>

      {filters.error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {filters.error}
        </p>
      ) : null}
      {filters.message ? (
        <p className="rounded-md border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {filters.message}
        </p>
      ) : null}

      <form className="flex flex-wrap gap-2" suppressHydrationWarning>
        <input
          name="q"
          defaultValue={search}
          placeholder="Search name"
          suppressHydrationWarning
          className={`${controlClass} min-w-[10rem] flex-1`}
        />
        <select
          name="position"
          defaultValue={position ?? ""}
          suppressHydrationWarning
          className={controlClass}
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
          className={controlClass}
        >
          <option value="">All clubs</option>
          {clubs?.map((club) => (
            <option key={club.id} value={club.id}>
              {club.name}
            </option>
          ))}
        </select>
        <button className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-slate-400">
          Filter
        </button>
      </form>

      <p className="text-sm text-slate-500">
        {total} available{lastPage > 1 ? ` · page ${page} of ${lastPage}` : ""}
      </p>

      <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {players?.map((player) => {
          const candidates = myPlayersByPosition(player.position);

          return (
            <li key={player.id} className="flex items-center gap-3 px-4 py-2">
              <PlayerAvatar src={player.photo_url} name={player.display_name} />
              <span
                className={`w-11 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${
                  POSITION_STYLES[player.position] ?? "bg-slate-700 text-slate-300"
                }`}
              >
                {player.position}
              </span>
              <span className="flex-1 truncate font-medium">{player.display_name}</span>
              <span className="text-sm text-slate-500">{player.clubs?.short_name ?? "—"}</span>

              <form action={swapPlayer} className="flex items-center gap-2">
                <input type="hidden" name="league_id" value={league.id} />
                <input type="hidden" name="add_player_id" value={player.id} />
                <input type="hidden" name="return_query" value={returnQuery} />
                <select
                  name="drop_player_id"
                  defaultValue=""
                  suppressHydrationWarning
                  className="max-w-[9rem] rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-slate-500"
                >
                  <option value="">Drop…</option>
                  {candidates.map((row) => (
                    <option key={row.player_id} value={row.player_id}>
                      {row.players?.display_name}
                    </option>
                  ))}
                </select>
                <button
                  disabled={league.status !== "active" || candidates.length === 0}
                  className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
                >
                  Swap
                </button>
              </form>
            </li>
          );
        })}
        {players?.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-slate-500">
            No free agents match that.
          </li>
        ) : null}
      </ul>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={`/leagues/${league.id}/free-agents${queryFor(page - 1)}`}
              className="text-slate-400 hover:text-slate-200"
            >
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {page < lastPage ? (
            <Link
              href={`/leagues/${league.id}/free-agents${queryFor(page + 1)}`}
              className="text-slate-400 hover:text-slate-200"
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
