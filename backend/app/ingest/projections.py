"""Project expected performance for the next two gameweeks.

    python -m app.ingest.projections

Writes league-agnostic expectations — minutes, goals, assists, clean sheet
probability, saves — into player_gameweek_expectations. Points are derived per
league from those, by projected_points() in SQL, so the model never needs to
know a league's scoring rules.

The model is deliberately simple and legible. Everything it does is one of:

  * a per-90 rate from the player's own history, scaled by expected minutes
  * a fixture adjustment from FPL's 1-5 difficulty rating
  * a Poisson probability for clean sheets

It is not trying to beat the market. It is trying to be better than nothing and
possible to reason about when a number looks wrong.
"""

from __future__ import annotations

import math
import sys
from collections import defaultdict
from typing import Any

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

# How many upcoming gameweeks to project.
HORIZON = 2

# Below this many appearances the rates are noise. Stored anyway, but
# projected_points() returns null so the UI can stay quiet.
MINIMUM_MATCHES = 3

# FPL difficulty runs 1 (easiest) to 5 (hardest). These multiply attacking
# output and expected goals conceded respectively. Deliberately gentle: fixture
# difficulty matters less than people think, and far less than minutes.
ATTACK_BY_DIFFICULTY = {1: 1.25, 2: 1.12, 3: 1.0, 4: 0.88, 5: 0.75}
CONCEDE_BY_DIFFICULTY = {1: 0.75, 2: 0.88, 3: 1.0, 4: 1.15, 5: 1.35}

# Availability codes: how much of their usual minutes we expect.
AVAILABILITY_FACTOR = {"a": 1.0, "d": 0.5, "i": 0.0, "s": 0.0, "u": 0.0, "n": 0.0}


def expected_minutes(history: list[dict[str, Any]], player: dict[str, Any]) -> float:
    """Recent minutes, adjusted for whether they're fit to play.

    Predicting minutes is the hardest part of any projection and the biggest
    driver of error. This uses the last five appearances rather than a season
    average, so a player who has just broken into the side isn't punished for
    September.
    """
    recent = [row["minutes"] for row in history[-5:]]
    base = sum(recent) / len(recent) if recent else 0.0

    availability = player.get("availability") or "a"
    factor = AVAILABILITY_FACTOR.get(availability, 1.0)

    # An explicit percentage from the club beats our guess.
    chance = player.get("chance_of_playing")
    if chance is not None:
        factor = chance / 100.0

    return round(base * factor, 1)


def full_game_probability(history: list[dict[str, Any]], minutes: float) -> float:
    """How often they've gone past 60 minutes lately, tempered by fitness."""
    recent = history[-5:]
    if not recent:
        return 0.0

    rate = sum(1 for row in recent if row["minutes"] >= 60) / len(recent)
    # If expected minutes have been cut by injury, the threshold gets harder.
    return round(min(rate, minutes / 60.0 if minutes < 60 else 1.0), 3)


def per_90(total: float, minutes: float) -> float:
    return (total / minutes * 90.0) if minutes > 0 else 0.0


def project_player(
    player: dict[str, Any],
    history: list[dict[str, Any]],
    difficulty: int | None,
) -> dict[str, Any] | None:
    """One player, one fixture. Returns None if they have no fixture."""
    if difficulty is None:
        return None

    minutes = expected_minutes(history, player)
    played = sum(row["minutes"] for row in history)
    share = minutes / 90.0

    attack = ATTACK_BY_DIFFICULTY.get(difficulty, 1.0)
    concede = CONCEDE_BY_DIFFICULTY.get(difficulty, 1.0)

    # Prefer the player's own history; fall back to FPL's per-90 figures, which
    # carry over preseason and are calculated the same way.
    goals_90 = per_90(sum(r["goals"] for r in history), played) or float(
        player.get("xg_per_90") or 0
    )
    assists_90 = per_90(sum(r["assists"] for r in history), played) or float(
        player.get("xa_per_90") or 0
    )
    saves_90 = per_90(sum(r["saves"] for r in history), played)
    yellows_90 = per_90(sum(r["yellow_cards"] for r in history), played)

    conceded_90 = per_90(sum(r["goals_conceded"] for r in history), played) or float(
        player.get("xgc_per_90") or 0
    )
    conceded = conceded_90 * concede

    # Poisson: probability the opposition scores zero, given an expected number
    # of goals against. Only meaningful if the player is actually on the pitch
    # for most of the match.
    clean_sheet = math.exp(-conceded) * min(1.0, share) if conceded > 0 else 0.0

    return {
        "minutes": minutes,
        "full_game_probability": full_game_probability(history, minutes),
        "goals": round(goals_90 * share * attack, 3),
        "assists": round(assists_90 * share * attack, 3),
        "clean_sheet_probability": round(clean_sheet, 3),
        "goals_conceded": round(conceded * share, 2),
        "saves": round(saves_90 * share * concede, 2),
        "yellow_cards": round(yellows_90 * share, 3),
        "matches_observed": len(history),
    }


def main() -> int:
    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.", file=sys.stderr)
        return 1

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        seasons = db.select("seasons", select="id", is_current="is.true")
        if not seasons:
            print("No current season found.", file=sys.stderr)
            return 1

        season_id = seasons[0]["id"]

        gameweeks = db.select(
            "gameweeks",
            select="id,number,status,deadline_at",
            season_id=f"eq.{season_id}",
            order="number",
        )

        upcoming = [row for row in gameweeks if row["status"] != "complete"][:HORIZON]
        if not upcoming:
            print("No upcoming gameweeks.")
            return 0

        players = db.select(
            "players",
            select="id,position,club_id,availability,chance_of_playing,xg_per_90,xa_per_90,xgc_per_90",
            is_active="is.true",
        )

        # Match history, oldest first, so "last five" means what it says.
        stats = db.select(
            "player_match_stats",
            select="player_id,minutes,goals,assists,goals_conceded,saves,yellow_cards,fixtures!inner(gameweek_id,kickoff_at,season_id)",
            order="fixtures(kickoff_at)",
        )

        history: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in stats:
            history[row["player_id"]].append(row)

        rows: list[dict[str, Any]] = []

        for gameweek in upcoming:
            fixtures = db.select(
                "fixtures",
                select="home_club_id,away_club_id,home_difficulty,away_difficulty",
                gameweek_id=f"eq.{gameweek['id']}",
            )

            # A club can have two fixtures in a double gameweek; the easier one
            # is a reasonable simplification.
            difficulty_by_club: dict[str, int] = {}
            for fixture in fixtures:
                for club, value in (
                    (fixture["home_club_id"], fixture.get("home_difficulty")),
                    (fixture["away_club_id"], fixture.get("away_difficulty")),
                ):
                    if value is None:
                        continue
                    difficulty_by_club[club] = min(difficulty_by_club.get(club, 5), value)

            for player in players:
                projection = project_player(
                    player,
                    history.get(player["id"], []),
                    difficulty_by_club.get(player["club_id"]),
                )

                if projection is None:
                    continue

                rows.append(
                    {"player_id": player["id"], "gameweek_id": gameweek["id"], **projection}
                )

            print(f"  gameweek {gameweek['number']}: {len(rows)} rows so far")

        db.upsert(
            "player_gameweek_expectations", rows, on_conflict="player_id,gameweek_id"
        )
        print(f"Wrote {len(rows)} expectation rows (minimum {MINIMUM_MATCHES} matches to show).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
