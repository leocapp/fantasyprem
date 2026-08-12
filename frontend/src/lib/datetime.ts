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
