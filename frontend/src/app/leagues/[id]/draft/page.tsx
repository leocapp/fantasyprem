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

const POSITION_STYLES: Record<string, string> = {
  GK: "bg-amber-500/15 text-amber-300",
  DEF: "bg-sky-500/15 text-sky-300",
  MID: "bg-emerald-500/15 text-emerald-300",
  FWD: "bg-rose-500/15 text-rose-300",
};

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
    .select("id, name, status, roster_size")
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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8 pt-16">
      <DraftRealtime leagueId={league.id} />

      <div className="flex items-baseline justify-between">
        <div>
          <Link href={`/leagues/${league.id}`} className="text-sm text-slate-500 hover:text-slate-300">
            ← {league.name}
          </Link>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Draft room</h1>
        </div>
        <span className="text-sm text-slate-500">
          {madePicks.length} of {picks?.length ?? 0} picks
        </span>
      </div>

      {filters.error ? (
        <p className="rounded-md border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {filters.error}
        </p>
      ) : null}

      <section
        className={`rounded-lg border p-5 ${
          myTurn ? "border-emerald-600 bg-emerald-950/20" : "border-slate-700 bg-slate-900/50"
        }`}
      >
        {isComplete ? (
          <p className="font-medium text-emerald-400">Draft complete.</p>
        ) : (
          <>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              On the clock
            </h2>
            <p className="mt-1 text-xl font-semibold">
              {onTheClock?.name}
              {myTurn ? " — that's you" : ""}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Round {nextPick?.round} · pick {nextPick?.overall_pick}
            </p>
          </>
        )}
      </section>

      {!isComplete ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Available players
            </h2>
            {!myTurn ? <span className="text-xs text-slate-600">Waiting for your turn</span> : null}
          </div>

          <form className="mt-3 flex flex-wrap gap-2" suppressHydrationWarning>
            <input
              name="q"
              defaultValue={search}
              placeholder="Search name"
              suppressHydrationWarning
              className="min-w-[10rem] flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
            />
            <select
              name="position"
              defaultValue={position ?? ""}
              suppressHydrationWarning
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
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
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500"
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

          <p className="mt-3 text-sm text-slate-500">
            {totalAvailable} available
            {lastPage > 1 ? ` · page ${page} of ${lastPage}` : ""}
          </p>

          <ul className="mt-2 divide-y divide-slate-800 rounded-lg border border-slate-800">
            {players?.map((player) => (
              <li key={player.id} className="flex items-center gap-3 px-4 py-2">
                <PlayerAvatar src={player.photo_url} name={player.display_name} />
                <span
                  className={`w-11 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${
                    POSITION_STYLES[player.position] ?? "bg-slate-700 text-slate-300"
                  }`}
                >
                  {player.position}
                </span>
                <span className="flex-1 font-medium">{player.display_name}</span>
                <span className="text-sm text-slate-500">{player.clubs?.short_name ?? "—"}</span>
                <form action={makePick}>
                  <input type="hidden" name="league_id" value={league.id} />
                  <input type="hidden" name="player_id" value={player.id} />
                  <input type="hidden" name="return_query" value={returnQuery} />
                  <button
                    disabled={!myTurn}
                    className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600"
                  >
                    Draft
                  </button>
                </form>
              </li>
            ))}
            {players?.length === 0 ? (
              <li className="px-4 py-6 text-center text-sm text-slate-500">
                No available players match that.
              </li>
            ) : null}
          </ul>

          {lastPage > 1 ? (
            <div className="mt-3 flex items-center justify-between text-sm">
              {page > 1 ? (
                <Link href={pageHref(page - 1)} className="text-slate-400 hover:text-slate-200">
                  ← Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="text-xs text-slate-600">
                {page} / {lastPage}
              </span>
              {page < lastPage ? (
                <Link href={pageHref(page + 1)} className="text-slate-400 hover:text-slate-200">
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
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Your roster ({myRoster.length}/{league.roster_size})
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {myRoster.map((pick) => (
              <li key={pick.id} className="flex gap-2">
                <span className="w-9 text-slate-600">{pick.players?.position}</span>
                <span>{pick.players?.display_name}</span>
              </li>
            ))}
            {myRoster.length === 0 ? <li className="text-slate-600">No picks yet.</li> : null}
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            Recent picks
          </h2>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {madePicks
              .slice(-10)
              .reverse()
              .map((pick) => (
                <li key={pick.id} className="flex gap-2">
                  <span className="w-8 font-mono text-xs text-slate-600">
                    {pick.overall_pick}
                  </span>
                  <span className="flex-1">{pick.players?.display_name}</span>
                  <span className="text-slate-600">
                    {teamsById.get(pick.fantasy_team_id)?.name}
                  </span>
                </li>
              ))}
            {madePicks.length === 0 ? <li className="text-slate-600">Nobody has picked.</li> : null}
          </ul>
        </section>
      </div>
    </main>
  );
}
