"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import AvailabilityFlag from "@/components/AvailabilityFlag";

export type SquadPlayer = {
  id: string;
  name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  shirtNumber: number | null;
  club: string;
  availability: string | null;
  news: string | null;
  chance: number | null;
  fixture: string;
  lastPoints: number | null;
  lastMinutes: number | null;
};

export type Formation = {
  code: string;
  defenders: number;
  midfielders: number;
  forwards: number;
};

type Assignments = Record<"GK" | "DEF" | "MID" | "FWD", (string | null)[]>;

const ROWS = ["FWD", "MID", "DEF", "GK"] as const;

function buildAssignments(formation: Formation, keep: Assignments | null): Assignments {
  const sizes = { GK: 1, DEF: formation.defenders, MID: formation.midfielders, FWD: formation.forwards };

  return (Object.keys(sizes) as (keyof typeof sizes)[]).reduce((acc, position) => {
    const existing = keep?.[position] ?? [];
    // Keep whoever already fits; drop the overflow when a line gets shorter.
    acc[position] = Array.from({ length: sizes[position] }, (_, i) => existing[i] ?? null);
    return acc;
  }, {} as Assignments);
}

/** A plain grey shirt. FPL doesn't publish kit colours. */
function Shirt({ number, muted }: { number: number | null; muted?: boolean }) {
  return (
    <span className="relative block h-9 w-10">
      <svg viewBox="0 0 40 36" className="h-full w-full" aria-hidden>
        <path
          d="M12 2 L4 7 L7 14 L11 12 L11 34 L29 34 L29 12 L33 14 L36 7 L28 2 L24 5 Q20 8 16 5 Z"
          fill={muted ? "var(--surface-raised)" : "#94a3b8"}
          stroke="var(--border-strong)"
        />
      </svg>
      {number ? (
        <span className="absolute inset-0 flex items-center justify-center pt-1 text-[10px] font-bold text-slate-900">
          {number}
        </span>
      ) : null}
    </span>
  );
}

