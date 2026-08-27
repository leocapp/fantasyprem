"""Email managers about their team.

    python -m app.ingest.reminders

Three messages, all on the same rails:

  lineup_reminder   you haven't picked an XI and the deadline is close
  injured_starter   you have picked one, and somebody in it has been ruled out
  gameweek_recap    the gameweek is settled — here's how it went

Sends through Resend. Does nothing at all unless RESEND_API_KEY is set, so the
rest of the scheduled job runs fine without email configured.

Every send is recorded in notifications_sent before it goes out, and the
database's unique constraint is what stops duplicates — not this script's
bookkeeping. The job runs hourly and would otherwise re-send the same message
every hour until the deadline passed.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from typing import Any, Callable

import httpx

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

RESEND_ENDPOINT = "https://api.resend.com/emails"

# players.availability, spelled out. 'a' never reaches these emails.
STATUS = {"i": "injured", "s": "suspended", "d": "doubtful"}

SHELL = """<div style="font-family: system-ui, sans-serif; max-width: 32rem;">
  <h2 style="margin-bottom: 0.25rem;">{heading}</h2>
  <p style="color: #64748b; margin-top: 0;">{sub}</p>
  {body}
  <p style="color:#94a3b8;font-size:0.8rem;margin-top:2rem;">
    You can turn these off on your account page, or ask your commissioner to
    disable them for the whole league.
  </p>
