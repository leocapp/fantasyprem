/**
 * Date formatting with an explicit timezone.
 *
 * Server components render on the host, which runs in UTC — a 15:30 kickoff
 * would read 14:30 to a UK reader in summer. Vercel reserves the TZ variable,
 * so the zone is stated here instead of set on the environment.
 *
 * Change LEAGUE_TIMEZONE if your league isn't UK-based. Doing this properly for
 * a mixed-timezone league means formatting in the browser instead.
 */
export const LEAGUE_TIMEZONE = "Europe/London";

export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: LEAGUE_TIMEZONE,
  });
}

export function formatDeadline(value: string | Date): string {
  return new Date(value).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: LEAGUE_TIMEZONE,
  });
}
