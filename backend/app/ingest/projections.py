"""Project expected performance for the next two gameweeks.

    python -m app.ingest.projections

Writes league-agnostic expectations — minutes, goals, assists, clean sheet
probability, saves — into player_gameweek_expectations. Points are derived per
league from those by projected_points() in SQL, so the model never needs to know
a league's scoring rules.

Three things drive it, in order of how much they matter:

  1. Expected minutes. A projection is mostly a guess about whether someone
     plays. Everything else is scaled by this.
  2. Per-90 rates from the player's own matches, blended between last season and
     this one. Early in a season last season carries the weight; by around ten
     matches it barely counts.
  3. Opponent strength, derived from real goals scored and conceded rather than
     a provider's opinion.

Expected goals are preferred to actual goals wherever available. Goals are rare
enough that a handful either way is mostly luck; the chances behind them are far
more stable.
"""

from __future__ import annotations

import math
import sys
from collections import defaultdict
from datetime import date
from typing import Any

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

HORIZON = 2

# Below this, the numbers are noise and projected_points() returns null.
MINIMUM_MATCHES = 3

# How many of this season's matches before last season stops counting. Ten is
# roughly where a player's current form becomes more informative than their
# previous one.
PRIOR_FADES_AFTER = 10

AVAILABILITY_FACTOR = {"a": 1.0, "d": 0.5, "i": 0.0, "s": 0.0, "u": 0.0, "n": 0.0}

# The Sportmonks ingestion clears and repopulates availability on every run, so
# it can be trusted again. It was off while nothing maintained the column, which
# is the only safe default: a stale absence silently zeroes a fit player.
AVAILABILITY_DATA_IS_MAINTAINED = True

# A player expected back within a few days of the deadline might feature, but
# rarely for a full match. Better than treating "back tomorrow" and "out for the
# season" identically, which is all FPL's data allowed.
RETURNING_SOON_DAYS = 7
RETURNING_SOON_FACTOR = 0.4

# A goal is worth roughly this many assists in terms of how often it happens;
# used only to spread expected goals when a player has no xG recorded.
LEAGUE_AVERAGE_GOALS_PER_MATCH = 1.4


def per_90(total: float, minutes: float) -> float:
    return (total / minutes * 90.0) if minutes > 0 else 0.0


# How many minutes of a player's own record it takes to outweigh the average for
# their position. Roughly five full matches: enough that a striker who scored
# once in a cameo isn't projected as the best forward in the league, but not so
# much that a genuinely prolific player is dragged to the mean all season.
SHRINKAGE_MINUTES = 450.0


def shrunk(total: float, minutes: float, baseline_per_90: float) -> float:
    """A player's rate, pulled toward the average for their position.

    One goal in 46 minutes is a per-90 rate of 1.96, which is nonsense as a
    prediction — the sample is one lucky cameo. Blending with a positional
    baseline in proportion to minutes played fixes that without special-casing:
    a player with a full season barely moves, a player with 90 minutes moves a
    lot.
    """
    prior_goals = baseline_per_90 * SHRINKAGE_MINUTES / 90.0
    return (total + prior_goals) / (minutes + SHRINKAGE_MINUTES) * 90.0


def position_baselines(
    stats: list[dict[str, Any]], positions: dict[str, str]
) -> dict[str, dict[str, float]]:
    """Average per-90 rates by position, used as the prior for shrinkage."""
    totals: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for row in stats:
        position = positions.get(row["player_id"])
        if not position:
            continue
        totals[position]["minutes"] += row.get("minutes") or 0
        for field in ("goals", "assists", "goals_conceded", "saves", "yellow_cards"):
            totals[position][field] += row.get(field) or 0

    baselines: dict[str, dict[str, float]] = {}
    for position, values in totals.items():
        minutes = values["minutes"] or 1
        baselines[position] = {
            field: values[field] / minutes * 90.0
            for field in ("goals", "assists", "goals_conceded", "saves", "yellow_cards")
        }

    return baselines


def blended(current: float, prior: float, matches_this_season: int) -> float:
    """Weighted average of this season and last, by how much of this season exists.

    With no matches played the projection is entirely last season's rate; by
    PRIOR_FADES_AFTER matches it's entirely this season's. Without this a
    projection is useless until October, which was the previous model's main
    weakness.
    """
    weight = min(1.0, matches_this_season / PRIOR_FADES_AFTER)
    return current * weight + prior * (1.0 - weight)


