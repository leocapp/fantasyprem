"""Dump real Sportmonks responses so we can build against what it returns.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_sportmonks

Writes trimmed samples to backend/sportmonks_probe.json and prints a summary.
Nothing is written to the database — this only reads.

Ids are discovered rather than assumed: it finds the Premier League in whatever
your plan covers, takes its current season, a team from that season, a player
from that team's squad, and a finished fixture. Hardcoding ids was how the
first version produced three 404s that looked like missing data.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import httpx

FOOTBALL = "https://api.sportmonks.com/v3/football"
# The dictionary of statistic types lives on the core API, not football.
CORE = "https://api.sportmonks.com/v3/core"

OUTPUT = Path(__file__).resolve().parents[2] / "sportmonks_probe.json"


def get(client: httpx.Client, url: str, **params: str) -> Any:
    response = client.get(url, params=params)
    if response.is_error:
        return {"error": response.status_code, "body": response.text[:400]}
    return response.json()


def first(payload: Any) -> dict[str, Any] | None:
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list) and data:
        return data[0]
    if isinstance(data, dict):
        return data
    return None


def trim(payload: Any, keep: int = 2) -> Any:
    """Keep the shape, drop the volume."""
    if isinstance(payload, dict):
        return {key: trim(value, keep) for key, value in payload.items()}
    if isinstance(payload, list):
        return [trim(item, keep) for item in payload[:keep]]
    return payload


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    samples: dict[str, Any] = {}

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        print("Leagues you can access…")
        leagues = get(client, f"{FOOTBALL}/leagues", include="currentSeason")
        samples["leagues"] = leagues

        # Find the Premier League among whatever the plan covers.
        premier = None
        for league in (leagues.get("data") or []) if isinstance(leagues, dict) else []:
            if "premier league" in str(league.get("name", "")).lower():
                premier = league
                break

        if not premier:
            print("  couldn't find the Premier League — check the leagues output")
            premier = first(leagues) or {}

        league_id = premier.get("id")
        season = premier.get("currentseason") or premier.get("currentSeason") or {}
        season_id = season.get("id")
        print(f"  league {league_id}, current season {season_id}")

        print("Season detail…")
        samples["season"] = get(client, f"{FOOTBALL}/seasons/{season_id}")

        print("Teams in that season…")
        teams = get(client, f"{FOOTBALL}/teams/seasons/{season_id}")
        samples["teams"] = teams
        team = first(teams) or {}
        team_id = team.get("id")

        print(f"Squad for team {team_id}…")
        squad = get(client, f"{FOOTBALL}/squads/teams/{team_id}", include="player.position")
        samples["squads"] = squad

        squad_entry = first(squad) or {}
        player_id = squad_entry.get("player_id") or (squad_entry.get("player") or {}).get("id")

        print(f"Player {player_id} with season statistics…")
        samples["player_detail"] = get(
            client,
            f"{FOOTBALL}/players/{player_id}",
            include="statistics.details;position;nationality",
        )

        # Statistics only exist for played matches, and the current season
        # hasn't started — so this also tests whether the historical add-on is
        # working, which is the part of the plan worth verifying.
        print("Seasons for this league (tests historical access)…")
        seasons = get(client, f"{FOOTBALL}/leagues/{league_id}", include="seasons")
        samples["all_seasons"] = seasons

        league_data = seasons.get("data") if isinstance(seasons, dict) else None
        all_seasons = (league_data or {}).get("seasons") or []
        past = [s for s in all_seasons if s.get("finished") and s.get("id") != season_id]
        past_season_id = past[-1]["id"] if past else None
        print(f"  {len(all_seasons)} seasons visible, most recent finished: {past_season_id}")

        # v3 offers several ways to list fixtures and the docs disagree with
        # each other. Try them in order and keep whichever answers.
        target_season = past_season_id or season_id
        attempts = {
            "schedules": f"{FOOTBALL}/schedules/seasons/{target_season}",
            "fixtures_filter": f"{FOOTBALL}/fixtures",
        }

        fixtures: Any = {"error": "none attempted"}
        for label, url in attempts.items():
            params = (
                {"filters": f"fixtureSeasons:{target_season}", "include": "participants;state"}
                if label == "fixtures_filter"
                else {"include": "fixtures"}
            )
            result = get(client, url, **params)
            samples[f"fixtures_via_{label}"] = result
            if isinstance(result, dict) and "error" not in result:
                print(f"  fixtures found via {label}")
                fixtures = result
                break

        samples["fixtures"] = fixtures

        # A finished fixture is the only one with statistics worth seeing. The
        # shape differs between endpoints, so look in both places.
        def walk_fixtures(payload: Any) -> list[dict[str, Any]]:
            data = payload.get("data") if isinstance(payload, dict) else None
            if isinstance(data, list):
                found: list[dict[str, Any]] = []
                for item in data:
                    if "participants" in item or "starting_at" in item:
                        found.append(item)
                    found.extend(item.get("fixtures") or [])
                    for rnd in item.get("rounds") or []:
                        found.extend(rnd.get("fixtures") or [])
                return found
            return []

        candidates = walk_fixtures(fixtures)
        print(f"  {len(candidates)} fixtures found")

        finished = None
        for fixture in candidates:
            state = (fixture.get("state") or {}).get("short_name")
            if state in ("FT", "AET", "FT_PEN") or fixture.get("has_odds") is not None:
                finished = fixture
                break
        if finished is None and candidates:
            finished = candidates[0]

        if finished:
            print(f"Fixture {finished['id']} with lineups, events and statistics…")
            samples["fixture_detail"] = get(
                client,
                f"{FOOTBALL}/fixtures/{finished['id']}",
                include="lineups.details.type;events;statistics.type;participants",
            )
        else:
            print("  no finished fixture found yet — season may not have started")
            samples["fixture_detail"] = {"note": "no finished fixture available"}

        print("Statistic types dictionary (core API)…")
        samples["types"] = get(client, f"{CORE}/types")

        print("Expected lineups (plan-dependent)…")
        samples["expected_lineups"] = get(client, f"{FOOTBALL}/expected/lineups")

    OUTPUT.write_text(json.dumps(trim(samples), indent=2)[:400_000])

    print(f"\nWrote {OUTPUT}\n\nSummary:")
    for name, payload in samples.items():
        if isinstance(payload, dict) and "error" in payload:
            print(f"  {name}: ERROR {payload['error']}")
        elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
            print(f"  {name}: {len(payload['data'])} items")
        else:
            print(f"  {name}: ok")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
