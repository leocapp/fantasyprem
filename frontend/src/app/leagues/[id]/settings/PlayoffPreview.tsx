"use client";

import { useState } from "react";

export type SeedRow = {
  id: string;
  name: string;
  wins: number;
  losses: number;
  draws: number;
  points_for: number;
};

function bracketRounds(teams: number): number {
  if (teams <= 1) return 0;
  if (teams <= 2) return 1;
  if (teams <= 4) return 2;
  if (teams <= 8) return 3;
  if (teams <= 16) return 4;
  return 5;
}

function roundName(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi-finals";
  if (fromEnd === 2) return "Quarter-finals";
  return `Round ${round}`;
}

/** "Semi-finals" -> "Semi-final", so a single tie can be numbered. */
function singular(name: string): string {
  return name.endsWith("s") ? name.slice(0, -1) : name;
}

type Feed =
  | { kind: "team"; name: string; seed: number }
  | { kind: "winner"; label: string };

/**
 * What the bracket would look like if the playoffs began today.
 *
 * A client component purely so the preview follows the dropdown. The point is
 * comparing sizes before committing to one — a commissioner should be able to
 * see that six teams knocks out last place while seven rewards the top seed
 * with a week off, without saving twice to find out.
 *
 * Later rounds are shown as "Winner of 3 v 6" rather than being left blank or,
 * worse, filled in with a guess. The shape of the tournament is knowable today;
 * who wins it is not.
 */
export default function PlayoffPreview({
  seeded,
  initial,
  seasonWeeks,
}: {
  /** Every team in current standings order. */
  seeded: SeedRow[];
  initial: number;
  seasonWeeks: number;
}) {
  const [size, setSize] = useState(initial);

  const rounds = bracketRounds(size);
  const bracket = 2 ** rounds;
  const byes = size > 0 ? bracket - size : 0;
  // The bracket occupies the closing weeks; the league programme keeps running
  // through them, so this is where the bracket starts rather than where the
  // season stops.
  const playoffStart = seasonWeeks - rounds + 1;

  const choices = Array.from({ length: Math.max(seeded.length - 1, 0) }, (_, i) => i + 2);

  /**
   * Who arrives in a given slot.
   *
   * A round-one bye resolves to the team itself — they are through, and
   * "Winner of Cigarette FC" would be nonsense. Everything else is the winner
   * of a tie that hasn't been played.
   */
  const feedFor = (round: number, slot: number): Feed => {
    if (round === 1) {
      const home = seeded[slot - 1];
      const awaySeed = bracket + 1 - slot;
      const away = awaySeed <= size ? seeded[awaySeed - 1] : undefined;

      if (!away) {
        return { kind: "team", name: home?.name ?? "—", seed: slot };
      }
      return { kind: "winner", label: `${slot} v ${awaySeed}` };
    }

    const name = roundName(round, rounds);
    const slots = bracket / 2 ** round;
    return { kind: "winner", label: slots === 1 ? name : `${singular(name)} ${slot}` };
  };

  const teamRow = (team: SeedRow | null, seed: number) => (
    <span className="flex items-center gap-2 px-2 py-1.5">
      <span className="numeric text-xs dim">{seed}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{team?.name ?? "—"}</span>
    </span>
  );

  const byeRow = () => (
    <span className="px-2 py-1.5 text-xs dim">bye — straight through</span>
  );

  const feedRow = (feed: Feed) =>
    feed.kind === "team" ? (
      <span className="flex items-center gap-2 px-2 py-1.5">
        <span className="numeric text-xs dim">{feed.seed}</span>
        <span className="min-w-0 flex-1 truncate text-sm">{feed.name}</span>
        <span className="text-[10px] uppercase tracking-wide dim">bye</span>
      </span>
    ) : (
      <span className="block px-2 py-1.5 text-sm dim">Winner of {feed.label}</span>
    );

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="muted">Playoff teams</span>
        <select
          name="playoff_teams"
          value={String(size)}
          onChange={(event) => setSize(Number(event.target.value))}
          className="select w-full sm:w-72"
          suppressHydrationWarning
        >
          <option value="0">No playoffs — league title only</option>
          {choices.map((count) => {
            const spare = 2 ** bracketRounds(count) - count;
            const missing = seeded.length - count;
            const parts = [`${count} teams`];
            if (spare > 0)
              parts.push(spare === 1 ? "top seed gets a bye" : `top ${spare} seeds get byes`);
            if (missing > 0)
              parts.push(missing === 1 ? "last place misses out" : `bottom ${missing} miss out`);
            return (
              <option key={count} value={String(count)}>
                {parts.join(" · ")}
              </option>
            );
          })}
        </select>
      </label>

      {size === 0 ? (
        <p className="text-xs dim">
          One trophy, decided on record over all {seasonWeeks} gameweeks.
        </p>
      ) : (
        <div className="rounded-lg border border-[var(--border)] p-3">
          <p className="text-xs uppercase tracking-wide dim">If the playoffs started today</p>

          {/* Columns that scroll sideways rather than reflowing. A bracket that
              wraps stops reading as a bracket. */}
          <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
            {Array.from({ length: rounds }, (_, index) => index + 1).map((round) => {
              const slots = bracket / 2 ** round;

              return (
                <div key={round} className="flex min-w-[13rem] flex-1 flex-col">
                  <p className="text-[10px] uppercase tracking-wide dim">
                    {roundName(round, rounds)}
                    <span className="ml-1 normal-case">· GW{playoffStart + round - 1}</span>
                  </p>

                  <div className="mt-1.5 flex flex-1 flex-col justify-around gap-2">
                    {Array.from({ length: slots }, (_, index) => index + 1).map((slot) => {
                      // Round one is the only place real teams are known. Every
                      // later round is described by what feeds it.
                      const awaySeed = bracket + 1 - slot;
                      const away = awaySeed <= size ? (seeded[awaySeed - 1] ?? null) : null;

                      return (
                        <div
                          key={slot}
                          className="rounded-md border border-[var(--border)] bg-[var(--surface)]"
                        >
                          <div className="flex flex-col divide-y divide-[var(--border)]">
                            {round === 1 ? (
                              <>
                                {teamRow(seeded[slot - 1] ?? null, slot)}
                                {away ? teamRow(away, awaySeed) : byeRow()}
                              </>
                            ) : (
                              <>
                                {feedRow(feedFor(round - 1, 2 * slot - 1))}
                                {feedRow(feedFor(round - 1, 2 * slot))}
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {seeded.length > size ? (
            <p className="mt-3 text-xs" style={{ color: "var(--warning)" }}>
              Out: {seeded.slice(size).map((team) => team.name).join(", ")}
            </p>
          ) : null}

          <p className="mt-1 text-xs dim">
            {byes > 0
              ? `${byes === 1 ? "One team rests" : `${byes} teams rest`} in round one — a bracket of ${bracket} with ${size} in it. `
              : ""}
            League fixtures continue through gameweek {seasonWeeks} alongside the bracket,
            so nobody has a dead week and the table is still decided on the final day.
            Seeding is today&apos;s standings and will move — it locks when the bracket
            opens in gameweek {playoffStart}.
          </p>
        </div>
      )}
    </div>
  );
}
