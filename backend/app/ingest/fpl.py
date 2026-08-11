"""Ingest Premier League reference data from the Fantasy Premier League API.

    ALLOW_FPL_INGEST=1 python -m app.ingest.fpl

RETIRED. Sportmonks is the live provider (app.ingest.sportmonks); this module is
kept only as the revert path if that arrangement doesn't work out. It refuses to
run without ALLOW_FPL_INGEST set — see the note on the guard below for why.

Pulls clubs, gameweeks, players and fixtures into Supabase. Safe to re-run
against an FPL-shaped database: every write is an upsert keyed on the provider's
own id, so running it again refreshes prices, injuries, scores and fixture
status without duplicating rows.

These endpoints are public but undocumented and unofficial. They can change
shape without notice, so failures here are expected occasionally.
"""

from __future__ import annotations

import os
import sys
from typing import Any

import httpx

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

FPL_BASE = "https://fantasy.premierleague.com/api"
BOOTSTRAP_URL = f"{FPL_BASE}/bootstrap-static/"
FIXTURES_URL = f"{FPL_BASE}/fixtures/"

CREST_URL = "https://resources.premierleague.com/premierleague/badges/70/t{code}.png"
# FPL gives `photo` as "223094.jpg"; the CDN serves the same id as a .png.
PHOTO_URL = "https://resources.premierleague.com/premierleague/photos/players/110x140/p{code}.png"

