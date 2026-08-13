"""Inspect one club's squad entries to find what marks a departed player.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_squad            # Manchester United
    python -m app.ingest.probe_squad 8          # any club's sportmonks id

The ingestion treats everyone in /squads/teams/{id} as active, which gives
about 36 players per club — far more than a first-team squad. Someone who left
months ago is still draftable, so the endpoint is evidently returning the
season's registrations rather than the current squad.

Prints the full key set of a squad entry and a sample of rows, so the field
that separates current from departed can be identified rather than guessed at.

Reads only.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

BASE = "https://api.sportmonks.com/v3/football"

MANCHESTER_UNITED = "14"


def main(argv: list[str]) -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    team_id = argv[0] if argv else MANCHESTER_UNITED

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        response = client.get(
            f"{BASE}/squads/teams/{team_id}", params={"include": "player.position"}
        )
        if response.status_code != 200:
            print(f"HTTP {response.status_code}: {response.text[:300]}", file=sys.stderr)
            return 1

        squad = response.json().get("data") or []

    print(f"team {team_id}: {len(squad)} squad entries\n")

    if not squad:
        return 0

    # Every key that appears on any entry, so an occasional field isn't missed.
    keys: set[str] = set()
    for entry in squad:
        keys.update(entry.keys())
    print("entry keys:", ", ".join(sorted(keys)), "\n")

    def describe(entry: dict[str, Any]) -> str:
        player = entry.get("player") or {}
        name = player.get("display_name") or player.get("name") or "?"
        # Anything that looks like it could carry a date or a flag.
        marks = {
            key: entry.get(key)
            for key in sorted(keys)
            if key not in {"player", "id", "player_id", "team_id"}
        }
        return f"  {name:<28} {json.dumps(marks, default=str)}"

    print("first 5 entries:")
    for entry in squad[:5]:
        print(describe(entry))

    # The specific case that prompted this.
    # How useful is `end` as a discriminator on its own?
    from datetime import date
    today = date.today().isoformat()
    ended = [e for e in squad if e.get("end") and str(e["end"]) < today]
    open_ended = [e for e in squad if not e.get("end")]
    future = [e for e in squad if e.get("end") and str(e["end"]) >= today]
    print(
        f"\nby contract end: {len(future)} future, {len(ended)} already ended, "
        f"{len(open_ended)} with no end date"
    )
    for entry in open_ended:
        player = entry.get("player") or {}
        print(f"    no end date: {player.get('display_name') or player.get('name')}")

    # The season-scoped squad: who is registered for THIS season, rather than
    # everyone who has ever been on the books.
    season_id = os.environ.get("SPORTMONKS_SEASON", "28083")
    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        seasonal = client.get(
            f"{BASE}/squads/seasons/{season_id}/teams/{team_id}",
            params={"include": "player"},
        )

    print(f"\n/squads/seasons/{season_id}/teams/{team_id} -> HTTP {seasonal.status_code}")
    if seasonal.status_code == 200:
        rows = seasonal.json().get("data") or []
        names = {
            ((r.get("player") or {}).get("display_name")
             or (r.get("player") or {}).get("name") or "?")
            for r in rows
        }
        print(f"  {len(rows)} entries")
        print("  contains Casemiro:", any("casemiro" in n.lower() for n in names))
        missing = sorted(
            n for n in (
                ((e.get("player") or {}).get("display_name")
                 or (e.get("player") or {}).get("name") or "?")
                for e in squad
            ) if n not in names
        )
        print(f"  in team squad but NOT this season ({len(missing)}):")
        for name in missing:
            print(f"    {name}")
    else:
        print(f"  {seasonal.text[:200]}")

    print("\nanyone matching 'casemiro':")
    hits = [
        entry
        for entry in squad
        if "casemiro"
        in ((entry.get("player") or {}).get("display_name") or "").lower()
    ]
    for entry in hits:
        print(describe(entry))
    if not hits:
        print("  (not in this squad — so the endpoint is fine and something else keeps him active)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
