"""Find how Sportmonks exposes injuries and suspensions.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_injuries

Their type dictionary has an injury_suspension category — ruptured ligaments,
red card suspensions and so on — so the data exists. What isn't obvious is
which endpoint serves it and how it's shaped.

Tries the plausible routes and reports which answer. Reads only.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

FOOTBALL = "https://api.sportmonks.com/v3/football"
PREMIER_LEAGUE_ID = 8


def attempt(client: httpx.Client, label: str, path: str, **params: str) -> Any:
    response = client.get(f"{FOOTBALL}{path}", params=params)

    if response.is_error:
        print(f"  {label:<38} {response.status_code}")
        return None

    payload = response.json()
    data = payload.get("data")
    count = len(data) if isinstance(data, list) else ("object" if data else "empty")
    print(f"  {label:<38} ok ({count})")
    return payload


def sample(payload: Any, depth: int = 2) -> Any:
    if isinstance(payload, dict):
        return {key: sample(value, depth) for key, value in payload.items()}
    if isinstance(payload, list):
        return [sample(item, depth) for item in payload[:depth]]
    return payload


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    found: dict[str, Any] = {}

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        league = client.get(
            f"{FOOTBALL}/leagues/{PREMIER_LEAGUE_ID}",
            params={"include": "currentSeason"},
        ).json()
        data = league.get("data") or {}
        season = data.get("currentseason") or data.get("currentSeason") or {}
        season_id = season.get("id")

        teams = client.get(f"{FOOTBALL}/teams/seasons/{season_id}").json()
        team = (teams.get("data") or [{}])[0]
        team_id = team.get("id")
        print(f"Season {season_id}, sampling team {team_id} ({team.get('name')})\n")

        print("Trying endpoints:")
        candidates = [
            ("sidelined (all)", "/sidelined", {"include": "player;type"}),
            ("sidelined by season", f"/sidelined/seasons/{season_id}", {"include": "player;type"}),
            ("sidelined by team", f"/sidelined/teams/{team_id}", {"include": "player;type"}),
            ("squad + player.sidelined", f"/squads/teams/{team_id}", {"include": "player.sidelined"}),
            ("team + sidelined", f"/teams/{team_id}", {"include": "sidelined"}),
            ("news", "/news/prematch", {}),
        ]

        for label, path, params in candidates:
            result = attempt(client, label, path, **params)
            if result is not None:
                found[label] = result

    if not found:
        print("\nNothing answered — injuries may not be included in this plan.")
        return 1

    output = "\n\n".join(
        f"=== {label} ===\n{json.dumps(sample(payload), indent=2)[:3000]}"
        for label, payload in found.items()
    )
    print(f"\n{output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
