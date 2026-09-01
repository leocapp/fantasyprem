export type Transfer = {
  id: string;
  kind: string;
  seen_at: string;
  player_id: string;
  from_club_id: string | null;
  to_club_id: string | null;
};

/**
 * Real-world club changes, as observed by the squad refresh.
 *
 * Not a transfer feed. There are no fees, no loan-versus-permanent, and no
 * announcement dates — only what changed between two readings of the squads,
 * up to six hours apart. The heading says "spotted" rather than "transfers"
 * for that reason: it is a claim about our data, not about football.
 */
export default function RealTransfers({
  transfers,
  playerNames,
  clubNames,
  times,
  leagueId,
}: {
  transfers: Transfer[];
  playerNames: Map<string, string>;
  clubNames: Map<string, string>;
  times: Map<string, string>;
  leagueId: string;
}) {
  if (transfers.length === 0) {
    return (
      <details className="card">
        <summary className="cursor-pointer text-sm font-semibold">IRL Transfers</summary>
        <p className="mt-3 text-sm dim">
          No club changes seen yet. Squads are re-read every few hours, so a signing
          shows up here within about half a day of the provider listing it.
        </p>
      </details>
    );
  }

  const describe = (transfer: Transfer) => {
    const from = transfer.from_club_id ? clubNames.get(transfer.from_club_id) : null;
    const to = transfer.to_club_id ? clubNames.get(transfer.to_club_id) : null;

    if (transfer.kind === "left") {
      return from ? `left ${from} and the Premier League` : "left the Premier League";
    }
    if (transfer.kind === "arrived") {
      return to ? `joined ${to}` : "joined the Premier League";
    }
    return from && to ? `moved from ${from} to ${to}` : "changed club";
  };

  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-semibold">IRL Transfers</summary>

      <ul className="list mt-3">
        {transfers.map((transfer) => (
          <li key={transfer.id} className="row gap-2">
            <span className="min-w-0 flex-1">
              <span className="text-sm">
                <a
                  href={`/leagues/${leagueId}/players/${transfer.player_id}`}
                  className="font-medium hover:underline"
                >
                  {playerNames.get(transfer.player_id) ?? "A player"}
                </a>{" "}
                {describe(transfer)}
              </span>
              <span className="block text-xs dim">{times.get(transfer.id) ?? ""}</span>
            </span>

            {/* A player who has left can't score, and shouldn't be signed by
                anyone still browsing this page. */}
            {transfer.kind === "left" ? (
              <span
                className="shrink-0 rounded px-1 text-[9px] font-bold"
                style={{ background: "rgb(248 113 113 / 0.2)", color: "var(--danger)" }}
              >
                GONE
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs dim">
        Taken from changes in club squads rather than from a transfer feed, so there are no
        fees or loan details, and a move can take a few hours to appear.
      </p>
    </details>
  );
}
