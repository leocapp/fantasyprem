import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import AvailabilityFlag from "@/components/AvailabilityFlag";
import BackLink from "@/components/BackLink";
import PlayerAvatar from "@/components/PlayerAvatar";
import ScoringKey, { type ScoringRule } from "@/components/ScoringKey";
import SeasonStatTable, {
  EMPTY_SEASON,
  SEASON_STAT_COLUMNS,
  type SeasonStats,
} from "@/components/SeasonStatTable";
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
  expected_return: string | null;
  games_missed: number | null;
  clubs: { name: string; short_name: string } | null;
};

type GameweekRow = { id: string; number: number; status: string; deadline_at: string };

const MINIMUM_MATCHES = 3;

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
};

type ScoreRow = {
  gameweek_id: string;
  points: number;
  breakdown: Record<string, number>;
};


type SeasonPointsRow = {
  total_points: number;
  best_gameweek: number | null;
  gameweeks_scored: number;
  gameweeks_elapsed: number;
};

type ExpectationRow = {
  gameweek_id: string;
  minutes: number;
  full_game_probability: number;
  goals: number;
  assists: number;
  clean_sheet_probability: number;
  goals_conceded: number;
  saves: number;
  matches_observed: number;
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
  shots_on_target: "Shots on target",
  key_passes: "Key passes",
  tackles: "Tackles",
  interceptions: "Interceptions",
  big_chances_created: "Big chances created",
  duels_won: "Duels won",
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
      "id, display_name, first_name, last_name, position, photo_url, club_id, availability, news, expected_return, games_missed, clubs (name, short_name)",
    )
    .eq("id", playerId)
    .maybeSingle<PlayerRow>();

  if (!player) notFound();

  const { data: gameweeks } = await supabase
    .from("gameweeks")
    .select("id, number, status, deadline_at")
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

  // Both the rule naming this position and the catch-all are fetched; the
  // component applies the same precedence the scoring function does.
  const { data: scoringRules } = await supabase
    .from("scoring_rules")
    .select("stat_key, applies_to, points")
    .eq("league_id", id)
    .or(`applies_to.is.null,applies_to.eq.${player.position}`)
    .returns<ScoringRule[]>();

  // The most recent season that isn't this one. Null before any backfill has
  // run, which is the only case where the collapsed table is hidden entirely.
  const { data: previousSeason } = await supabase
    .from("seasons")
    .select("id, label")
    .neq("id", league.season_id)
    .order("ends_on", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; label: string }>();

  const [{ data: seasonStats }, { data: seasonPoints }, { data: lastSeasonStats }] =
    await Promise.all([
    supabase
      .from("player_season_stats")
      .select(SEASON_STAT_COLUMNS)
      .eq("player_id", playerId)
      .eq("season_id", league.season_id)
      .maybeSingle<SeasonStats>(),

    supabase
      .from("player_league_season_points")
      .select("total_points, best_gameweek, gameweeks_scored, gameweeks_elapsed")
      .eq("league_id", id)
      .eq("player_id", playerId)
      .maybeSingle<SeasonPointsRow>(),

    previousSeason
      ? supabase
          .from("player_season_stats")
          .select(SEASON_STAT_COLUMNS)
          .eq("player_id", playerId)
          .eq("season_id", previousSeason.id)
          .maybeSingle<SeasonStats>()
      : Promise.resolve({ data: null }),
  ]);

  // A player with no rows has played no matches, which is a table of zeros
  // rather than an absent table.
  const seasonStatsOrZero: SeasonStats = seasonStats ?? EMPTY_SEASON;

  // Last season is different: no rows means they weren't in this league's data
  // at all — a new signing, or someone promoted from outside — and zeros would
  // read as "played and did nothing", which is a lie.
  const lastSeason = lastSeasonStats;
  const lastSeasonLabel = previousSeason?.label;

  // Our own projection for upcoming gameweeks, plus the points those
  // expectations imply under this league's rules.
  const { data: expectations } = await supabase
    .from("player_gameweek_expectations")
    .select(
      "gameweek_id, minutes, full_game_probability, goals, assists, clean_sheet_probability, goals_conceded, saves, matches_observed",
    )
    .eq("player_id", playerId)
    .returns<ExpectationRow[]>();

  // Which gameweeks are "next" comes from this league's own schedule, not the
  // calendar. Re-running the ingestion job rewrites gameweek statuses from the
  // live FPL feed, which would otherwise point this back at gameweek 1 while
  // the league is on gameweek 5.
  const { data: scheduled } = await supabase
    .from("matchups")
    .select("gameweeks (id, number)")
    .eq("league_id", id)
    .eq("status", "scheduled")
    .returns<{ gameweeks: { id: string; number: number } | null }[]>();

  const nextNumbers = [
    ...new Set(
      (scheduled ?? [])
        .map((row) => row.gameweeks?.number)
        .filter((value): value is number => value !== undefined),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, 2);

  const now = Date.now();

  // Before a league's schedule exists — during setup, or between seasons — fall
  // back to the calendar, and then to whichever gameweeks we actually hold a
  // projection for. The projection job only writes rows for gameweeks still to
  // come, so that last fallback can't surface a stale one.
  const withExpectation = (rows: GameweekRow[]) =>
    rows
      .map((gameweek) => ({
        gameweek,
        expectation: (expectations ?? []).find((row) => row.gameweek_id === gameweek.id),
      }))
      .filter((row) => row.expectation);

  const byLeagueSchedule = withExpectation(
    (gameweeks ?? []).filter((row) => nextNumbers.includes(row.number)),
  );

  const byCalendar = withExpectation(
    (gameweeks ?? []).filter((row) => new Date(row.deadline_at).getTime() > now),
  );

  const upcoming = (
    byLeagueSchedule.length > 0
      ? byLeagueSchedule
      : byCalendar.length > 0
        ? byCalendar
        : withExpectation(gameweeks ?? [])
  ).slice(0, 2);

  const projectedPoints = await Promise.all(
    upcoming.map(async ({ gameweek }) => {
      const { data } = await supabase.rpc("projected_points", {
        p_league_id: id,
        p_player_id: playerId,
        p_gameweek_id: gameweek.id,
      });
      return { gameweekId: gameweek.id, points: data as number | null };
    }),
  );

  const projectedBy = new Map(projectedPoints.map((row) => [row.gameweekId, row.points]));

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
          "fixture_id, minutes, goals, assists, clean_sheet, goals_conceded, own_goals, penalties_saved, penalties_missed, saves, yellow_cards, red_cards",
        )
        .eq("player_id", playerId)
        .in("fixture_id", fixtureIds)
        .returns<StatRow[]>()
    : { data: [] };

  // Season points by category, summed from every gameweek's stored breakdown.
  // No extra query: the same rows that draw the gameweek strip.
  const seasonBreakdown = (scores ?? []).reduce<Record<string, number>>((totals, row) => {
    for (const [key, value] of Object.entries(row.breakdown ?? {})) {
      if (key === "minutes") continue;
      totals[key] = (totals[key] ?? 0) + Number(value);
    }
    return totals;
  }, {});

  const seasonBreakdownRows = Object.entries(seasonBreakdown)
    .filter(([, value]) => value !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const score = selected ? scoreBy.get(selected.id) : undefined;
  const breakdown = Object.entries(score?.breakdown ?? {}).filter(
    ([key, value]) => key !== "minutes" && Number(value) !== 0,
  );

  return (
    <main className="page page-narrow">
      <div>
        <BackLink fallbackHref={`/leagues/${league.id}`} fallbackLabel={league.name} />
        <div className="mt-2 flex items-center gap-3">
          <PlayerAvatar src={player.photo_url} name={player.display_name} />
          <div>
            <h1 className="page-title">{player.display_name}</h1>
            <p className="page-subtitle">
              {player.first_name ? `${player.first_name} ${player.last_name} · ` : ""}
              {player.position} · {player.clubs?.name ?? "—"}
            </p>
            {player.availability && player.availability !== "a" ? (
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                <AvailabilityFlag
                  availability={player.availability}
                  news={player.news}
                  expectedReturn={player.expected_return}
                  showLabel
                />
                {player.news ? <span className="muted">{player.news}</span> : null}
                {player.games_missed ? (
                  <span className="dim">
                    {player.games_missed} game{player.games_missed === 1 ? "" : "s"} missed
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="card">
          <h2 className="section-label">
            Season so far · on the pitch
            <span className="ml-2 font-normal dim">
              {seasonStatsOrZero.appearances} of {seasonPoints?.gameweeks_elapsed ?? 0} gameweeks
            </span>
          </h2>
          {/* Rendered even with nothing in it. A table of zeros says "hasn't
              played yet"; an absent table says nothing at all, and before the
              season starts that is every player on the site. */}
          <div className="mt-3">
            <SeasonStatTable stats={seasonStatsOrZero} position={player.position} />
          </div>
        </section>

        <section className="card">
          <div className="flex items-baseline justify-between">
            <h2 className="section-label">Season so far · points</h2>
            <span className="numeric text-2xl font-bold">
              {seasonPoints?.total_points ?? 0}
            </span>
          </div>

          <dl className="mt-3 space-y-1 text-sm">
            {seasonBreakdownRows.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2">
                <dt className="dim">{BREAKDOWN_LABELS[key] ?? key}</dt>
                <dd className={`numeric ${value < 0 ? "text-[var(--danger)]" : ""}`}>
                  {value > 0 ? "+" : ""}
                  {value}
                </dd>
              </div>
            ))}

            <div className="flex justify-between gap-2 border-t border-[var(--border)] pt-1">
              <dt className="dim">Per gameweek</dt>
              <dd className="numeric">
                {seasonPoints && seasonPoints.gameweeks_elapsed > 0
                  ? (seasonPoints.total_points / seasonPoints.gameweeks_elapsed).toFixed(1)
                  : "–"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="dim">Best gameweek</dt>
              <dd className="numeric">{seasonPoints?.best_gameweek ?? "–"}</dd>
            </div>
          </dl>

          <p className="mt-2 text-xs dim">
            Per gameweek counts every week of the season, including ones they missed — an
            unavailable player costs you those weeks.
          </p>
        </section>
      </div>

      {/* Native details/summary: collapsed by default, works before hydration,
          and keeps this page a server component. */}
      {lastSeason ? (
        <details className="card">
          <summary className="cursor-pointer text-sm font-medium">
            {lastSeasonLabel ?? "Last season"} · stat totals
            <span className="ml-2 font-normal dim">
              {lastSeason.appearances} apps, {lastSeason.goals}g {lastSeason.assists}a
            </span>
          </summary>
          <div className="mt-3">
            <SeasonStatTable stats={lastSeason} position={player.position} />
          </div>
          <p className="mt-2 text-xs dim">
            Previous seasons totals - in premier league. Some players will not have 25/26 totals if they did not play in the Prem.
          </p>
        </details>
      ) : null}

      {upcoming.length > 0 ? (
        <section>
          <h2 className="section-label">Projection</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {upcoming.map(({ gameweek, expectation }) => {
              const points = projectedBy.get(gameweek.id);
              const e = expectation!;
              const thin = e.matches_observed < MINIMUM_MATCHES;

              return (
                <div key={gameweek.id} className="card">
                  <div className="flex items-baseline justify-between">
                    <h3 className="font-semibold">Gameweek {gameweek.number}</h3>
                    <span className="numeric text-lg">
                      {points !== null && points !== undefined ? `${points} pts` : "–"}
                    </span>
                  </div>

                  {player.availability && player.availability !== "a" ? (
                    <p className="mt-2 text-xs" style={{ color: "var(--warning)" }}>
                      {player.expected_return &&
                      new Date(`${player.expected_return}T00:00:00`) <
                        new Date(gameweek.deadline_at)
                        ? "Expected back before this deadline."
                        : "Held out of this gameweek — the projection is reduced to match."}
                    </p>
                  ) : null}

                  {thin ? (
                    <p className="mt-2 text-xs dim">
                      Only {e.matches_observed} match
                      {e.matches_observed === 1 ? "" : "es"} played — not enough to project from
                      yet.
                    </p>
                  ) : (
                    <dl className="mt-3 space-y-1 text-sm">
                      {(
                        [
                          ["Expected minutes", e.minutes],
                          ["Chance of 60+ mins", `${Math.round(e.full_game_probability * 100)}%`],
                          ["Expected goals", e.goals],
                          ["Expected assists", e.assists],
                          [
                            "Clean sheet chance",
                            `${Math.round(e.clean_sheet_probability * 100)}%`,
                          ],
                          ...(player.position === "GK"
                            ? ([["Expected saves", e.saves]] as const)
                            : []),
                        ] as const
                      ).map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-2">
                          <dt className="dim">{label}</dt>
                          <dd className="numeric">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-2 text-xs dim">
            Expected minutes and per-90 rates from this player&apos;s own matches, shrunk toward
            their position&apos;s average where the sample is thin, adjusted for the opponent, then
            scored by this league&apos;s rules. Expected minutes drive most of it — a projection is
            mostly a guess about whether someone plays.
          </p>
        </section>
      ) : (
        <section>
          <h2 className="section-label">Projection</h2>
          <p className="mt-3 muted">
            No projection yet — it&apos;s written nightly for the gameweeks still to come.
          </p>
        </section>
      )}

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

      <ScoringKey
        rules={scoringRules ?? []}
        position={player.position}
        leagueId={league.id}
      />

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
                  // Switching gameweek changes what's shown, it isn't a new
                  // destination — so it replaces the history entry rather than
                  // stacking one. Otherwise Back walks through every gameweek
                  // you looked at before leaving the page.
                  replace
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
