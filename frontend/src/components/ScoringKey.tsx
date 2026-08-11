"use client";

import { useEffect, useRef, useState } from "react";

/**
 * What this player's actions are worth, under this league's rules.
 *
 * Generated from scoring_rules rather than hardcoded, so a commissioner
 * changing a value changes this too. Only rules that can apply to their
 * position are shown — a forward has no line for saves — which the schema
 * already expresses: applies_to holds a position, or null for everyone.
 *
 * It floats rather than sitting in the page. A scoring key is something you
 * check against what you're already looking at, so pushing the gameweek strip
 * further down the page to make room for it costs more than it gives.
 */
export type ScoringRule = {
  stat_key: string;
  applies_to: string | null;
  points: number;
};

// Labelled as the event, not the column: "Goal", not "goals". Kept terse
// because the panel is narrow — the two divided rules are the only ones that
// need their divisor spelled out, since those are the ones people get wrong.
const LABELS: Record<string, string> = {
  minutes_played: "1–59 mins",
  minutes_full: "60+ mins",
  goals: "Goal",
  assists: "Assist",
  clean_sheet: "Clean sheet",
  goals_conceded_2: "Per 2 conceded",
  saves_3: "Per 3 saves",
  penalties_saved: "Penalty saved",
  penalties_missed: "Penalty missed",
  own_goals: "Own goal",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  shots_on_target: "Shot on target",
  key_passes: "Key pass",
  tackles: "Tackle",
  interceptions: "Interception",
  big_chances_created: "Big chance created",
  duels_won: "Duel won",
};

// Reading order: turning up, then attacking, then defending, then punishment.
// Alphabetical would put "Own goal" between "Key pass" and "Penalty saved".
const ORDER = [
  "minutes_played",
  "minutes_full",
  "goals",
  "assists",
  "big_chances_created",
  "key_passes",
  "shots_on_target",
  "clean_sheet",
  "saves_3",
  "penalties_saved",
  "goals_conceded_2",
  "tackles",
  "interceptions",
  "duels_won",
  "penalties_missed",
  "own_goals",
  "yellow_cards",
  "red_cards",
];

/**
 * Resolve each stat to the points this position earns for it, using the same
 * precedence the scoring function uses: a rule naming the position beats the
 * one that applies to everybody.
 */
export function rulesForPosition(rules: ScoringRule[], position: string) {
  const keys = [...new Set(rules.map((rule) => rule.stat_key))];

  return keys
    .map((key) => {
      const forPosition = rules.find(
        (rule) => rule.stat_key === key && rule.applies_to === position,
      );
      const forEveryone = rules.find(
        (rule) => rule.stat_key === key && rule.applies_to === null,
      );
      const match = forPosition ?? forEveryone;

      // A stat scored only for other positions — saves for a forward. Not zero,
      // simply not applicable, so it shouldn't appear at all.
      if (!match) return null;

      return { key, points: Number(match.points) };
    })
    .filter((row): row is { key: string; points: number } => row !== null)
    .sort((a, b) => {
      const left = ORDER.indexOf(a.key);
      const right = ORDER.indexOf(b.key);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    });
}

export default function ScoringKey({
  rules,
  position,
  leagueId,
}: {
  rules: ScoringRule[];
  position: string;
  leagueId: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a tap anywhere else — a floating panel that can
  // only be dismissed by finding its button again is a trap on a phone.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const resolved = rulesForPosition(rules, position);
  if (resolved.length === 0) return null;

  const scoring = resolved.filter((row) => row.points !== 0);
  const unused = resolved.filter((row) => row.points === 0);

  return (
    <div
      ref={panel}
      // Above the content but below the nav bar's own layer, and inset far
      // enough to clear the iOS home indicator.
      className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 print:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {open ? (
        <div
          className="w-64 overflow-hidden rounded-[var(--radius)] border shadow-xl"
          style={{
            background: "var(--surface-raised)",
            borderColor: "var(--border-strong)",
            boxShadow: "0 12px 32px rgb(0 0 0 / 0.45)",
          }}
        >
          <div
            className="flex items-baseline justify-between border-b px-3 py-2"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="text-xs font-semibold">{position} scoring</span>
            <span className="text-[10px] dim">this league</span>
          </div>

          {/* Capped so a league that scores every stat can't grow a panel
              taller than a phone screen. */}
          <dl className="max-h-[50vh] overflow-y-auto px-3 py-1.5 text-[11px]">
            {scoring.map(({ key, points }) => (
              <div key={key} className="flex justify-between gap-3 py-[3px]">
                <dt className="dim">{LABELS[key] ?? key}</dt>
                <dd
                  className={`numeric shrink-0 ${points < 0 ? "text-[var(--danger)]" : ""}`}
                >
                  {points > 0 ? "+" : ""}
                  {points}
                </dd>
              </div>
            ))}
          </dl>

          {unused.length > 0 ? (
            <p
              className="border-t px-3 py-1.5 text-[10px] dim"
              style={{ borderColor: "var(--border)" }}
            >
              Not scored here: {unused.map((row) => (LABELS[row.key] ?? row.key).toLowerCase()).join(", ")}.{" "}
              <a href={`/leagues/${leagueId}/settings`} className="underline">
                Settings
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg transition-colors"
        style={{
          background: open ? "var(--accent-soft)" : "var(--surface-raised)",
          borderColor: open ? "var(--accent)" : "var(--border-strong)",
          boxShadow: "0 6px 18px rgb(0 0 0 / 0.4)",
        }}
      >
        {open ? "Close" : `${position} scoring`}
      </button>
    </div>
  );
}
