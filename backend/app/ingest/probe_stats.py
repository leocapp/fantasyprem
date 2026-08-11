"""List every per-player statistic Sportmonks reports for a finished match.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_stats

Per-player stats arrive as lineups[].details[], each carrying a numeric type_id
and a nested type with a human name. This prints the distinct set across a whole
fixture, with an example value, which is what the ingestion needs to map onto
player_match_stats columns.

The main probe trims every list to two items to keep the file readable, which
hid exactly the detail this needs.
"""

from __future__ import annotations

import os
import sys
from collections import defaultdict
from typing import Any

import httpx

FOOTBALL = "https://api.sportmonks.com/v3/football"
PREMIER_LEAGUE = 8


def get(client: httpx.Client, url: str, **params: str) -> Any:
    response = client.get(url, params=params)
    if response.is_error:
        print(f"  {response.status_code}: {response.text[:200]}", file=sys.stderr)
        return None
    return response.json()


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        league = get(client, f"{FOOTBALL}/leagues/{PREMIER_LEAGUE}", include="seasons")
        seasons = ((league or {}).get("data") or {}).get("seasons") or []
        finished = [s for s in seasons if s.get("finished")]

        if not finished:
            print("No finished season visible — is the historical add-on active?")
            return 1

        season = finished[-1]
        print(f"Season {season['id']} ({season.get('name')})")

        fixtures = get(
            client,
            f"{FOOTBALL}/fixtures",
            filters=f"fixtureSeasons:{season['id']}",
            include="state",
        )

        played = [
            fixture
            for fixture in ((fixtures or {}).get("data") or [])
            if (fixture.get("state") or {}).get("short_name") in ("FT", "AET", "FT_PEN")
        ]

        if not played:
            played = (fixtures or {}).get("data") or []

        if not played:
            print("No fixtures returned.")
            return 1

        fixture_id = played[0]["id"]
        print(f"Fixture {fixture_id}: {played[0].get('name')}\n")

        detail = get(
            client,
            f"{FOOTBALL}/fixtures/{fixture_id}",
            include="lineups.details.type;events.type",
        )

        lineups = ((detail or {}).get("data") or {}).get("lineups") or []
        print(f"{len(lineups)} lineup entries\n")

        # Distinct statistic types across every player in the match.
        stats: dict[int, dict[str, Any]] = {}
        counts: dict[int, int] = defaultdict(int)

        for entry in lineups:
            for item in entry.get("details") or []:
                type_id = item.get("type_id")
                info = item.get("type") or {}
                counts[type_id] += 1
                if type_id not in stats:
                    stats[type_id] = {
                        "name": info.get("name"),
                        "code": info.get("code"),
                        "example": (item.get("data") or {}).get("value"),
                    }

        print("PER-PLAYER STATISTICS")
        print(f"{'id':>5}  {'name':<32} {'code':<28} example  seen")
        for type_id in sorted(stats, key=lambda k: -counts[k]):
            row = stats[type_id]
            print(
                f"{type_id:>5}  {str(row['name']):<32} {str(row['code']):<28} "
                f"{str(row['example']):>7}  {counts[type_id]}"
            )

        # Lineup type_id distinguishes starters from substitutes.
        kinds: dict[Any, int] = defaultdict(int)
        for entry in lineups:
            kinds[entry.get("type_id")] += 1
        print(f"\nLINEUP type_id values (starter vs bench): {dict(kinds)}")

        # Event types tell us goals, cards, substitutions.
        events = ((detail or {}).get("data") or {}).get("events") or []
        event_types: dict[int, str] = {}
        for event in events:
            event_types[event.get("type_id")] = (event.get("type") or {}).get("name") or "?"
        print(f"\nEVENT types in this match: {event_types}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
