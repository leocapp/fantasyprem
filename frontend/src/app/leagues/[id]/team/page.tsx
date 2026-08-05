import { notFound, redirect } from "next/navigation";

import PlayerAvatar from "@/components/PlayerAvatar";
import { createClient } from "@/lib/supabase/server";

import { saveLineup } from "./actions";

type LeagueRow = {
  id: string;
  name: string;
  status: string;
  carry_forward_lineups: boolean;
};
type TeamRow = { id: string; name: string; owner_id: string };
type GameweekRow = { id: string; number: number; deadline_at: string };
type FormationRow = {
  code: string;
  defenders: number;
  midfielders: number;
  forwards: number;
};

type RosterRow = {
  player_id: string;
  players: {
    id: string;
    display_name: string;
    position: string;
    photo_url: string | null;
    clubs: { short_name: string } | null;
  } | null;
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

const POSITION_ORDER: Record<string, number> = { GK: 0, DEF: 1, MID: 2, FWD: 3 };
const POSITION_LABELS: Record<string, string> = {
  GK: "Goalkeepers",
  DEF: "Defenders",
  MID: "Midfielders",
  FWD: "Forwards",
};

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

  // The next gameweek still open for edits.
  const { data: gameweek } = await supabase
    .from("gameweeks")
    .select("id, number, deadline_at")
    .gt("deadline_at", new Date().toISOString())
    .order("deadline_at")
    .limit(1)
    .maybeSingle<GameweekRow>();

  const { data: roster } = await supabase
    .from("roster_entries")
    .select("player_id, players (id, display_name, position, photo_url, clubs (short_name))")
    .eq("fantasy_team_id", team.id)
    .is("dropped_at", null)
    .returns<RosterRow[]>();

  const { data: formations } = await supabase
    .from("formations")
    .select("code, defenders, midfielders, forwards")
    .order("sort_order")
    .returns<FormationRow[]>();

  const { data: lineup } = gameweek
    ? await supabase
        .from("lineups")
        .select("id, formation, lineup_players (player_id, role, is_captain, is_vice_captain)")
        .eq("fantasy_team_id", team.id)
        .eq("gameweek_id", gameweek.id)
        .maybeSingle<LineupRow>()
    : { data: null };

  const starters = new Set(
    lineup?.lineup_players.filter((row) => row.role === "starter").map((row) => row.player_id),
  );
  const captainId = lineup?.lineup_players.find((row) => row.is_captain)?.player_id;
  const viceId = lineup?.lineup_players.find((row) => row.is_vice_captain)?.player_id;

  const players = (roster ?? [])
    .map((row) => row.players)
    .filter((player): player is NonNullable<RosterRow["players"]> => Boolean(player))
    .sort(
      (a, b) =>
        POSITION_ORDER[a.position] - POSITION_ORDER[b.position] ||
        a.display_name.localeCompare(b.display_name),
    );

  const byPosition = ["GK", "DEF", "MID", "FWD"].map((position) => ({
    position,
    players: players.filter((player) => player.position === position),
  }));

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">{team.name}</h1>
        {gameweek ? (
          <p className="page-subtitle">
            Gameweek {gameweek.number} · locks{" "}
            {new Date(gameweek.deadline_at).toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        ) : null}
      </div>

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
        <form action={saveLineup} className="flex flex-col gap-6" suppressHydrationWarning>
          <input type="hidden" name="league_id" value={league.id} />
          <input type="hidden" name="team_id" value={team.id} />
          <input type="hidden" name="gameweek_id" value={gameweek.id} />

          <label className="flex flex-wrap items-center gap-3 text-sm">
            <span className="muted">Formation</span>
            <select
              name="formation"
              defaultValue={lineup?.formation ?? "4-4-2"}
              suppressHydrationWarning
              className="select"
            >
              {formations?.map((formation) => (
                <option key={formation.code} value={formation.code}>
                  {formation.code}
                </option>
              ))}
            </select>
            <span className="text-xs dim">1 GK plus the outfield split shown</span>
          </label>

          {byPosition.map((group) => (
            <section key={group.position}>
              <h2 className="section-label">{POSITION_LABELS[group.position]}</h2>
              <ul className="list mt-2">
                {group.players.map((player) => (
                  <li key={player.id} className="row">
                    <input
                      type="checkbox"
                      name="starter"
                      value={player.id}
                      defaultChecked={starters.has(player.id)}
                      suppressHydrationWarning
                      className="h-4 w-4 accent-emerald-600"
                      aria-label={`Start ${player.display_name}`}
                    />
                    <PlayerAvatar src={player.photo_url} name={player.display_name} />
                    <span className="flex-1 truncate font-medium">{player.display_name}</span>
                    <span className="text-sm dim">{player.clubs?.short_name ?? "—"}</span>
                    <label className="flex items-center gap-1 text-xs dim">
                      <input
                        type="radio"
                        name="captain"
                        value={player.id}
                        defaultChecked={captainId === player.id}
                        suppressHydrationWarning
                        className="accent-amber-500"
                      />
                      C
                    </label>
                    <label className="flex items-center gap-1 text-xs dim">
                      <input
                        type="radio"
                        name="vice"
                        value={player.id}
                        defaultChecked={viceId === player.id}
                        suppressHydrationWarning
                        className="accent-slate-400"
                      />
                      V
                    </label>
                  </li>
                ))}
                {group.players.length === 0 ? (
                  <li className="row text-sm dim">None on your roster.</li>
                ) : null}
              </ul>
            </section>
          ))}

          <button className="btn btn-primary">Save lineup</button>
        </form>
      )}
    </main>
  );
}