# FPL element_type -> our player_position enum. Type 5 is 'MNG' (managers),
# which we skip: they aren't draftable players.
POSITION_BY_SHORT_NAME = {"GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}


def fetch_json(url: str) -> Any:
    response = httpx.get(url, timeout=60.0, headers={"User-Agent": "FantasyPrem/0.1"})
    response.raise_for_status()
    return response.json()


def number(value: Any) -> float | None:
    """FPL returns most numbers as strings, and empties as '' or None."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def photo_url(element: dict[str, Any]) -> str | None:
    photo = element.get("photo")
    if not photo:
        return None
    return PHOTO_URL.format(code=photo.rsplit(".", 1)[0])


def build_position_map(element_types: list[dict[str, Any]]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for element_type in element_types:
        position = POSITION_BY_SHORT_NAME.get(element_type["singular_name_short"])
        if position:
            mapping[element_type["id"]] = position
    return mapping


def club_rows(teams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "external_id": str(team["id"]),
            "name": team["name"],
            "short_name": team["short_name"],
            "crest_url": CREST_URL.format(code=team["code"]),
            # Strength ratings drive the fixture adjustment in projections.
            "strength_attack_home": team.get("strength_attack_home"),
            "strength_attack_away": team.get("strength_attack_away"),
            "strength_defence_home": team.get("strength_defence_home"),
            "strength_defence_away": team.get("strength_defence_away"),
        }
        for team in teams
    ]


def gameweek_rows(events: list[dict[str, Any]], season_id: str) -> list[dict[str, Any]]:
    rows = []
    for event in events:
        if event["finished"]:
            status = "complete"
        elif event.get("is_current"):
            status = "active"
        else:
            status = "upcoming"

        rows.append(
            {
                "season_id": season_id,
                "number": event["id"],
                "deadline_at": event["deadline_time"],
                "status": status,
            }
        )
    return rows


def player_rows(
    elements: list[dict[str, Any]],
    positions: dict[int, str],
    club_ids: dict[str, str],
) -> list[dict[str, Any]]:
    rows = []
    skipped = 0

    for element in elements:
        position = positions.get(element["element_type"])
        if position is None:
            skipped += 1
            continue

        rows.append(
            {
                "external_id": str(element["id"]),
                "first_name": element["first_name"],
                "last_name": element["second_name"],
                "display_name": element["web_name"],
                "position": position,
                "club_id": club_ids.get(str(element["team"])),
                "shirt_number": element.get("squad_number"),
                "photo_url": photo_url(element),
                "availability": element.get("status"),
                "news": (element.get("news") or "").strip() or None,
                "news_added_at": element.get("news_added"),
                "chance_of_playing": element.get("chance_of_playing_next_round"),
                # FPL's own projection, on FPL's scoring rules — see migration 0023.
                "ep_next": number(element.get("ep_next")),
                "form": number(element.get("form")),
                "points_per_game": number(element.get("points_per_game")),
                "xg_per_90": number(element.get("expected_goals_per_90")),
                "xa_per_90": number(element.get("expected_assists_per_90")),
                "xgi_per_90": number(element.get("expected_goal_involvements_per_90")),
                "xgc_per_90": number(element.get("expected_goals_conceded_per_90")),
                # FPL's own valuation, and the best preseason draft signal
                # available before any matches are played.
                "price": element.get("now_cost"),
                "selected_by_percent": number(element.get("selected_by_percent")),
                "is_active": element.get("status") != "u",
            }
        )

    if skipped:
        print(f"  skipped {skipped} non-player entries (managers)")

    return rows


def fixture_rows(
    fixtures: list[dict[str, Any]],
    season_id: str,
    gameweek_ids: dict[int, str],
    club_ids: dict[str, str],
) -> list[dict[str, Any]]:
    rows = []
    unscheduled = 0

    for fixture in fixtures:
        event = fixture.get("event")
        gameweek_id = gameweek_ids.get(event) if event else None

        # Fixtures awaiting a date have no gameweek yet; our schema requires one.
        if gameweek_id is None or not fixture.get("kickoff_time"):
            unscheduled += 1
            continue

        if fixture["finished"]:
            status = "finished"
        elif fixture.get("started"):
            status = "live"
        else:
            status = "scheduled"

        rows.append(
            {
                "external_id": str(fixture["id"]),
                "season_id": season_id,
                "gameweek_id": gameweek_id,
                "home_club_id": club_ids.get(str(fixture["team_h"])),
                "away_club_id": club_ids.get(str(fixture["team_a"])),
                "kickoff_at": fixture["kickoff_time"],
                "status": status,
                "home_score": fixture.get("team_h_score"),
                "away_score": fixture.get("team_a_score"),
                "home_difficulty": fixture.get("team_h_difficulty"),
                "away_difficulty": fixture.get("team_a_difficulty"),
            }
        )

    if unscheduled:
        print(f"  skipped {unscheduled} fixtures without a confirmed date")

    return rows


# Upserting on external_id can't collide with a Sportmonks row keyed on
# sportmonks_id, because a unique constraint doesn't apply to NULLs. Running
# this against the current database wouldn't error or overwrite anything — it
# would quietly build a second, parallel copy of every club, player and fixture
# alongside the real one. That's precisely what migration 0033 had to delete,
# and it went unnoticed for weeks because the two halves never referenced each
# other. A deliberate env var is the difference between reverting and relapsing.
GUARD_ENV = "ALLOW_FPL_INGEST"

GUARD_MESSAGE = f"""\
Refusing to run: FPL is no longer the active data provider.

Sportmonks is live (python -m app.ingest.sportmonks). This job writes rows keyed
on FPL ids, which do not collide with Sportmonks rows — so running it against
the current database would silently duplicate every club, player and fixture
rather than failing.

If you really are reverting to FPL, delete the Sportmonks data first, then:

    {GUARD_ENV}=1 python -m app.ingest.fpl
"""


def main() -> int:
    if not os.environ.get(GUARD_ENV):
        print(GUARD_MESSAGE, file=sys.stderr)
        return 1

    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env",
            file=sys.stderr,
        )
        return 1

    print("Fetching FPL data...")
    bootstrap = fetch_json(BOOTSTRAP_URL)
    fixtures = fetch_json(FIXTURES_URL)

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        seasons = db.select("seasons", select="id,label", is_current="is.true")
        if not seasons:
            print("No current season found. Run migration 0005 first.", file=sys.stderr)
            return 1

        season_id = seasons[0]["id"]
        print(f"Season: {seasons[0]['label']}")

        clubs = club_rows(bootstrap["teams"])
        db.upsert("clubs", clubs, on_conflict="external_id")
        print(f"  clubs: {len(clubs)}")

        # Re-read to map the provider's ids onto our uuids.
        club_ids = {
            row["external_id"]: row["id"] for row in db.select("clubs", select="id,external_id")
        }

        gameweeks = gameweek_rows(bootstrap["events"], season_id)
        db.upsert("gameweeks", gameweeks, on_conflict="season_id,number")
        print(f"  gameweeks: {len(gameweeks)}")

        gameweek_ids = {
            row["number"]: row["id"]
            for row in db.select("gameweeks", select="id,number", season_id=f"eq.{season_id}")
        }

        positions = build_position_map(bootstrap["element_types"])
        players = player_rows(bootstrap["elements"], positions, club_ids)
        db.upsert("players", players, on_conflict="external_id")
        print(f"  players: {len(players)}")

        # Players who leave the Premier League vanish from the feed entirely.
        # Without this they'd linger as active forever: still on rosters, still
        # selectable, still showing their old club's fixtures, scoring nothing.
        #
        # Marked inactive rather than deleted — FPL occasionally drops and
        # re-adds a player, and this way that just flips back. Deleting would
        # take their history and roster entries with it.
        seen = {row["external_id"] for row in players}
        departed = [
            row["id"]
            for row in db.select("players", select="id,external_id,is_active", is_active="is.true")
            if row["external_id"] not in seen
        ]

        if departed:
            for start in range(0, len(departed), 200):
                chunk = departed[start : start + 200]
                db.update(
                    "players",
                    {"is_active": False, "availability": "u"},
                    id=f"in.({','.join(chunk)})",
                )
            print(f"  departed: {len(departed)} no longer in the feed, marked inactive")

        matches = fixture_rows(fixtures, season_id, gameweek_ids, club_ids)
        db.upsert("fixtures", matches, on_conflict="external_id")
        print(f"  fixtures: {len(matches)}")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
