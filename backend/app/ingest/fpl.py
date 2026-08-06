"""Ingest Premier League reference data from the Fantasy Premier League API.

    python -m app.ingest.fpl

Pulls clubs, gameweeks, players and fixtures into Supabase. Safe to re-run:
every write is an upsert keyed on the provider's own id, so running it again
refreshes prices, injuries, scores and fixture status without duplicating rows.

These endpoints are public but undocumented and unofficial. They can change
shape without notice, so failures here are expected occasionally.
"""

from __future__ import annotations

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
            }
        )

    if unscheduled:
        print(f"  skipped {unscheduled} fixtures without a confirmed date")

    return rows


def main() -> int:
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

        matches = fixture_rows(fixtures, season_id, gameweek_ids, club_ids)
        db.upsert("fixtures", matches, on_conflict="external_id")
        print(f"  fixtures: {len(matches)}")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
