import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import AvailabilityFlag from "@/components/AvailabilityFlag";
import PlayerAvatar from "@/components/PlayerAvatar";
import { formatDateTime } from "@/lib/datetime";
import { createClient } from "@/lib/supabase/server";

type LeagueRow = { id: string; name: string; season_id: string };

type PlayerRow = {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string;
  position: string;
  photo_url: string | null;
  club_id: string | null;
  availability: string | null;
  news: string | null;
  chance_of_playing: number | null;
  clubs: { name: string; short_name: string } | null;
};

type GameweekRow = { id: string; number: number; status: string };

type ClubRow = { id: string; name: string; short_name: string };

type FixtureRow = {
  id: string;
  gameweek_id: string;
  home_club_id: string;
  away_club_id: string;
  home_score: number | null;
  away_score: number | null;
  kickoff_at: string;
  status: string;
};

type StatRow = {
  fixture_id: string;
  minutes: number;
  goals: number;
  assists: number;
  clean_sheet: boolean;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  saves: number;
  yellow_cards: number;
  red_cards: number;
  bonus: number;
};

type ScoreRow = {
  gameweek_id: string;
  points: number;
  breakdown: Record<string, number>;
};

const STAT_LABELS: [keyof StatRow, string][] = [
  ["minutes", "Minutes"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["clean_sheet", "Clean sheet"],
  ["goals_conceded", "Goals conceded"],
  ["saves", "Saves"],
  ["penalties_saved", "Penalties saved"],
  ["penalties_missed", "Penalties missed"],
  ["own_goals", "Own goals"],
  ["yellow_cards", "Yellow cards"],
  ["red_cards", "Red cards"],
  ["bonus", "Bonus"],
];

const BREAKDOWN_LABELS: Record<string, string> = {
  appearance: "Appearance",
  goals: "Goals",
  assists: "Assists",
  clean_sheet: "Clean sheet",
  goals_conceded: "Goals conceded",
  saves: "Saves",
  penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed",
  own_goals: "Own goals",
  yellow_cards: "Yellow cards",
  red_cards: "Red cards",
  bonus: "Bonus",
};

export const dynamic = "force-dynamic";

export default async function PlayerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; playerId: string }>;
  searchParams: Promise<{ gw?: string }>;
}) {
  const { id, playerId } = await params;
  const { gw } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: league } = await supabase
    .from("leagues")
    .select("id, name, season_id")
    .eq("id", id)
    .maybeSingle<LeagueRow>();

  if (!league) notFound();

  const { data: player } = await supabase
    .from("players")
    .select(
      "id, display_name, first_name, last_name, position, photo_url, club_id, availability, news, chance_of_playing, clubs (name, short_name)",
    )
    .eq("id", playerId)
    .maybeSingle<PlayerRow>();

  if (!player) notFound();

  const { data: gameweeks } = await supabase
    .from("gameweeks")
    .select("id, number, status")
    .eq("season_id", league.season_id)
    .order("number")
    .returns<GameweekRow[]>();

  const { data: scores } = await supabase
    .from("player_gameweek_scores")
    .select("gameweek_id, points, breakdown")
    .eq("league_id", id)
    .eq("player_id", playerId)
    .returns<ScoreRow[]>();

  const scoreBy = new Map((scores ?? []).map((row) => [row.gameweek_id, row]));

  const requested = gw ? Number(gw) : undefined;
  const selected =
    (gameweeks ?? []).find((row) => row.number === requested) ??
    (gameweeks ?? []).filter((row) => scoreBy.has(row.id)).at(-1) ??
    (gameweeks ?? [])[0];

  // Clubs are a small table; mapping ids locally avoids disambiguating two
  // foreign keys to the same table in one embed.
  const { data: clubs } = await supabase
    .from("clubs")
    .select("id, name, short_name")
    .returns<ClubRow[]>();

  const clubBy = new Map((clubs ?? []).map((row) => [row.id, row]));

  const { data: fixtures } = selected
    ? await supabase
        .from("fixtures")
        .select("id, gameweek_id, home_club_id, away_club_id, home_score, away_score, kickoff_at, status")
        .eq("gameweek_id", selected.id)
        .or(`home_club_id.eq.${player.club_id},away_club_id.eq.${player.club_id}`)
        .returns<FixtureRow[]>()
    : { data: [] };

  const fixtureIds = (fixtures ?? []).map((row) => row.id);

  const { data: stats } = fixtureIds.length
    ? await supabase
        .from("player_match_stats")
        .select(
          "fixture_id, minutes, goals, assists, clean_sheet, goals_conceded, own_goals, penalties_saved, penalties_missed, saves, yellow_cards, red_cards, bonus",
        )
        .eq("player_id", playerId)
        .in("fixture_id", fixtureIds)
        .returns<StatRow[]>()
    : { data: [] };

  const score = selected ? scoreBy.get(selected.id) : undefined;
  const breakdown = Object.entries(score?.breakdown ?? {}).filter(
    ([key, value]) => key !== "minutes" && Number(value) !== 0,
  );

  return (
    <main className="page page-narrow">
      <div>
        <Link href={`/leagues/${league.id}`} className="text-sm dim hover:text-[var(--text)]">
          ← {league.name}
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <PlayerAvatar src={player.photo_url} name={player.display_name} />
          <div>
            <h1 className="page-title">{player.display_name}</h1>
            <p className="page-subtitle">
              {player.first_name ? `${player.first_name} ${player.last_name} · ` : ""}
              {player.position} · {player.clubs?.name ?? "—"}
            </p>
            {player.availability && player.availability !== "a" ? (
              <p className="mt-1">
                <AvailabilityFlag
                  availability={player.availability}
                  news={player.news}
                  chance={player.chance_of_playing}
                  showLabel
                />
                {player.news ? <span className="ml-2 text-xs muted">{player.news}</span> : null}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="section-label">Gameweek {selected?.number}</h2>
          <span className="numeric text-lg">{score ? `${score.points} pts` : "—"}</span>
        </div>

        {(fixtures ?? []).length === 0 ? (
          <p className="mt-3 muted">
            {player.clubs?.short_name ?? "Their club"} had no fixture this gameweek.
          </p>
        ) : (
          <ul className="list mt-3">
            {fixtures?.map((fixture) => {
              const home = clubBy.get(fixture.home_club_id);
              const away = clubBy.get(fixture.away_club_id);
              const stat = (stats ?? []).find((row) => row.fixture_id === fixture.id);
              const isHome = fixture.home_club_id === player.club_id;

              return (
                <li key={fixture.id} className="flex flex-col gap-3 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex-1 truncate text-right text-sm">
                      {home?.name ?? "—"}
                    </span>
                    <span className="numeric text-sm">
                      {fixture.home_score ?? "–"} – {fixture.away_score ?? "–"}
                    </span>
                    <span className="flex-1 truncate text-sm">{away?.name ?? "—"}</span>
                  </div>
                  <p className="text-center text-xs dim">
                    {isHome ? "home" : "away"} · {formatDateTime(fixture.kickoff_at)} ·{" "}
                    {fixture.status}
                  </p>

                  {stat ? (
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                      {STAT_LABELS.map(([key, label]) => {
                        const value = stat[key];
                        const display = typeof value === "boolean" ? (value ? "yes" : "no") : value;
                        if (!value) return null;
                        return (
                          <div key={key} className="flex justify-between gap-2">
                            <dt className="dim">{label}</dt>
                            <dd className="numeric">{display}</dd>
                          </div>
                        );
                      })}
                    </dl>
                  ) : (
                    <p className="text-center text-xs dim">No stats recorded — did not play.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {breakdown.length > 0 ? (
        <section>
          <h2 className="section-label">How those points were scored</h2>
          <ul className="list mt-3">
            {breakdown.map(([key, value]) => (
              <li key={key} className="row justify-between">
                <span className="text-sm">{BREAKDOWN_LABELS[key] ?? key}</span>
                <span className={`numeric text-sm ${Number(value) < 0 ? "text-[var(--danger)]" : ""}`}>
                  {Number(value) > 0 ? "+" : ""}
                  {value}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs dim">
            Uses this league&apos;s scoring rules, so the same match can be worth different points
            in another league.
          </p>
        </section>
      ) : null}

      <section>
        <h2 className="section-label">Season</h2>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {gameweeks?.map((gameweek) => {
            const value = scoreBy.get(gameweek.id);
            const active = gameweek.id === selected?.id;

            return (
              <li key={gameweek.id}>
                <Link
                  href={`/leagues/${league.id}/players/${player.id}?gw=${gameweek.number}`}
                  className={`flex w-14 flex-col items-center rounded-md border px-1 py-1.5 text-xs transition-colors ${
                    active
                      ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  <span className="dim">GW{gameweek.number}</span>
                  <span className="numeric">{value ? value.points : "–"}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