export default function PitchLineup({
  players,
  formations,
  initialFormation,
  initialStarters,
  initialCaptain,
  initialVice,
  gameweekNumber,
  deadlineLabel,
  teamName,
  leagueId,
}: {
  players: SquadPlayer[];
  formations: Formation[];
  initialFormation: string;
  initialStarters: string[];
  initialCaptain: string | null;
  initialVice: string | null;
  gameweekNumber: number;
  deadlineLabel: string;
  teamName: string;
  leagueId: string;
}) {
  const byId = useMemo(() => new Map(players.map((player) => [player.id, player])), [players]);

  const [formationCode, setFormationCode] = useState(initialFormation);
  const formation =
    formations.find((row) => row.code === formationCode) ?? formations[0] ?? {
      code: "4-4-2",
      defenders: 4,
      midfielders: 4,
      forwards: 2,
    };

  const [assignments, setAssignments] = useState<Assignments>(() => {
    const empty = buildAssignments(formation, null);
    // Seed each line from the saved lineup, in position order.
    for (const position of ["GK", "DEF", "MID", "FWD"] as const) {
      const ids = initialStarters.filter((id) => byId.get(id)?.position === position);
      empty[position] = empty[position].map((_, index) => ids[index] ?? null);
    }
    return empty;
  });

  const [captain, setCaptain] = useState<string | null>(initialCaptain);
  const [vice, setVice] = useState<string | null>(initialVice);
  const [picking, setPicking] = useState<{ position: keyof Assignments; index: number } | null>(null);

  const selected = useMemo(
    () => new Set(Object.values(assignments).flat().filter((id): id is string => Boolean(id))),
    [assignments],
  );

  const bench = players.filter((player) => !selected.has(player.id));
  const starterCount = selected.size;

  function changeFormation(code: string) {
    const next = formations.find((row) => row.code === code);
    if (!next) return;
    setFormationCode(code);
    setAssignments((current) => buildAssignments(next, current));
  }

  function assign(position: keyof Assignments, index: number, playerId: string | null) {
    setAssignments((current) => {
      const next: Assignments = {
        GK: [...current.GK],
        DEF: [...current.DEF],
        MID: [...current.MID],
        FWD: [...current.FWD],
      };

      // A player can only occupy one slot, so clear any previous one.
      if (playerId) {
        for (const key of Object.keys(next) as (keyof Assignments)[]) {
          next[key] = next[key].map((id) => (id === playerId ? null : id));
        }
      }

      const removed = current[position][index];
      next[position][index] = playerId;

      if (removed) {
        if (captain === removed) setCaptain(null);
        if (vice === removed) setVice(null);
      }

      return next;
    });

    setPicking(null);
  }

  const eligible = picking
    ? players.filter(
        (player) => player.position === picking.position && !selected.has(player.id),
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/* The server action reads these; the pitch is just a way of setting them. */}
      {Array.from(selected).map((id) => (
        <input key={id} type="hidden" name="starter" value={id} />
      ))}
      {captain ? <input type="hidden" name="captain" value={captain} /> : null}
      {vice ? <input type="hidden" name="vice" value={vice} /> : null}
      <input type="hidden" name="formation" value={formationCode} />

      {/* Scoreboard header: the gameweek is the single most important piece of
          context on this screen, so it gets stated loudly rather than inferred
          from a subtitle. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-3">
        <div>
          <p className="numeric text-xs tracking-[0.2em] text-[var(--text-dim)]">
            {formationCode}
          </p>
          <h2 className="text-xl font-bold tracking-tight">
            Starting XI · Gameweek {gameweekNumber}
          </h2>
          <p className="text-xs dim">
            {teamName} · locks {deadlineLabel}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={formationCode}
            onChange={(event) => changeFormation(event.target.value)}
            className="select"
            aria-label="Formation"
            suppressHydrationWarning
          >
            {formations.map((row) => (
              <option key={row.code} value={row.code}>
                {row.code}
              </option>
            ))}
          </select>
          <span
            className={`numeric text-sm ${
              starterCount === 11 ? "dim" : "text-[var(--warning)]"
            }`}
          >
            {starterCount}/11
          </span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex flex-col gap-4">
      {/* Pitch */}
      <div
        className="relative flex flex-col justify-between gap-2 rounded-lg p-3 sm:p-5"
        style={{
          background:
            "repeating-linear-gradient(to bottom, #1f6f47 0 40px, #1c6642 40px 80px)",
          border: "1px solid var(--border-strong)",
          minHeight: "26rem",
        }}
      >
        {/* Markings */}
        <div
          className="pointer-events-none absolute inset-3 rounded"
          style={{ border: "2px solid rgb(255 255 255 / 0.25)" }}
        />
        <div
          className="pointer-events-none absolute left-1/2 top-3 h-px w-[calc(100%-1.5rem)] -translate-x-1/2"
          style={{ background: "rgb(255 255 255 / 0.25)", top: "50%" }}
        />
        <div
          className="pointer-events-none absolute left-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ border: "2px solid rgb(255 255 255 / 0.25)", top: "50%" }}
        />

        {ROWS.map((position) => (
          <div key={position} className="relative flex flex-wrap justify-center gap-2 sm:gap-4">
            {assignments[position].map((playerId, index) => {
              const player = playerId ? byId.get(playerId) : undefined;
              const isPicking = picking?.position === position && picking.index === index;

              return (
                <button
                  key={`${position}-${index}`}
                  type="button"
                  onClick={() => setPicking(isPicking ? null : { position, index })}
                  className={`flex w-[4.75rem] flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-center transition-colors sm:w-24 ${
                    isPicking ? "bg-black/40 ring-2 ring-white/60" : "hover:bg-black/25"
                  }`}
                >
                  <Shirt number={player?.shirtNumber ?? null} muted={!player} />
                  <span className="w-full truncate text-[11px] font-medium text-white">
                    {player?.name ?? "Empty"}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-white/70">
                    {player ? player.club : position}
                    {player ? (
                      <AvailabilityFlag
                        availability={player.availability}
                        news={player.news}
                        chance={player.chance}
                      />
                    ) : null}
                  </span>
                  {player ? (
                    <span className="flex gap-1">
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setCaptain(player.id);
                          if (vice === player.id) setVice(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") setCaptain(player.id);
                        }}
                        className={`rounded px-1 text-[9px] font-bold ${
                          captain === player.id
                            ? "bg-amber-400 text-slate-900"
                            : "bg-white/20 text-white/70"
                        }`}
                      >
                        C
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setVice(player.id);
                          if (captain === player.id) setCaptain(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") setVice(player.id);
                        }}
                        className={`rounded px-1 text-[9px] font-bold ${
                          vice === player.id
                            ? "bg-white text-slate-900"
                            : "bg-white/20 text-white/70"
                        }`}
                      >
                        V
                      </span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Picker for the tapped slot */}
      {picking ? (
        <div className="card">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Choose a {picking.position}</h3>
            <button type="button" onClick={() => setPicking(null)} className="text-xs dim">
              Close
            </button>
          </div>

          <ul className="list mt-3 max-h-72 overflow-y-auto">
            {assignments[picking.position][picking.index] ? (
              <li>
                <button
                  type="button"
                  onClick={() => assign(picking.position, picking.index, null)}
                  className="row w-full text-left text-sm"
                  style={{ color: "var(--danger)" }}
                >
                  Leave this slot empty
                </button>
              </li>
            ) : null}

            {eligible.map((player) => (
              <li key={player.id}>
                <button
                  type="button"
                  onClick={() => assign(picking.position, picking.index, player.id)}
                  className="row w-full text-left"
                >
                  <Shirt number={player.shirtNumber} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{player.name}</span>
                      <AvailabilityFlag
                        availability={player.availability}
                        news={player.news}
                        chance={player.chance}
                      />
                    </span>
                    <span className="block truncate text-xs dim">
                      {player.club} · {player.fixture}
                      {player.lastPoints !== null
                        ? ` · last: ${player.lastPoints} pts${
                            player.lastMinutes !== null ? `, ${player.lastMinutes}'` : ""
                          }`
                        : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}

            {eligible.length === 0 ? (
              <li className="row text-sm dim">
                Nobody left on your bench for this position.
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

          <button
            className="btn btn-primary"
            disabled={starterCount !== 11 || !captain || !vice || captain === vice}
          >
            Save lineup
          </button>

          {starterCount !== 11 || !captain || !vice ? (
            <p className="text-xs dim">
              Needs eleven players, a captain and a vice-captain. Tap a shirt to fill a slot, then
              use the C and V badges.
            </p>
          ) : null}
        </div>

        {/* Squad reference: fixed order, always visible, never reshuffles as
            you pick. Sorted by position so it reads like a team sheet. */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <h3 className="section-label">Squad · gameweek {gameweekNumber}</h3>
          <ul className="list mt-2 lg:max-h-[34rem] lg:overflow-y-auto">
            {players.map((player) => {
              const starting = selected.has(player.id);

              return (
                <li
                  key={player.id}
                  className="row gap-2"
                  style={starting ? undefined : { opacity: 0.65 }}
                >
                  <span className={`badge badge-${player.position}`}>{player.position}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <Link
                        href={`/leagues/${leagueId}/players/${player.id}`}
                        className="truncate text-sm font-medium hover:underline"
                      >
                        {player.name}
                      </Link>
                      <AvailabilityFlag
                        availability={player.availability}
                        news={player.news}
                        chance={player.chance}
                      />
                      {captain === player.id ? (
                        <span className="rounded bg-amber-500/20 px-1 text-[9px] font-bold text-amber-300">
                          C
                        </span>
                      ) : null}
                      {vice === player.id ? (
                        <span className="rounded bg-[var(--surface-raised)] px-1 text-[9px] font-bold text-[var(--text-muted)]">
                          V
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs dim">
                      {player.club} · {player.fixture}
                      {player.lastPoints !== null
                        ? ` · last ${player.lastPoints} pts${
                            player.lastMinutes !== null ? `, ${player.lastMinutes}'` : ""
                          }`
                        : ""}
                    </span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wide dim">
                    {starting ? "XI" : "bench"}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs dim">
            {bench.length} on the bench · they score nothing unless you start them.
          </p>
        </aside>
      </div>
    </div>
  );
}
