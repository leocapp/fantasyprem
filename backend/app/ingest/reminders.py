"""Email managers who haven't set a lineup before the deadline.

    python -m app.ingest.reminders

Sends through Resend. Does nothing at all unless RESEND_API_KEY is set, so the
rest of the scheduled job runs fine without email configured.

Every send is recorded in notifications_sent before it goes out, and the
database's unique constraint is what stops duplicates — not this script's
bookkeeping. The job runs hourly and would otherwise re-send the same nudge
every hour until the deadline passed.
"""

from __future__ import annotations

import sys
from typing import Any

import httpx

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

RESEND_ENDPOINT = "https://api.resend.com/emails"


def subject_line(row: dict[str, Any]) -> str:
    if row["carries_forward"]:
        return f"Gameweek {row['gameweek_number']}: last week's lineup will be reused"
    return f"Gameweek {row['gameweek_number']}: you haven't set a lineup"


def body(row: dict[str, Any], site_url: str) -> str:
    link = f"{site_url}/leagues/{row['league_id']}/team"
    hours = max(1, round((row["hours_left"] or 1)))

    if row["carries_forward"]:
        opening = (
            f"You haven't set a lineup for gameweek {row['gameweek_number']}, so your previous "
            "one will be used automatically — minus anyone you no longer own."
        )
    else:
        opening = (
            f"You haven't set a lineup for gameweek {row['gameweek_number']}. Without one you'll "
            "score nothing this week."
        )

    return f"""<div style="font-family: system-ui, sans-serif; max-width: 32rem;">
  <h2 style="margin-bottom: 0.25rem;">{row["team_name"]}</h2>
  <p style="color: #64748b; margin-top: 0;">{row["league_name"]}</p>
  <p>{opening}</p>
  <p>The deadline is in about {hours} hour{"s" if hours != 1 else ""}.</p>
  <p><a href="{link}" style="background:#10b981;color:#04231a;padding:0.6rem 1rem;
     border-radius:0.5rem;text-decoration:none;font-weight:600;">Set your lineup</a></p>
  <p style="color:#94a3b8;font-size:0.8rem;margin-top:2rem;">
    You can turn these off on your account page, or ask your commissioner to
    disable them for the whole league.
  </p>
</div>"""


def send(client: httpx.Client, api_key: str, sender: str, to: str, subject: str, html: str) -> None:
    response = client.post(
        RESEND_ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"from": sender, "to": [to], "subject": subject, "html": html},
    )
    if response.is_error:
        raise RuntimeError(f"Resend rejected the message ({response.status_code}): {response.text}")


def main() -> int:
    settings = get_settings()

    if not settings.resend_api_key:
        print("  RESEND_API_KEY not set — skipping reminders")
        return 0

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.", file=sys.stderr)
        return 1

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        due = db.rpc("lineup_reminders_due", {})

        if not due:
            print("  no reminders due")
            return 0

        sent = 0
        with httpx.Client(timeout=30.0) as client:
            for row in due:
                # Claim it first. If this insert fails on the unique constraint,
                # another run already sent it and we skip rather than duplicate.
                try:
                    db.upsert(
                        "notifications_sent",
                        [
                            {
                                "kind": "lineup_reminder",
                                "fantasy_team_id": row["fantasy_team_id"],
                                "subject_id": row["gameweek_id"],
                            }
                        ],
                        on_conflict="kind,fantasy_team_id,subject_id",
                    )
                except RuntimeError as error:
                    print(f"  skipped {row['team_name']}: {error}")
                    continue

                try:
                    send(
                        client,
                        settings.resend_api_key,
                        settings.reminder_from,
                        row["email"],
                        subject_line(row),
                        body(row, settings.site_url),
                    )
                    sent += 1
                except RuntimeError as error:
                    # Left claimed deliberately: a broken address or a provider
                    # outage shouldn't turn into hourly retries into the void.
                    print(f"  failed for {row['team_name']}: {error}", file=sys.stderr)

        print(f"  sent {sent} reminder(s)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