</div>"""

BUTTON = (
    '<p><a href="{link}" style="background:#10b981;color:#04231a;padding:0.6rem 1rem;'
    'border-radius:0.5rem;text-decoration:none;font-weight:600;">{label}</a></p>'
)


SUFFIXES = {1: "st", 2: "nd", 3: "rd"}


def ordinal(value: int) -> str:
    if 10 <= value % 100 <= 20:
        return f"{value}th"
    return f"{value}{SUFFIXES.get(value % 10, 'th')}"


def plural(count: float, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def score(value: Any) -> str:
    """63.50 as "63.5", 63.00 as "63". Nobody writes a scoreline to two places."""
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return str(value)


def hours_until(value: Any) -> int:
    """Whole hours from now until a Postgres timestamp, floored at one.

    The reminder query returns deadline_at, not a countdown — this used to read
    a hours_left column that the function has never had, which would have been a
    KeyError on the first message it ever tried to send.
    """
    if not value:
        return 1

    try:
        when = datetime.fromisoformat(str(value).replace(" ", "T").replace("Z", "+00:00"))
    except ValueError:
        return 1

    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)

    return max(1, round((when - datetime.now(timezone.utc)).total_seconds() / 3600))


# ------------------------------------------------------------ lineup nudge ----


def lineup_subject(row: dict[str, Any]) -> str:
    if row["carries_forward"]:
        return f"Gameweek {row['gameweek_number']}: last week's lineup will be reused"
    return f"Gameweek {row['gameweek_number']}: you haven't set a lineup"


def lineup_body(row: dict[str, Any], site_url: str) -> str:
    hours = hours_until(row.get("deadline_at"))

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

    body = (
        f"<p>{opening}</p>"
        f"<p>The deadline is in about {plural(hours, 'hour')}.</p>"
        + BUTTON.format(link=f"{site_url}/leagues/{row['league_id']}/team", label="Set your lineup")
    )

    return SHELL.format(heading=row["team_name"], sub=row["league_name"], body=body)


# --------------------------------------------------------- injured starter ----


def injured_subject(row: dict[str, Any]) -> str:
    names = [player["name"] for player in row["players"]]
    if len(names) == 1:
        return f"Gameweek {row['gameweek_number']}: {names[0]} is in your XI and may not play"
    return f"Gameweek {row['gameweek_number']}: {len(names)} of your starters may not play"


def injured_body(row: dict[str, Any], site_url: str) -> str:
    items = []
    for player in row["players"]:
        status = STATUS.get(player.get("availability") or "", "unavailable")
        detail = player.get("news") or ""
        back = player.get("expected_return")
        tail = f" · back {back}" if back else " · no return date"
        items.append(
            f"<li style='margin-bottom:0.35rem;'><strong>{player['name']}</strong> "
            f"({player['position']}) — {status}{tail}"
            + (f"<br><span style='color:#64748b;font-size:0.85rem;'>{detail}</span>" if detail else "")
            + "</li>"
        )

    # Doubtful is not the same as out, and saying so is the difference between a
    # useful warning and one people learn to ignore.
    body = (
        f"<p>Your lineup for gameweek {row['gameweek_number']} is set, but "
        f"{'one of your starters has' if len(items) == 1 else 'some of your starters have'} "
        "been flagged since:</p>"
        f"<ul style='padding-left:1.1rem;'>{''.join(items)}</ul>"
        "<p>Doubtful players often start anyway — injured and suspended ones won't.</p>"
        + BUTTON.format(link=f"{site_url}/leagues/{row['league_id']}/team", label="Change your lineup")
    )

    return SHELL.format(heading=row["team_name"], sub=row["league_name"], body=body)


# ----------------------------------------------------------------- recap ----


def recap_subject(row: dict[str, Any]) -> str:
    verb = {"win": "beat", "loss": "lost to", "draw": "drew with"}[row["outcome"]]
    return (
        f"Gameweek {row['gameweek_number']}: {row['team_name']} "
        f"{verb} {row['opponent_name']}, {score(row['points'])}–{score(row['opponent_points'])}"
    )


def recap_body(row: dict[str, Any], site_url: str) -> str:
    outcome = {
        "win": f"You beat {row['opponent_name']}",
        "loss": f"You lost to {row['opponent_name']}",
        "draw": f"You drew with {row['opponent_name']}",
    }[row["outcome"]]

    # The field is not a team, so it doesn't take an article the way a name does.
    bye = row["opponent_name"] == "the field"

    body = (
        f"<p style='font-size:1.4rem;margin-bottom:0.25rem;'>"
        f"<strong>{score(row['points'])}</strong> – {score(row['opponent_points'])}</p>"
        f"<p>{outcome}"
        + (
            " — you were on a bye, so you played the average of everyone else."
            if bye
            else "."
        )
        + "</p>"
        f"<p>That puts you {ordinal(int(row['standing']))} of {row['teams_in_league']}, "
        f"{row['wins']}–{row['losses']}"
        + (f"–{row['draws']}" if row["draws"] else "")
        + ".</p>"
        + BUTTON.format(link=f"{site_url}/leagues/{row['league_id']}", label="See the table")
    )

    return SHELL.format(heading=row["team_name"], sub=row["league_name"], body=body)


# ----------------------------------------------------------------- plumbing ----


def send(client: httpx.Client, api_key: str, sender: str, to: str, subject: str, html: str) -> None:
    response = client.post(
        RESEND_ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        json={"from": sender, "to": [to], "subject": subject, "html": html},
    )
    if response.is_error:
        raise RuntimeError(f"Resend rejected the message ({response.status_code}): {response.text}")


def deliver(
    db: SupabaseRest,
    client: httpx.Client,
    settings: Any,
    kind: str,
    rows: list[dict[str, Any]],
    subject_of: Callable[[dict[str, Any]], str],
    body_of: Callable[[dict[str, Any], str], str],
) -> int:
    """Claim each row, then send it. Shared by all three messages.

    The claim goes first on purpose. If the insert fails on the unique
    constraint another run already sent this one, so we skip rather than
    duplicate — the database decides, not our own bookkeeping.
    """
    sent = 0

    for row in rows:
        try:
            db.upsert(
                "notifications_sent",
                [
                    {
                        "kind": kind,
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
                subject_of(row),
                body_of(row, settings.site_url),
            )
            sent += 1
        except RuntimeError as error:
            # Left claimed deliberately: a broken address or a provider outage
            # shouldn't turn into hourly retries into the void.
            print(f"  failed for {row['team_name']}: {error}", file=sys.stderr)

    return sent


PASSES = (
    ("lineup_reminder", "lineup_reminders_due", lineup_subject, lineup_body, "lineup reminder"),
    ("injured_starter", "injured_starters_due", injured_subject, injured_body, "injury warning"),
    ("gameweek_recap", "gameweek_recaps_due", recap_subject, recap_body, "recap"),
)


def main() -> int:
    settings = get_settings()

    if not settings.resend_api_key:
        print("  RESEND_API_KEY not set — skipping reminders")
        return 0

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.", file=sys.stderr)
        return 1

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        with httpx.Client(timeout=30.0) as client:
            for kind, rpc, subject_of, body_of, label in PASSES:
                # One failing pass shouldn't stop the others: a broken recap
                # query is no reason to withhold a deadline reminder.
                try:
                    due = db.rpc(rpc, {}) or []
                except RuntimeError as error:
                    print(f"  {label}s: could not load ({error})", file=sys.stderr)
                    continue

                if not due:
                    print(f"  no {label}s due")
                    continue

                sent = deliver(db, client, settings, kind, due, subject_of, body_of)
                print(f"  sent {plural(sent, label)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