def team_strength(fixtures: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Attack and defence multipliers per club, from real scorelines.

    A club scoring 2.0 a game in a league averaging 1.4 gets an attack of ~1.43.
    Multiplying an opponent's expected goals by that is a crude model, but it's
    derived from what actually happened rather than someone's 1-5 rating.
    """
    scored: dict[str, list[int]] = defaultdict(list)
    conceded: dict[str, list[int]] = defaultdict(list)

    for fixture in fixtures:
        home, away = fixture.get("home_club_id"), fixture.get("away_club_id")
        home_goals, away_goals = fixture.get("home_score"), fixture.get("away_score")

        if None in (home, away, home_goals, away_goals):
            continue

        scored[home].append(home_goals)
        conceded[home].append(away_goals)
        scored[away].append(away_goals)
        conceded[away].append(home_goals)

    all_goals = [goal for goals in scored.values() for goal in goals]
    average = (sum(all_goals) / len(all_goals)) if all_goals else LEAGUE_AVERAGE_GOALS_PER_MATCH
    average = average or LEAGUE_AVERAGE_GOALS_PER_MATCH

    strength: dict[str, dict[str, float]] = {}
    for club in set(scored) | set(conceded):
        club_scored = scored.get(club) or []
        club_conceded = conceded.get(club) or []
        strength[club] = {
            "attack": (sum(club_scored) / len(club_scored) / average) if club_scored else 1.0,
            "defence": (
                (sum(club_conceded) / len(club_conceded) / average) if club_conceded else 1.0
            ),
        }

    return strength


def availability_factor(player: dict[str, Any], deadline: date | None) -> float:
    """How much of their usual minutes to expect, given any recorded absence.

    The expected return date is what makes this better than a flag. A player
    due back three weeks after the deadline is worth nothing; one due back the
    week before is worth a cautious fraction, because managers ease players in.
    """
    availability = player.get("availability")
    if not availability or availability == "a":
        return 1.0

    expected_return = player.get("expected_return")
    if not expected_return or not deadline:
        # Out with no return date is the worst case: indefinitely.
        return AVAILABILITY_FACTOR.get(availability, 0.0)

    try:
        returns_on = date.fromisoformat(expected_return)
    except (TypeError, ValueError):
        return AVAILABILITY_FACTOR.get(availability, 0.0)

    if returns_on > deadline:
        return 0.0

    days_before = (deadline - returns_on).days
    return 1.0 if days_before > RETURNING_SOON_DAYS else RETURNING_SOON_FACTOR


def project(
    player: dict[str, Any],
    current: list[dict[str, Any]],
    prior: list[dict[str, Any]],
    opponent: dict[str, float],
    baseline: dict[str, float] | None = None,
    deadline: date | None = None,
) -> dict[str, Any]:
    recent = current[-5:] or prior[-5:]
    base_minutes = (sum(row["minutes"] for row in recent) / len(recent)) if recent else 0.0

    # Availability is only trusted when something is actively maintaining it.
    # Nothing does since the switch to Sportmonks — their injury feed isn't
    # ingested yet — and a stale value silently zeroed every player's expected
    # minutes, which is a far worse failure than ignoring injuries entirely.
    factor = 1.0
    if AVAILABILITY_DATA_IS_MAINTAINED:
        factor = availability_factor(player, deadline)

    minutes = round(base_minutes * factor, 1)
    share = minutes / 90.0

    played_now = sum(row["minutes"] for row in current)
    played_prior = sum(row["minutes"] for row in prior)
    matches_now = len([row for row in current if row["minutes"] > 0])

    baseline = baseline or {}

    def rate(field: str) -> float:
        average = baseline.get(field, 0.0)
        return blended(
            shrunk(sum(row.get(field) or 0 for row in current), played_now, average),
            shrunk(sum(row.get(field) or 0 for row in prior), played_prior, average),
            matches_now,
        )

    # Expected goals where the provider recorded them, actual goals otherwise.
    xg_rate = rate("expected_goals") or rate("goals")

    goals = xg_rate * share * opponent.get("defence", 1.0)
    assists = rate("assists") * share * opponent.get("defence", 1.0)

    # Poisson: the chance the opposition fail to score at all, given how many
    # they'd be expected to. Only counts if the player is on the pitch for it.
    conceded_rate = rate("goals_conceded") * opponent.get("attack", 1.0)
    clean_sheet = math.exp(-conceded_rate) * min(1.0, share) if conceded_rate > 0 else 0.0

    full_games = [row for row in (current or prior)[-5:] if row["minutes"] >= 60]
    denominator = len((current or prior)[-5:]) or 1

    return {
        "minutes": minutes,
        "full_game_probability": round(
            min(len(full_games) / denominator, 1.0 if minutes >= 60 else minutes / 60.0), 3
        ),
        "goals": round(goals, 3),
        "assists": round(assists, 3),
        "clean_sheet_probability": round(clean_sheet, 3),
        "goals_conceded": round(conceded_rate * share, 2),
        "saves": round(rate("saves") * share * opponent.get("attack", 1.0), 2),
        "yellow_cards": round(rate("yellow_cards") * share, 3),
        # Last season counts toward whether we have enough to project from.
        "matches_observed": matches_now + min(len(prior), PRIOR_FADES_AFTER),
    }


def explain(
    name: str,
    player: dict[str, Any],
    current: list[dict[str, Any]],
    prior: list[dict[str, Any]],
    opponent: dict[str, float],
    result: dict[str, Any],
) -> None:
    """Print the working for one player.

    Written after an afternoon of guessing from database queries: a stale
    availability flag was zeroing every projection, and nothing in the output
    said so. A model that can't explain one row is a model you debug by
    inference.
    """
    print(f"\n--- {name} ---")
    print(f"  availability: {player.get('availability')!r} (trusted: {AVAILABILITY_DATA_IS_MAINTAINED})")
    print(f"  chance_of_playing: {player.get('chance_of_playing')}")
    print(f"  matches this season: {len(current)}, last season: {len(prior)}")

    sample = (current or prior)[-5:]
    print(f"  last 5 minutes: {[row['minutes'] for row in sample]}")
    print(f"  opponent strength: {opponent}")

    for key, value in result.items():
        print(f"  {key}: {value}")


def main(argv: list[str] | None = None) -> int:
    settings = get_settings()

    # python -m app.ingest.projections --player haaland
    argv = argv if argv is not None else sys.argv[1:]
    explain_name = None
    if "--player" in argv:
        index = argv.index("--player")
        explain_name = argv[index + 1] if len(argv) > index + 1 else None

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("Supabase credentials missing.", file=sys.stderr)
        return 1

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        seasons = db.select("seasons", select="id,label,is_current,ends_on", order="ends_on")
        current_season = next((s for s in seasons if s["is_current"]), None)
        if not current_season:
            print("No current season.", file=sys.stderr)
            return 1

        past_seasons = [s["id"] for s in seasons if not s["is_current"]]

        gameweeks = db.select(
            "gameweeks",
            select="id,number,status,deadline_at",
            season_id=f"eq.{current_season['id']}",
            order="number",
        )
        upcoming = [row for row in gameweeks if row["status"] != "complete"][:HORIZON]

        if not upcoming:
            print("  no upcoming gameweeks")
            return 0

        players = db.select(
            "players",
            select=(
                "id,display_name,position,club_id,availability,chance_of_playing,"
                "expected_return"
            ),
            is_active="is.true",
        )
        for player in players:
            player["name"] = player.get("display_name") or ""

        fixtures = db.select(
            "fixtures",
            select="id,gameweek_id,season_id,home_club_id,away_club_id,home_score,away_score",
        )

        strength = team_strength(fixtures)
        season_of_fixture = {row["id"]: row["season_id"] for row in fixtures}

        stats = db.select(
            "player_match_stats",
            select=(
                "player_id,fixture_id,minutes,goals,assists,goals_conceded,saves,"
                "yellow_cards,expected_goals"
            ),
        )

        print(
            f"  {len(stats)} match stat rows, {len(fixtures)} fixtures, "
            f"{len(players)} active players"
        )

        current_history: dict[str, list[dict[str, Any]]] = defaultdict(list)
        prior_history: dict[str, list[dict[str, Any]]] = defaultdict(list)

        for row in stats:
            season = season_of_fixture.get(row["fixture_id"])
            if season == current_season["id"]:
                current_history[row["player_id"]].append(row)
            elif season in past_seasons:
                prior_history[row["player_id"]].append(row)

        print(
            f"  history: {len(current_history)} players this season, "
            f"{len(prior_history)} from last"
        )

        baselines = position_baselines(
            stats, {player["id"]: player["position"] for player in players}
        )
        for position, values in sorted(baselines.items()):
            print(
                f"  baseline {position}: {values['goals']:.3f} goals, "
                f"{values['assists']:.3f} assists per 90"
            )

        rows: list[dict[str, Any]] = []

        club_ids_in_players = {player["club_id"] for player in players}

        for gameweek in upcoming:
            deadline = None
            if gameweek.get("deadline_at"):
                try:
                    deadline = date.fromisoformat(gameweek["deadline_at"][:10])
                except ValueError:
                    deadline = None

            opponents: dict[str, str] = {}
            matching = 0
            for fixture in fixtures:
                if fixture["gameweek_id"] != gameweek["id"]:
                    continue
                matching += 1
                opponents[fixture["home_club_id"]] = fixture["away_club_id"]
                opponents[fixture["away_club_id"]] = fixture["home_club_id"]

            overlap = len(club_ids_in_players & set(opponents))
            print(
                f"  gameweek {gameweek['number']}: {matching} fixtures, "
                f"{len(opponents)} clubs playing, {overlap} of those have players"
            )

            for player in players:
                opponent_club = opponents.get(player["club_id"])
                if not opponent_club:
                    continue  # no fixture this gameweek

                result = project(
                    player,
                    current_history.get(player["id"], []),
                    prior_history.get(player["id"], []),
                    strength.get(opponent_club, {}),
                    baselines.get(player["position"], {}),
                    deadline,
                )

                if explain_name and explain_name.lower() in (player.get("name") or "").lower():
                    explain(
                        player.get("name") or player["id"],
                        player,
                        current_history.get(player["id"], []),
                        prior_history.get(player["id"], []),
                        strength.get(opponent_club, {}),
                        result,
                    )

                rows.append(
                    {"player_id": player["id"], "gameweek_id": gameweek["id"], **result}
                )

            print(f"  gameweek {gameweek['number']}: {len(rows)} rows so far")

        db.upsert(
            "player_gameweek_expectations", rows, on_conflict="player_id,gameweek_id"
        )
        print(f"Wrote {len(rows)} expectation rows")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
