import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

type PlayerRow = {
  id: string;
  display_name: string;
  position: string;
  shirt_number: number | null;
  clubs: { short_name: string; name: string } | null;
};

type ClubOption = { id: string; name: string; short_name: string };

type SearchParams = Promise<{ q?: string; position?: string; club?: string; page?: string }>;

const PAGE_SIZE = 50;
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

export default async function PlayersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const position = POSITIONS.includes(params.position as (typeof POSITIONS)[number])
    ? params.position
    : undefined;
  // Commas and parentheses are syntax in PostgREST's or() filter, so strip them.
  const search = (params.q ?? "").replace(/[,()]/g, "").trim();

  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, name, short_name")
    .order("name")
    .returns<ClubOption[]>();

  let query = supabase
    .from("players")
    .select("id, display_name, position, shirt_number, clubs (short_name, name)", {
      count: "exact",
    })
    .eq("is_active", true);

  if (search) {
    query = query.or(`display_name.ilike.%${search}%,last_name.ilike.%${search}%`);
  }
  if (position) {
    query = query.eq("position", position);
  }
  if (params.club) {
    query = query.eq("club_id", params.club);
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
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/players?${query}` : "/players";
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8 pt-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Players</h1>
        <Link href="/dashboard" className="text-sm text-slate-500 hover:text-slate-300">
          Dashboard
        </Link>
      </div>

      <form className="flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={search}
          placeholder="Search name"
          className={`${controlClass} flex-1 min-w-[12rem]`}
        />

        <select name="position" defaultValue={position ?? ""} className={controlClass}>
          <option value="">All positions</option>
          {POSITIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>

        <select name="club" defaultValue={params.club ?? ""} className={controlClass}>
          <option value="">All clubs</option>
          {clubs?.map((club) => (
            <option key={club.id} value={club.id}>
              {club.name}
            </option>
          ))}
        </select>

        <button className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500">
          Filter
        </button>
      </form>

      {error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error.message}
        </p>
      ) : null}

      <p className="text-sm text-slate-500">
        {total} {total === 1 ? "player" : "players"}
        {total > PAGE_SIZE ? ` · page ${page} of ${lastPage}` : ""}
      </p>

      <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
        {players?.map((player) => (
          <li key={player.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={`w-11 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${
                POSITION_STYLES[player.position] ?? "bg-slate-700 text-slate-300"
              }`}
            >
              {player.position}
            </span>
            <span className="flex-1 font-medium">{player.display_name}</span>
            <span className="text-sm text-slate-500">{player.clubs?.short_name ?? "—"}</span>
            <span className="w-8 text-right font-mono text-xs text-slate-600">
              {player.shirt_number ?? ""}
            </span>
          </li>
        ))}
        {players?.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-slate-500">No players match that.</li>
        ) : null}
      </ul>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="text-slate-400 hover:text-slate-200">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {page < lastPage ? (
            <Link href={pageHref(page + 1)} className="text-slate-400 hover:text-slate-200">
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
