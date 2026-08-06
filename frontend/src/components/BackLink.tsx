"use client";

import { useRouter } from "next/navigation";

/**
 * Returns to wherever you came from, rather than a fixed destination.
 *
 * Player and matchup pages are reached from several places — the lineup
 * screen, free agents, the draft room, a team's squad — and a hardcoded link
 * sends people somewhere they weren't. Falls back to a sensible page when
 * there's no history, which happens on a shared link or a fresh tab.
 */
export default function BackLink({
  fallbackHref,
  fallbackLabel,
}: {
  fallbackHref: string;
  fallbackLabel: string;
}) {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
      className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
    >
      ← Back
      <span className="sr-only"> to {fallbackLabel}</span>
    </button>
  );
}
