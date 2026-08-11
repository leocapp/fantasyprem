/**
 * A player's raw season totals — what they did on the pitch, not what it was
 * worth. Used for the current season and, collapsed, for the one before, so
 * both read identically and a season-on-season comparison is a glance rather
 * than a translation.
 */
export type SeasonStats = {
  appearances: number;
  full_games: number;
  minutes: number;
  goals: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  saves: number;
  yellow_cards: number;
  red_cards: number;
  shots_on_target: number;
  key_passes: number;
  tackles: number;
  interceptions: number;
  big_chances_created: number;
  duels_won: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
};

/** Every field zero, so a player with no matches shows a table rather than a gap. */
export const EMPTY_SEASON: SeasonStats = {
  appearances: 0,
  full_games: 0,
  minutes: 0,
  goals: 0,
  assists: 0,
  clean_sheets: 0,
  goals_conceded: 0,
  saves: 0,
  yellow_cards: 0,
  red_cards: 0,
  shots_on_target: 0,
  key_passes: 0,
  tackles: 0,
  interceptions: 0,
  big_chances_created: 0,
  duels_won: 0,
  own_goals: 0,
  penalties_saved: 0,
  penalties_missed: 0,
};

export const SEASON_STAT_COLUMNS =
  "appearances, full_games, minutes, goals, assists, clean_sheets, goals_conceded, " +
  "saves, yellow_cards, red_cards, shots_on_target, key_passes, tackles, " +
  "interceptions, big_chances_created, duels_won, own_goals, penalties_saved, " +
  "penalties_missed";

/**
 * Which rows a position gets. Goalkeeping stats on a striker are noise, but
 * clean sheets belong to midfielders too — they score for one in the default
 * rules, which the old card didn't reflect.
 */
function rowsFor(stats: SeasonStats, position: string): [string, number | string][] {
  const keeper = position === "GK";
  const defends = position === "GK" || position === "DEF";
  const cleanSheets = defends || position === "MID";

  return [
    ["Appearances", stats.appearances],
    ["Started (60+ mins)", stats.full_games],
    ["Minutes", stats.minutes],
    [
      "Minutes per appearance",
      stats.appearances > 0 ? Math.round(stats.minutes / stats.appearances) : 0,
    ],
    ["Goals", stats.goals],
    ["Assists", stats.assists],
    ["Big chances created", stats.big_chances_created],
    ["Key passes", stats.key_passes],
    ["Shots on target", stats.shots_on_target],
    ...(cleanSheets ? ([["Clean sheets", stats.clean_sheets]] as [string, number][]) : []),
    ...(defends
      ? ([["Goals conceded", stats.goals_conceded]] as [string, number][])
      : []),
    ...(keeper
      ? ([
          ["Saves", stats.saves],
          ["Penalties saved", stats.penalties_saved],
        ] as [string, number][])
      : []),
    ["Tackles", stats.tackles],
    ["Interceptions", stats.interceptions],
    ["Duels won", stats.duels_won],
    ["Cards", `${stats.yellow_cards}Y${stats.red_cards ? ` ${stats.red_cards}R` : ""}`],
    ...(stats.own_goals ? ([["Own goals", stats.own_goals]] as [string, number][]) : []),
    ...(stats.penalties_missed
      ? ([["Penalties missed", stats.penalties_missed]] as [string, number][])
      : []),
  ];
}

export default function SeasonStatTable({
  stats,
  position,
}: {
  stats: SeasonStats;
  position: string;
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 text-sm sm:grid-cols-2">
      {rowsFor(stats, position).map(([label, value]) => (
        <div
          key={label}
          className="flex justify-between gap-2 border-b border-[var(--border)] py-1"
        >
          <dt className="dim">{label}</dt>
          <dd className="numeric">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
