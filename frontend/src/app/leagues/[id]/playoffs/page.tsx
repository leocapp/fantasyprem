import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import ManagerAvatar from "@/components/ManagerAvatar";
import { createClient } from "@/lib/supabase/server";

type LeagueRow = {
  id: string;
  name: string;
  status: string;
  playoff_teams: number;
  consolation: boolean;
};

type TeamRow = {
  id: string;
  name: string;
  profiles: { username: string | null; avatar_url: string | null } | null;
};

type StandingRow = {
  team_id: string;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
};

type SeedRow = { team_id: string; seed: number };

type BracketMatchup = {
  id: string;
  stage: string;
  round: number | null;
  bracket_slot: number | null;
  home_team_id: string;
  away_team_id: string | null;
  home_points: number;
  away_points: number;
  status: string;
  gameweeks: { number: number } | null;
};

function bracketRounds(teams: number): number {
  if (teams <= 1) return 0;
  if (teams <= 2) return 1;
  if (teams <= 4) return 2;
  if (teams <= 8) return 3;
  if (teams <= 16) return 4;
  return 5;
}

/** "Final", "Semi-finals", "Quarter-finals", else "Round n". */
function roundName(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-finals";
  if (fromEnd === 2) return "Quarter-finals";
  return `Round ${round}`;
}

export const dynamic = "force-dynamic";

