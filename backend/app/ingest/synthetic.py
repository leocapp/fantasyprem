"""Fabricate plausible match stats so scoring can be tested off-season.

    python -m app.ingest.synthetic          # first gameweek with fixtures
    python -m app.ingest.synthetic 1        # a specific gameweek number

DEVELOPMENT ONLY. This writes invented numbers into player_match_stats and
marks the gameweek's fixtures as finished, exactly as if the matches had been
played. Never point it at a database with real results in it.

Every rostered player in every league is guaranteed a stat row, so the
scoring engine and matchup settlement have something to chew on.
"""

from __future__ import annotations

import random
import sys
from datetime import datetime, timezone
from typing import Any

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

CONFIRM = "yes, fake it"


def fabricate(position: str, rng: random.Random) -> dict[str, Any]:
    """Rough, position-aware numbers. Not a simulation — just plausible."""
    minutes = rng.choices([0, rng.randint(1, 59), 90], weights=[15, 20, 65])[0]

    row: dict[str, Any] = {
        "minutes": minutes,
        "goals": 0,
        "assists": 0,
        "clean_sheet": False,
        "goals_conceded": 0,
        "own_goals": 0,
        "penalties_scored": 0,
        "penalties_missed": 0,
        "penalties_saved": 0,
        "saves": 0,
        "yellow_cards": 0,
        "red_cards": 0,
        "bonus": 0,
    }

    if minutes == 0:
        return row

    conceded = rng.choices([0, 1, 2, 3], weights=[35, 35, 20, 10])[0]
    row["goals_conceded"] = conceded
    row["clean_sheet"] = conceded == 0 and minutes >= 60

    if position == "GK":
        row["saves"] = rng.randint(0, 7)
        row["penalties_saved"] = 1 if rng.random() < 0.03 else 0
    else:
        goal_chance = {"DEF": 0.08, "MID": 0.15, "FWD": 0.3}[position]
        assist_chance = {"DEF": 0.07, "MID": 0.18, "FWD": 0.15}[position]
        row["goals"] = sum(1 for _ in range(2) if rng.random() < goal_chance)
        row["assists"] = 1 if rng.random() < assist_chance else 0
        row["penalties_missed"] = 1 if rng.random() < 0.02 else 0

    row["yellow_cards"] = 1 if rng.random() < 0.12 else 0
    row["red_cards"] = 1 if rng.random() < 0.01 else 0

    if row["goals"] or row["assists"] or row["clean_sheet"]:
        row["bonus"] = rng.choices([0, 1, 2, 3], weights=[60, 20, 12, 8])[0]

    return row


def main(argv: list[str]) -> int:
    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.", file=sys.stderr)
        return 1

    if settings.environment != "development":
        print("Refusing to run outside development.", file=sys.stderr)
        return 1

    print("This writes invented match data into your database.")
    if input(f'Type "{CONFIRM}" to continue: ').strip() != CONFIRM:
        print("Aborted.")
        return 1

    wanted = int(argv[0]) if argv else None
    rng = random.Random(42)

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        seasons = db.select("seasons", select="id", is_current="is.true")
        if not seasons:
            print("No current season found.", file=sys.stderr)
            return 1

        season_id = seasons[0]["id"]

        gameweeks = db.select(
            "gameweeks", select="id,number", season_id=f"eq.{season_id}", order="number"
        )
        if wanted is not None:
            gameweeks = [row for row in gameweeks if row["number"] == wanted]

        fixtures_by_gameweek: dict[str, list[dict[str, Any]]] = {}
        for fixture in db.select(
            "fixtures", select="id,gameweek_id,home_club_id,away_club_id", season_id=f"eq.{season_id}"
        ):
            fixtures_by_gameweek.setdefault(fixture["gameweek_id"], []).append(fixture)

        target = next((row for row in gameweeks if fixtures_by_gameweek.get(row["id"])), None)
        if target is None:
            print("No gameweek has fixtures. Run: python -m app.ingest.fpl", file=sys.stderr)
            return 1

        fixtures = fixtures_by_gameweek[target["id"]]
        fixture_by_club: dict[str, str] = {}
        for fixture in fixtures:
            fixture_by_club[fixture["home_club_id"]] = fixture["id"]
            fixture_by_club[fixture["away_club_id"]] = fixture["id"]

        # Only players who are actually on a roster somewhere need stats.
        rostered = {
            row["player_id"]
            for row in db.select("roster_entries", select="player_id", dropped_at="is.null")
        }

        if not rostered:
            print("No rostered players — run a draft first.", file=sys.stderr)
            return 1

        players = db.select("players", select="id,position,club_id")
        rows = []
        for player in players:
            if player["id"] not in rostered:
                continue
            fixture_id = fixture_by_club.get(player["club_id"])
            if not fixture_id:
                continue
            row = fabricate(player["position"], rng)
            row["fixture_id"] = fixture_id
            row["player_id"] = player["id"]
            row["club_id"] = player["club_id"]
            rows.append(row)

        db.upsert("player_match_stats", rows, on_conflict="fixture_id,player_id")
        print(f"gameweek {target['number']}: wrote {len(rows)} fabricated rows")

        # Mark it played so scoring treats the results as final. The deadline is
        # pushed into the past too: a complete gameweek that is still accepting
        # lineup edits is a contradiction, and leaves saved lineups deletable by
        # a later transfer even though the results are already settled.
        db.update("fixtures", {"status": "finished"}, gameweek_id=f"eq.{target['id']}")
        db.update(
            "gameweeks",
            {
                "status": "complete",
                "deadline_at": datetime.now(timezone.utc).isoformat(),
            },
            id=f"eq.{target['id']}",
        )

        scored = db.rpc("score_all", {"p_gameweek_id": target["id"]})
        print(f"scored {scored} league(s)")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
