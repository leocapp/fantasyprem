"""Ingest per-match player stats from the FPL API, then score every league.

    python -m app.ingest.stats            # all gameweeks with played fixtures
    python -m app.ingest.stats 1 2 3      # only these gameweek numbers

For each gameweek this reads /event/{n}/live/, which returns every player's
totals in a single request — far cheaper than the per-player endpoint.

Note on double gameweeks: the live endpoint's `stats` block is the player's
total across the gameweek, and `explain` lists the fixtures it came from. We
attribute the total to the first of those fixtures. Per-fixture rows are then
slightly wrong in a double gameweek, but per-gameweek totals — which is what
scoring actually uses — are exactly right.
"""

from __future__ import annotations

import sys
from typing import Any

from app.config import get_settings
from app.ingest.fpl import FPL_BASE, fetch_json
from app.ingest.supabase_rest import SupabaseRest

# FPL stat name -> our column name.
STAT_COLUMNS = {
    "minutes": "minutes",
    "goals_scored": "goals",
    "assists": "assists",
    "goals_conceded": "goals_conceded",
    "own_goals": "own_goals",
    "penalties_saved": "penalties_saved",
    "penalties_missed": "penalties_missed",
    "saves": "saves",
    "yellow_cards": "yellow_cards",
    "red_cards": "red_cards",
    "bonus": "bonus",
}


def stat_rows(
    elements: list[dict[str, Any]],
    player_ids: dict[str, str],
    fixture_ids: dict[str, str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for element in elements:
        stats = element.get("stats") or {}
        explain = element.get("explain") or []

        # No fixture means the player's club didn't play this gameweek.
        if not explain:
            continue

        player_id = player_ids.get(str(element["id"]))
        fixture_id = fixture_ids.get(str(explain[0].get("fixture")))

        if not player_id or not fixture_id:
            continue

        row: dict[str, Any] = {"fixture_id": fixture_id, "player_id": player_id}
        for source, column in STAT_COLUMNS.items():
            row[column] = stats.get(source, 0) or 0

        row["clean_sheet"] = bool(stats.get("clean_sheets", 0))
        row["penalties_scored"] = 0  # not exposed separately by this endpoint
        rows.append(row)

    return rows


def main(argv: list[str]) -> int:
    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in backend/.env",
            file=sys.stderr,
        )
        return 1

    wanted = {int(value) for value in argv} if argv else None

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        seasons = db.select("seasons", select="id,label", is_current="is.true")
        if not seasons:
            print("No current season found.", file=sys.stderr)
            return 1

        season_id = seasons[0]["id"]

        player_ids = {
            row["external_id"]: row["id"]
            for row in db.select("players", select="id,external_id")
            if row["external_id"]
        }
        fixtures = db.select(
            "fixtures", select="id,external_id,gameweek_id,status", season_id=f"eq.{season_id}"
        )
        fixture_ids = {row["external_id"]: row["id"] for row in fixtures if row["external_id"]}

        gameweeks = db.select(
            "gameweeks", select="id,number,status", season_id=f"eq.{season_id}", order="number"
        )

        # Only bother with gameweeks that actually have a played fixture.
        played = {
            row["gameweek_id"] for row in fixtures if row["status"] in ("live", "finished")
        }

        targets = [
            gameweek
            for gameweek in gameweeks
            if gameweek["id"] in played and (wanted is None or gameweek["number"] in wanted)
        ]

        if not targets:
            print("No gameweeks with played fixtures yet.")
            print("The season may not have started — try: python -m app.ingest.synthetic")
            return 0

        for gameweek in targets:
            number = gameweek["number"]
            live = fetch_json(f"{FPL_BASE}/event/{number}/live/")
            rows = stat_rows(live.get("elements", []), player_ids, fixture_ids)

            db.upsert("player_match_stats", rows, on_conflict="fixture_id,player_id")
            print(f"  gameweek {number}: {len(rows)} player rows")

            scored = db.rpc("score_all", {"p_gameweek_id": gameweek["id"]})
            print(f"  gameweek {number}: scored {scored} league(s)")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
