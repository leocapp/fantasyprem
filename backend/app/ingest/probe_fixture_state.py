"""What state does the provider report for a fixture we think is unplayed?

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_fixture_state            # unplayed, current season
    python -m app.ingest.probe_fixture_state 19135051   # one fixture by id

The ingestion only fetches statistics for fixtures whose state short_name is
FT, AET or FT_PEN. A match that has finished in reality but reports something
else — or hasn't been updated yet — is skipped silently and looks like missing
points.

Prints the raw state for every current-season fixture we still hold as
scheduled, so "the provider hasn't updated" and "the provider says something we
don't recognise" can be told apart.

Reads only.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

BASE = "https://api.sportmonks.com/v3/football"

# What the ingestion treats as "played". Kept in sync by hand — if this probe
# shows a different value for a finished match, that's the bug.
ACCEPTED = ("FT", "AET", "FT_PEN")


def main(argv: list[str]) -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    settings = get_settings()

    if argv:
        ids = [(argv[0], "(given)")]
    else:
        with SupabaseRest(
            settings.supabase_url or "", settings.supabase_service_role_key or ""
        ) as db:
            seasons = db.select("seasons", select="id", is_current="is.true")
            if not seasons:
                print("No current season.", file=sys.stderr)
                return 1

            rows = db.select(
                "fixtures",
                select="sportmonks_id,kickoff_at,status",
                season_id=f"eq.{seasons[0]['id']}",
                status="eq.scheduled",
                order="kickoff_at",
            )

        # Only ones whose kickoff has passed: everything later is correctly
        # scheduled and would be noise.
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        ids = []
        for row in rows:
            kickoff = str(row.get("kickoff_at") or "")
            try:
                started = datetime.fromisoformat(kickoff.replace(" ", "T").replace("Z", "+00:00"))
            except ValueError:
                continue
            if started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
            if started < now and row.get("sportmonks_id"):
                ids.append((row["sportmonks_id"], kickoff))

    if not ids:
        print("No past-kickoff fixtures are still marked scheduled. Nothing to explain.")
        return 0

    print(f"{len(ids)} fixture(s) past kickoff and still scheduled:\n")

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        for fixture_id, kickoff in ids:
            response = client.get(
                f"{BASE}/fixtures/{fixture_id}",
                params={"include": "state;participants;scores"},
            )

            if response.status_code != 200:
                print(f"  {fixture_id}: HTTP {response.status_code}")
                continue

            data = response.json().get("data") or {}
            state = data.get("state") or {}
            teams = " v ".join(p.get("name", "?") for p in (data.get("participants") or []))
            short = state.get("short_name")

            print(f"  {fixture_id}  {teams}")
            print(f"    our kickoff : {kickoff}")
            print(f"    state       : {json.dumps(state, default=str)[:200]}")
            print(
                f"    verdict     : "
                + (
                    "we would fetch stats"
                    if short in ACCEPTED
                    else f"skipped — short_name {short!r} is not in {ACCEPTED}"
                )
            )
            print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