export default async function PlayoffsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, status, playoff_teams, consolation")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const [{ data: teams }, { data: standings }, { data: seeds }, { data: bracket }] =
    await Promise.all([
      supabase
        .from("fantasy_teams")
        .select("id, name, profiles (username, avatar_url)")
        .eq("league_id", id)
        .returns<TeamRow[]>(),

      supabase
        .from("league_standings")
        .select("team_id, wins, losses, draws, points_for")
        .eq("league_id", id)
        .returns<StandingRow[]>(),

      supabase
        .from("playoff_seeds")
        .select("team_id, seed")
        .eq("league_id", id)
        .returns<SeedRow[]>(),

      supabase
        .from("matchups")
        .select(
          "id, stage, round, bracket_slot, home_team_id, away_team_id, home_points, away_points, status, gameweeks (number)",
        )
        .eq("league_id", id)
        .in("stage", ["playoff", "consolation"])
        .returns<BracketMatchup[]>(),
    ]);

  const { data: regularEnd } = await supabase.rpc("regular_season_end", {
    p_league_id: id,
  });

  const nameOf = new Map((teams ?? []).map((team) => [team.id, team.name]));
  const managerOf = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.username ?? null]),
  );
  const avatarOf = new Map(
    (teams ?? []).map((team) => [team.id, team.profiles?.avatar_url ?? null]),
  );

  const rounds = bracketRounds(league.playoff_teams);
  const size = 2 ** rounds;
  const frozen = (seeds ?? []).length > 0;

  // Before the regular season ends there are no real seeds, so the table stands
  // in for them. Saying so matters: a projected bracket that looks settled would
  // have people planning around a seeding that can still move.
  const projected = (standings ?? [])
    .slice()
    .sort((a, b) => b.wins - a.wins || b.points_for - a.points_for || a.team_id.localeCompare(b.team_id));

  const seedOf = new Map<string, number>(
    frozen
      ? (seeds ?? []).map((row) => [row.team_id, row.seed])
      : projected.map((row, index) => [row.team_id, index + 1]),
  );

  const teamAtSeed = new Map<number, string>();
  for (const [teamId, seed] of seedOf) teamAtSeed.set(seed, teamId);

  const playoffGames = (bracket ?? []).filter((row) => row.stage === "playoff");
  const consolationGames = (bracket ?? []).filter((row) => row.stage === "consolation");

  const bySlot = new Map<string, BracketMatchup>();
  for (const game of playoffGames) {
    if (game.round !== null && game.bracket_slot !== null) {
      bySlot.set(`${game.round}:${game.bracket_slot}`, game);
    }
  }

  /** Same rule as playoff_winner in the database: points, then the better seed. */
  const winnerOf = (game: BracketMatchup): string | null => {
    if (game.status !== "final") return null;
    if (!game.away_team_id) return game.home_team_id;
    if (game.home_points > game.away_points) return game.home_team_id;
    if (game.away_points > game.home_points) return game.away_team_id;
    return (seedOf.get(game.home_team_id) ?? 999) <= (seedOf.get(game.away_team_id) ?? 999)
      ? game.home_team_id
      : game.away_team_id;
  };

  const champion =
    rounds > 0 ? (bySlot.get(`${rounds}:1`) ? winnerOf(bySlot.get(`${rounds}:1`)!) : null) : null;

  const side = (teamId: string | null, points: number | null, won: boolean, played: boolean) => (
    <span
      className="flex items-center gap-2 px-2 py-1.5"
      style={won ? { background: "rgb(251 191 36 / 0.12)" } : undefined}
    >
      {teamId ? (
        <ManagerAvatar src={avatarOf.get(teamId)} username={managerOf.get(teamId)} size="sm" />
      ) : (
        <span className="h-6 w-6 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">
        {teamId ? (
          <>
            <span className="numeric mr-1.5 text-xs dim">{seedOf.get(teamId) ?? "–"}</span>
            <Link href={`/leagues/${id}/teams/${teamId}`} className="hover:underline">
              {nameOf.get(teamId) ?? "—"}
            </Link>
          </>
        ) : (
          <span className="dim">—</span>
        )}
      </span>
      <span className="numeric text-sm">{played && points !== null ? points : ""}</span>
    </span>
  );

  return (
    <main className="page page-wide">
      <div>
        <Link href={`/leagues/${id}`} className="text-xs dim hover:underline">
          ← {league.name}
        </Link>
        <h1 className="page-title mt-1">Playoffs</h1>
        <p className="page-subtitle">
          {league.playoff_teams === 0
            ? "Switched off for this league — the title goes to the best record."
            : `Top ${league.playoff_teams} of ${teams?.length ?? 0}, ${rounds} round${
                rounds === 1 ? "" : "s"
              }, starting gameweek ${(regularEnd ?? 0) + 1}. The league title is decided ` +
              `separately, on record alone — playoff results never touch the table.`}
        </p>
      </div>

      {league.playoff_teams === 0 ? (
        <p className="muted">
          A commissioner can turn playoffs on in{" "}
          <Link href={`/leagues/${id}/settings`} className="hover:underline">
            league settings
          </Link>
          .
        </p>
      ) : (
        <>
          {champion ? (
            <section className="card">
              <p className="text-xs uppercase tracking-wide dim">Champion</p>
              <p className="mt-1 flex items-center gap-3">
                <ManagerAvatar
                  src={avatarOf.get(champion)}
                  username={managerOf.get(champion)}
                  size="lg"
                />
                <span className="text-2xl font-bold">{nameOf.get(champion)}</span>
              </p>
            </section>
          ) : null}

          {!frozen ? (
            <p className="notice text-sm">
              Seeding is <strong>provisional</strong> — taken from the table as it stands
              today, and locked only when every regular-season fixture is final. Anything
              below can still change.
            </p>
          ) : null}

          <section>
            <h2 className="section-label">Bracket</h2>

            {/* Rounds as columns, scrolling sideways on a narrow screen rather
                than reflowing: a bracket that wraps stops being a bracket. */}
            <div className="mt-3 flex gap-4 overflow-x-auto pb-2">
              {Array.from({ length: rounds }, (_, index) => index + 1).map((round) => {
                const slots = size / 2 ** round;

                return (
                  <div key={round} className="flex min-w-[15rem] flex-1 flex-col">
                    <p className="text-xs uppercase tracking-wide dim">
                      {roundName(round, rounds)}
                      <span className="ml-1.5 normal-case">
                        · GW {(regularEnd ?? 0) + round}
                      </span>
                    </p>

                    <div className="mt-2 flex flex-1 flex-col justify-around gap-3">
                      {Array.from({ length: slots }, (_, index) => index + 1).map((slot) => {
                        const game = bySlot.get(`${round}:${slot}`);

                        // Round one is knowable from the seeding before any
                        // matchup exists, which is what lets the bracket be
                        // worth looking at in September.
                        const homeId =
                          game?.home_team_id ?? (round === 1 ? teamAtSeed.get(slot) ?? null : null);
                        const awayId =
                          game?.away_team_id ??
                          (round === 1 && size + 1 - slot <= league.playoff_teams
                            ? teamAtSeed.get(size + 1 - slot) ?? null
                            : null);

                        const played = game?.status === "final";
                        const won = game ? winnerOf(game) : null;
                        const bye = homeId !== null && awayId === null;

                        const body = (
                          <div className="flex flex-col divide-y divide-[var(--border)]">
                            {side(homeId, game?.home_points ?? null, won === homeId, played)}
                            {bye ? (
                              <span className="px-2 py-1.5 text-xs dim">
                                bye — through to the next round
                              </span>
                            ) : (
                              side(awayId, game?.away_points ?? null, won === awayId, played)
                            )}
                          </div>
                        );

                        return (
                          <div
                            key={slot}
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                          >
                            {game ? (
                              <Link href={`/leagues/${id}/matchups/${game.id}`} className="block">
                                {body}
                              </Link>
                            ) : (
                              body
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h2 className="section-label">Seeding</h2>
            <ul className="list mt-3">
              {projected.map((row, index) => {
                const seed = seedOf.get(row.team_id) ?? index + 1;
                const inBracket = seed <= league.playoff_teams;

                return (
                  <li key={row.team_id} className="row gap-2">
                    <span className="numeric w-6 text-xs dim">{seed}</span>
                    <ManagerAvatar
                      src={avatarOf.get(row.team_id)}
                      username={managerOf.get(row.team_id)}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <Link
                        href={`/leagues/${id}/teams/${row.team_id}`}
                        className="hover:underline"
                      >
                        {nameOf.get(row.team_id) ?? "—"}
                      </Link>
                    </span>
                    <span className="numeric text-xs dim">
                      {row.wins}–{row.losses}
                      {row.draws ? `–${row.draws}` : ""} · {row.points_for}
                    </span>
                    <span
                      className="w-16 text-right text-[10px] uppercase tracking-wide"
                      style={{ color: inBracket ? "var(--accent-hover)" : "var(--text-dim)" }}
                    >
                      {inBracket ? "in" : "out"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {league.consolation && consolationGames.length > 0 ? (
            <section>
              <h2 className="section-label">Consolation</h2>
              <ul className="list mt-3">
                {consolationGames
                  .slice()
                  .sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0))
                  .map((game) => (
                    <li key={game.id}>
                      <Link href={`/leagues/${id}/matchups/${game.id}`} className="row-link gap-2">
                        <span className="numeric w-10 text-xs dim">
                          GW{game.gameweeks?.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {nameOf.get(game.home_team_id) ?? "—"}
                          <span className="dim"> v </span>
                          {game.away_team_id
                            ? (nameOf.get(game.away_team_id) ?? "—")
                            : "the field"}
                        </span>
                        <span className="numeric text-sm">
                          {game.status === "final"
                            ? `${game.home_points} – ${game.away_points}`
                            : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-xs dim">
                Teams out of the bracket keep playing each other, paired by finishing
                position. With an odd number left over, whoever is spare plays the league
                average — the same opponent a bye week gives you.
              </p>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
