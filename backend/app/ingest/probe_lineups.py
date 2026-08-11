"""Check whether a fixture's lineups come back complete.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_lineups

The backfill wrote ~17.5 player rows per fixture where a real match produces
closer to 30 once both benches are counted, and Morgan Rogers — 37 appearances
last season — has 3. Two explanations, needing different fixes:

  1. The API truncates the nested lineups include, so we never saw the rest.
  2. We saw them and dropped them, because stat_rows() skips any player_id not
     already in our players table.

Probes several of one club's fixtures and reports, for each, how many entries
came back, how many we would keep, and whether the player was in the response.
If entries are ~30 and we keep ~17, it's us. If entries are ~17, it's them.

Reads only.
"""

from __future__ import annotations

import os
import sys
from collections import Counter
from typing import Any

import httpx

from app.config import get_settings
from app.ingest.sportmonks import STARTER_TYPE
from app.ingest.supabase_rest import SupabaseRest

BASE = "https://api.sportmonks.com/v3/football"

PLAYER_SPORTMONKS_ID = "4592198"   # Morgan Rogers
CLUB_NAME = "Aston Villa"          # the club he played for last season
SAMPLE = 6


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    settings = get_settings()

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        known = {
            row["sportmonks_id"]
            for row in db.select("players", select="sportmonks_id")
            if row["sportmonks_id"]
        }

        seasons = db.select("seasons", select="id,label,is_current")
        past = next((s for s in seasons if not s["is_current"]), None)
        if not past:
            print("No past season to probe.", file=sys.stderr)
            return 1

        clubs = db.select("clubs", select="id,name", name=f"eq.{CLUB_NAME}")
        if not clubs:
            print(f"No club named {CLUB_NAME}.", file=sys.stderr)
            return 1
        club_id = clubs[0]["id"]

        fixtures = [
            row
            for row in db.select(
                "fixtures",
                select="id,sportmonks_id,kickoff_at,home_club_id,away_club_id",
                season_id=f"eq.{past['id']}",
                order="kickoff_at",
            )
            if club_id in (row["home_club_id"], row["away_club_id"])
            and row["sportmonks_id"]
        ]

        # Which of those we actually recorded him in, so the sample can contrast.
        player = db.select("players", select="id", sportmonks_id=f"eq.{PLAYER_SPORTMONKS_ID}")
        recorded: set[str] = set()
        if player:
            recorded = {
                row["fixture_id"]
                for row in db.select(
                    "player_match_stats", select="fixture_id",
                    player_id=f"eq.{player[0]['id']}",
                )
            }

    print(f"players we hold: {len(known)}")
    print(f"{CLUB_NAME} fixtures in {past['label']}: {len(fixtures)}")
    print(f"of which we recorded the player in: {sum(1 for f in fixtures if f['id'] in recorded)}")

    # Sample across the season rather than the first few, since whatever is
    # dropping rows may vary with date.
    step = max(1, len(fixtures) // SAMPLE)
    sample = fixtures[::step][:SAMPLE]

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        for fixture in sample:
            response = client.get(
                f"{BASE}/fixtures/{fixture['sportmonks_id']}",
                params={"include": "lineups.details;participants"},
            )
            if response.status_code != 200:
                print(f"  {fixture['kickoff_at'][:10]}: HTTP {response.status_code}")
                continue

            data = response.json().get("data") or {}
            lineups = data.get("lineups") or []
            teams = " v ".join(p.get("name", "?") for p in (data.get("participants") or []))

            ids = {str(entry.get("player_id")) for entry in lineups}
            keep = sum(1 for entry in lineups if str(entry.get("player_id")) in known)
            starters = sum(1 for e in lineups if e.get("type_id") == STARTER_TYPE)
            per_team = Counter(str(e.get("team_id")) for e in lineups)

            print(
                f"\n  {fixture['kickoff_at'][:10]}  {teams}"
                f"\n    entries {len(lineups):>3}   per team {dict(per_team)}"
                f"\n    starters {starters:>2} (expect 22)   we keep {keep:>3}"
                f"   drop {len(lineups) - keep:>3}"
                f"\n    player in response: {PLAYER_SPORTMONKS_ID in ids}"
                f"   we recorded him: {fixture['id'] in recorded}"
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
