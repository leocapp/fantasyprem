"""Find a source that knows a player has left the league.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_departures

The squad endpoints are no help: /squads/teams/{id} and
/squads/seasons/{season}/teams/{id} both return 34 players for Manchester
United and both still include Casemiro months after he left for MLS. The
contract `end` field doesn't separate them either — it's null for him and also
null for both of their goalkeepers, so it means "no end recorded", not "gone".

This checks the remaining candidates on the player record itself, comparing
someone who has left against someone who plainly hasn't:

  * player.teams    — membership history, which should show a current club
  * player.transfers — an actual transfer out
  * whatever the bare player object carries

Reads only.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

BASE = "https://api.sportmonks.com/v3/football"

# Someone who has left, and a control who certainly hasn't.
SUBJECTS = {"departed": "Casemiro", "control": "Bruno Fernandes"}
MANCHESTER_UNITED = "14"


def find_ids(client: httpx.Client) -> dict[str, int]:
    response = client.get(
        f"{BASE}/squads/teams/{MANCHESTER_UNITED}", params={"include": "player"}
    )
    response.raise_for_status()

    found: dict[str, int] = {}
    for entry in response.json().get("data") or []:
        player = entry.get("player") or {}
        name = (player.get("display_name") or player.get("name") or "").lower()
        for role, target in SUBJECTS.items():
            if target.lower() in name:
                found[role] = player["id"]
    return found


def show(client: httpx.Client, role: str, player_id: int) -> None:
    print(f"\n{'=' * 60}\n{role}: player {player_id}")

    for include in ["", "teams", "transfers"]:
        params = {"include": include} if include else {}
        response = client.get(f"{BASE}/players/{player_id}", params=params)

        label = include or "(no include)"
        if response.status_code != 200:
            print(f"  {label}: HTTP {response.status_code} {response.text[:120]}")
            continue

        data = response.json().get("data") or {}

        if not include:
            # Does the bare record name a current club?
            interesting = {
                key: value
                for key, value in data.items()
                if not isinstance(value, (dict, list))
            }
            print(f"  {label}: {json.dumps(interesting, default=str)[:600]}")
            continue

        rows: list[dict[str, Any]] = data.get(include) or []
        print(f"  {label}: {len(rows)} row(s)")
        for row in rows[-6:]:
            trimmed = {
                key: value
                for key, value in row.items()
                if key
                in {
                    "team_id",
                    "start",
                    "end",
                    "date",
                    "from_team_id",
                    "to_team_id",
                    "completed",
                    "type_id",
                    "season_id",
                }
            }
            print(f"    {json.dumps(trimmed, default=str)}")


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        ids = find_ids(client)
        if not ids:
            print("Couldn't find either player in the squad.", file=sys.stderr)
            return 1

        for role, player_id in ids.items():
            show(client, role, player_id)

    print(
        "\nWhat to look for: a field on the departed player that differs from the "
        "control — a current team_id that isn't Manchester United, a teams row "
        "with an end date in the past, or a transfer out."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
