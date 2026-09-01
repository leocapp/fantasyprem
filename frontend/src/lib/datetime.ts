/**
 * Date formatting with an explicit timezone.
 *
 * Server components render on the host, which runs in UTC — a 15:30 kickoff
 * would read 15:30 UTC, three hours off, to a reader in Connecticut. Vercel
 * reserves the TZ variable, so the zone is stated here instead of set on the
 * environment.
 *
 * The zone is the league's, not the reader's: everyone sees the same clock, so
 * "the deadline is 9:50" means the same thing to everyone in the chat. Doing it
 * per-reader means formatting in the browser, which is worth it only once a
 * league spans zones.
 *
 * America/New_York rather than a fixed offset, so it follows EST and EDT by
 * itself — the Premier League and the US change clocks on different dates, and
 * for two weeks each spring a hardcoded offset would be an hour wrong.
 */
export const LEAGUE_TIMEZONE = "America/New_York";

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: LEAGUE_TIMEZONE,
  });
}

/**
 * "3 minutes ago", "yesterday", "5 days ago".
 *
 * Call this on the server and pass the result down as a finished string. Doing
 * it inside a client component puts Date.now() in a render path, which is the
 * hydration mismatch React warns about — and this codebase has already been
 * bitten twice by dates that differed between server and browser.
 */
export function relativeTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;

  const then = new Date(typeof value === "string" ? value.replace(" ", "T") : value).getTime();
  if (Number.isNaN(then)) return null;

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function formatDeadline(value: string | Date): string {
  return new Date(value).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: LEAGUE_TIMEZONE,
  });
}
