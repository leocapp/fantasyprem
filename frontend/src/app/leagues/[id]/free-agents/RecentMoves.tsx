export type Move = {
  id: string;
  type: string;
  created_at: string;
  fantasy_team_id: string;
  player_in_id: string | null;
  player_out_id: string | null;
  counterparty_team_id: string | null;
};

/**
 * Who has been signing whom.
 *
 * A details element rather than a dropdown: it needs no client JavaScript, it
 * survives a server render intact, and on a phone it costs one line when shut.
 * The free agents page is already a long scrolling list — this shouldn't push
 * the players further down the screen for the six days a week nobody cares.
 *
 * Draft picks are excluded upstream. A seventeen-round draft across seven teams
 * is 119 rows that would bury every real transfer under the day the league
 * started.
 */
export default function RecentMoves({
  moves,
  teamNames,
  playerNames,
  times,
  myTeamId,
}: {
  moves: Move[];
  teamNames: Map<string, string>;
  playerNames: Map<string, string>;
  times: Map<string, string>;
  myTeamId: string | null;
}) {
  if (moves.length === 0) {
    return (
      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">Fat Boyz Moves</summary>
        <p className="mt-3 text-sm dim">
          Nothing yet. Signings and releases show up here as soon as anyone makes one.
        </p>
      </details>
    );
  }

  const describe = (move: Move) => {
    const inName = move.player_in_id ? playerNames.get(move.player_in_id) : null;
    const outName = move.player_out_id ? playerNames.get(move.player_out_id) : null;

    if (move.type === "trade") {
      const other = move.counterparty_team_id
        ? (teamNames.get(move.counterparty_team_id) ?? "another team")
        : "another team";
      return `traded for ${inName ?? "a player"} with ${other}`;
    }

    // A swap carries both halves; a claim into a reserved place carries only
    // the arrival, and a drop only the departure.
    if (inName && outName) return `signed ${inName}, released ${outName}`;
    if (inName) return `signed ${inName}`;
    if (outName) return `released ${outName}`;
    return "made a move";
  };

  return (
    <details className="card">
      {/* No count beside the heading. Capped at ten, it would read as the total
          number of moves the league has ever made, and sit on "10" all season. */}
      <summary className="cursor-pointer text-sm font-semibold">Fat Boyz Moves</summary>

      <ul className="list mt-3">
        {moves.map((move) => {
          const mine = move.fantasy_team_id === myTeamId;


          return (
            <li key={move.id} className="row gap-2">
              <span className="min-w-0 flex-1">
                <span className="text-sm">
                  <span className={mine ? "font-semibold" : "font-medium"}>
                    {teamNames.get(move.fantasy_team_id) ?? "A team"}
                  </span>{" "}
                  {describe(move)}
                </span>
                <span className="block text-xs dim">{times.get(move.id) ?? ""}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
