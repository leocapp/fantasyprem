"""Ingest a completed season's fixtures and match statistics.

    python -m app.ingest.backfill            # most recent finished season
    python -m app.ingest.backfill 25583      # a specific Sportmonks season id

This is what the historical data add-on is for. Last season's real performances,
scored under a league's own rules, make a far better draft board than any proxy
— and unlike a projection, it's a fact rather than a guess.

Run once per season. It's slow by design: one request per fixture, paced under
the rate limit, so a full season takes several minutes.
"""

from __future__ import annotations

import sys
from typing import Any

from app.config import get_settings
from app.ingest.sportmonks import (
    PREMIER_LEAGUE_ID,
    Sportmonks,
    club_rows,
    stat_rows,
)
from app.ingest.supabase_rest import SupabaseRest


def pick_season(api: Sportmonks, requested: str | None) -> dict[str, Any]:
    league = api.get(f"/leagues/{PREMIER_LEAGUE_ID}", include="seasons")
    seasons = ((league.get("data") or {}).get("seasons")) or []

    if requested:
        for season in seasons:
            if str(season["id"]) == requested:
                return season
        raise RuntimeError(f"Season {requested} not visible on this plan")

    finished = [season for season in seasons if season.get("finished")]
    if not finished:
        raise RuntimeError("No finished seasons — is the historical add-on active?")

    return finished[-1]


def main(argv: list[str]) -> int:
    settings = get_settings()

    if not settings.sportmonks_token:
        print("SPORTMONKS_TOKEN not set", file=sys.stderr)
        return 1

    with (
        Sportmonks(settings.sportmonks_token) as api,
        SupabaseRest(settings.supabase_url or "", settings.supabase_service_role_key or "") as db,
    ):
        season = pick_season(api, argv[0] if argv else None)
        label = season.get("name") or str(season["id"])
        print(f"Backfilling {label} (Sportmonks season {season['id']})")

        # A season row of our own, explicitly not current.
        db.upsert(
            "seasons",
            [
                {
                    "label": label,
                    "starts_on": season.get("starting_at") or f"{label[:4]}-08-01",
                    "ends_on": season.get("ending_at") or f"{label[:4]}-05-31",
                    "is_current": False,
                }
            ],
            on_conflict="label",
        )

        rows = db.select("seasons", select="id,label", label=f"eq.{label}")
        if not rows:
            print("Could not create the season row", file=sys.stderr)
            return 1
        season_row_id = rows[0]["id"]

        # Last season's twenty aren't this season's twenty. Promoted and
        # relegated clubs still need rows, or their fixtures have nothing to
        # point at — which is what a not-null violation on away_club_id means.
        historical_teams = api.paged(f"/teams/seasons/{season['id']}")
        db.upsert("clubs", club_rows(historical_teams), on_conflict="sportmonks_id")
        print(f"  clubs in that season: {len(historical_teams)}")

        club_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select("clubs", select="id,sportmonks_id")
            if row["sportmonks_id"]
        }
        player_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select("players", select="id,sportmonks_id")
            if row["sportmonks_id"]
        }

        # Scores come with the list, so team strength can be derived without a
        # request per fixture.
        fixtures = api.paged(
            "/fixtures",
            filters=f"fixtureSeasons:{season['id']}",
            include="participants;round;state;scores",
        )
        print(f"  fixtures: {len(fixtures)}")

        # Gameweeks for the historical season, same round-to-gameweek mapping.
        rounds: dict[int, str] = {}
        for fixture in fixtures:
            name = (fixture.get("round") or {}).get("name")
            kickoff = fixture.get("starting_at")
            if not (name and kickoff):
                continue
            try:
                number = int(name)
            except (TypeError, ValueError):
                continue
            rounds[number] = min(rounds.get(number, kickoff), kickoff)

        db.upsert(
            "gameweeks",
            [
                {
                    "season_id": season_row_id,
                    "number": number,
                    "deadline_at": deadline,
                    "status": "complete",
                }
                for number, deadline in sorted(rounds.items())
            ],
            on_conflict="season_id,number",
        )

        gameweek_ids = {
            row["number"]: row["id"]
            for row in db.select(
                "gameweeks", select="id,number", season_id=f"eq.{season_row_id}"
            )
        }

        fixture_rows = []
        for fixture in fixtures:
            name = (fixture.get("round") or {}).get("name")
            participants = fixture.get("participants") or []
            home = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "home"), None
            )
            away = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "away"), None
            )

            if not (name and home and away):
                continue

            gameweek_id = gameweek_ids.get(int(name))
            home_club = club_ids.get(str(home["id"]))
            away_club = club_ids.get(str(away["id"]))

            # Skip rather than fail: better to lose one fixture than the run.
            if not (gameweek_id and home_club and away_club):
                continue

            # CURRENT is the final score; the payload also carries half-time and
            # other breakdowns under different descriptions.
            goals = {
                score.get("participant_id"): (score.get("score") or {}).get("goals")
                for score in fixture.get("scores") or []
                if score.get("description") == "CURRENT"
            }

            fixture_rows.append(
                {
                    "sportmonks_id": str(fixture["id"]),
                    "season_id": season_row_id,
                    "gameweek_id": gameweek_id,
                    "home_club_id": home_club,
                    "away_club_id": away_club,
                    "home_score": goals.get(home["id"]),
                    "away_score": goals.get(away["id"]),
                    "kickoff_at": fixture.get("starting_at"),
                    "status": "finished",
                }
            )

        db.upsert("fixtures", fixture_rows, on_conflict="sportmonks_id")
        print(f"  fixtures written: {len(fixture_rows)}")

        fixture_row_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select(
                "fixtures", select="id,sportmonks_id", season_id=f"eq.{season_row_id}"
            )
            if row["sportmonks_id"]
        }

        already = {
            row["fixture_id"] for row in db.select("player_match_stats", select="fixture_id")
        }

        pending = [
            fixture
            for fixture in fixtures
            if fixture_row_ids.get(str(fixture["id"]))
            and fixture_row_ids[str(fixture["id"])] not in already
        ]

        print(f"  fetching stats for {len(pending)} fixtures — this takes a few minutes")

        written = 0
        for index, fixture in enumerate(pending, start=1):
            detail = api.get(
                f"/fixtures/{fixture['id']}", include="lineups.details;scores;participants"
            )
            data = detail.get("data") or {}

            scores = {
                score.get("participant_id"): (score.get("score") or {}).get("goals")
                for score in data.get("scores") or []
                if score.get("description") == "CURRENT"
            }

            participants = data.get("participants") or []
            conceded = {}
            for team in participants:
                opponent = next((p for p in participants if p["id"] != team["id"]), None)
                if opponent:
                    conceded[team["id"]] = scores.get(opponent["id"]) or 0

            rows = stat_rows(
                data, fixture_row_ids[str(fixture["id"])], player_ids, conceded
            )

            if rows:
                db.upsert("player_match_stats", rows, on_conflict="fixture_id,player_id")
                written += len(rows)

            if index % 25 == 0:
                print(f"    {index}/{len(pending)} fixtures, {written} player rows")

        print(f"  player match rows: {written}")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
