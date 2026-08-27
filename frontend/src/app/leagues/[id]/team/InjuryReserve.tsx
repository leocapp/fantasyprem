import AvailabilityFlag from "@/components/AvailabilityFlag";

import { dropPlayer, setInjuryReserve } from "./actions";

export type ReserveEntry = {
  id: string;
  name: string;
  position: string;
  club: string;
  availability: string | null;
  news: string | null;
  expectedReturn: string | null;
};

/**
 * The one roster spot that doesn't count, and the mess it makes when it ends.
 *
 * Kept out of PitchLineup on purpose. A reserved player isn't a substitute you
 * could bring on — he's set aside — so he shouldn't appear on the bench at all,
 * and the pitch component never has to know this feature exists.
 */
export default function InjuryReserve({
  leagueId,
  reserved,
  returned,
  eligible,
  overBy,
  droppable,
}: {
  leagueId: string;
  reserved: ReserveEntry | null;
  returned: ReserveEntry | null;
  eligible: ReserveEntry[];
  overBy: number;
  droppable: ReserveEntry[];
}) {
  return (
    <section>
      <h2 className="section-label">Injury reserve</h2>

      {/* The provider cleared him and he took his roster spot back on his own.
          Nothing here is the manager's fault, so the message says what happened
          before it says what to do about it. */}
      {returned && overBy > 0 ? (
        <div className="notice notice-error mt-3">
          <p className="text-sm">
            <strong>{returned.name}</strong> is fit again, so he&apos;s back in a normal
            roster spot and you&apos;re {overBy === 1 ? "one player" : `${overBy} players`} over
            the limit. Drop someone to set a lineup again.
          </p>
          <ul className="list mt-3">
            {droppable.map((player) => (
              <li key={player.id} className="row gap-2">
                <span className="min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">{player.name}</span>
                  <span className="block text-xs dim">
                    {player.position} · {player.club}
                  </span>
                </span>
                <form action={dropPlayer}>
                  <input type="hidden" name="league_id" value={leagueId} />
                  <input type="hidden" name="player_id" value={player.id} />
                  <button className="btn btn-ghost btn-sm" type="submit">
                    Drop
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {reserved ? (
        <ul className="list mt-3">
          <li className="row gap-2">
            <span className="min-w-0 flex-1">
              <span className="truncate text-sm font-medium">{reserved.name}</span>
              <span className="block text-xs dim">
                {reserved.position} · {reserved.club}
              </span>
              <AvailabilityFlag
                availability={reserved.availability}
                news={reserved.news}
                expectedReturn={reserved.expectedReturn}
              />
            </span>
            <form action={setInjuryReserve}>
              <input type="hidden" name="league_id" value={leagueId} />
              <input type="hidden" name="player_id" value={reserved.id} />
              <input type="hidden" name="reserved" value="0" />
              <button
                className="btn btn-ghost btn-sm"
                type="submit"
                title="Put him back in a normal roster spot. You'll need room for him."
              >
                Activate
              </button>
            </form>
          </li>
        </ul>
      ) : null}

      {!reserved && eligible.length > 0 ? (
        <ul className="list mt-3">
          {eligible.map((player) => (
            <li key={player.id} className="row gap-2">
              <span className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{player.name}</span>
                <span className="block text-xs dim">
                  {player.position} · {player.club}
                </span>
                <AvailabilityFlag
                  availability={player.availability}
                  news={player.news}
                  expectedReturn={player.expectedReturn}
                />
              </span>
              <form action={setInjuryReserve}>
                <input type="hidden" name="league_id" value={leagueId} />
                <input type="hidden" name="player_id" value={player.id} />
                <input type="hidden" name="reserved" value="1" />
                <button className="btn btn-ghost btn-sm" type="submit">
                  Reserve
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}

      {!reserved && eligible.length === 0 ? (
        <p className="mt-3 text-sm dim">
          Nobody on your roster is injured or suspended, so there&apos;s nobody to reserve.
        </p>
      ) : null}

      <p className="mt-2 text-xs dim">
        One spot, for a player that has been ruled out — injured or suspended, not
        doubtful. PLayer doesn&apos;t count against your roster, so you can sign a replacement
        in the same position. When he&apos;s fit he takes his spot back automatically and
        somebody has to go.
      </p>
    </section>
  );
}
