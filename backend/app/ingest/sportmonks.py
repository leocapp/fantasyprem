"""Ingest Premier League data from Sportmonks.

    python -m app.ingest.sportmonks

Writes into the same tables the FPL job uses, keyed on sportmonks_id rather
than external_id, so both providers can populate the same rows without
fighting. Nothing here decides which provider is authoritative — that's a
question for the sync layer once the trial is over.

Structure of their data, since it isn't obvious:

  * Per-player match statistics live in fixtures.lineups[].details[], each
    carrying a numeric type_id. STAT_TYPES below is the decoder.
  * Rounds are what we call gameweeks.
  * Positions come as ids: 24 goalkeeper, 25 defender, 26 midfielder,
    27 attacker.
  * Clean sheets exist as a statistic but aren't reliably present per match,
    so they're derived from goals conceded and minutes.
"""

from __future__ import annotations

import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import get_settings
from app.ingest.supabase_rest import SupabaseRest

FOOTBALL = "https://api.sportmonks.com/v3/football"
PREMIER_LEAGUE_ID = 8

POSITIONS = {24: "GK", 25: "DEF", 26: "MID", 27: "FWD"}

# Twenty clubs of roughly 25 players each is ~500. Anything under this means the
# squad fetch came back short, and deactivating on a short response would empty
# the player list, the draft board and every free agent page at once.
MINIMUM_SQUAD_TOTAL = 300

# How long before the first kickoff the captain is settled. Ten minutes is
# enough to react to a team sheet — those land an hour before — without being so
# early that people forget. Individual players lock at their own kickoff, so
# this only really governs the armband and the earliest match.
DEADLINE_LEAD = timedelta(minutes=10)


def deadline_from(first_kickoff: str) -> str:
    """Gameweek deadline: DEADLINE_LEAD before the first match starts.

    Sportmonks gives 'YYYY-MM-DD HH:MM:SS' in UTC. Parsed and re-emitted as an
    explicit UTC timestamp rather than passed through, so Postgres can't read it
    as local time.
    """
    moment = datetime.fromisoformat(first_kickoff.replace(" ", "T"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (moment - DEADLINE_LEAD).isoformat()

# Lineup entries are starters (11) or bench (12).
STARTER_TYPE = 11

# type_id -> the column it feeds on player_match_stats.
STAT_TYPES = {
    119: "minutes",
    52: "goals",
    79: "assists",
    88: "goals_conceded",
    57: "saves",
    84: "yellow_cards",
    83: "red_cards",
    324: "own_goals",
    111: "penalties_scored",
    112: "penalties_missed",
    113: "penalties_saved",
    86: "shots_on_target",
    117: "key_passes",
    78: "tackles",
    100: "interceptions",
    580: "big_chances_created",
    106: "duels_won",
    118: "rating",
    # Expected goals. The most stable predictor available: chances created and
    # taken, before the luck of whether they went in.
    5304: "expected_goals",
}

# A second yellow is a sending off. Counted as a red so cards score correctly.
YELLOW_RED = 85

# Their rate limit is per entity per hour. Pacing beats retrying.
PAUSE_SECONDS = 0.15

# A single slow response used to kill the whole run, and with it scoring,
# projections and reminders. Squad responses in particular are large — they
# carry each player's membership history, which is how departures are spotted —
# so an occasional timeout is expected rather than exceptional.
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = 2.0

# Worth retrying: the request never got a real answer, or the answer was
# "busy". Anything else — a 401, a 404, a malformed query — will fail the same
# way three times, so it should surface immediately.
RETRY_STATUS = {429, 500, 502, 503, 504}


class Phase:
    """Elapsed time per stage of the run.

    A five-minute ingest and a forty-second one look identical in the logs
    otherwise, and the difference is usually one endpoint being slow rather
    than anything we changed. Cheap to print, and it turns "it was slow" into
    a specific question.
    """

    def __init__(self) -> None:
        self._start = time.monotonic()
        self._last = self._start

    def mark(self, label: str, detail: str = "") -> None:
        now = time.monotonic()
        print(f"  {label}: {detail} [{now - self._last:.1f}s]".replace(":  ", ": "))
        self._last = now

    def total(self) -> float:
        return time.monotonic() - self._start


class Sportmonks:
    def __init__(self, token: str) -> None:
        self._client = httpx.Client(
            base_url=FOOTBALL, params={"api_token": token}, timeout=90.0
        )

    def __enter__(self) -> Sportmonks:
        return self

    def __exit__(self, *exc: object) -> None:
        self._client.close()

    def get(self, path: str, **params: str) -> dict[str, Any]:
        reason = ""

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = self._client.get(path, params=params)
            except httpx.TimeoutException as exc:
                reason = f"timed out ({type(exc).__name__})"
            except httpx.TransportError as exc:
                reason = f"connection failed ({type(exc).__name__})"
            else:
                if response.status_code not in RETRY_STATUS:
                    if response.is_error:
                        raise RuntimeError(
                            f"{path} failed ({response.status_code}): {response.text[:300]}"
                        )
                    time.sleep(PAUSE_SECONDS)
                    return response.json()

                reason = f"HTTP {response.status_code}"

            if attempt < MAX_ATTEMPTS:
                wait = BACKOFF_SECONDS * (2 ** (attempt - 1))
                print(f"  {path}: {reason}, retrying in {wait:.0f}s", file=sys.stderr)
                time.sleep(wait)

        raise RuntimeError(f"{path} failed after {MAX_ATTEMPTS} attempts: {reason}")

    def paged(self, path: str, **params: str) -> list[dict[str, Any]]:
        """Follow pagination to the end. Their pages are 25 by default.

        100 per page rather than 50: a season's fixtures took 135 seconds
        across eight pages, and most of that is per-request latency rather than
        payload size, so halving the number of requests halves the wait.
        """
        rows: list[dict[str, Any]] = []
        page = 1

        while True:
            payload = self.get(path, page=str(page), per_page="100", **params)
            rows.extend(payload.get("data") or [])

            pagination = payload.get("pagination") or {}
            if not pagination.get("has_more"):
                return rows

            page += 1
            if page > 200:  # safety valve
                return rows


def current_season(api: Sportmonks) -> dict[str, Any]:
    league = api.get(f"/leagues/{PREMIER_LEAGUE_ID}", include="currentSeason")
    data = league.get("data") or {}
    season = data.get("currentseason") or data.get("currentSeason")
    if not season:
        raise RuntimeError("No current season returned for the Premier League")
    return season


def dedupe(rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Last row wins for each key.

    Every upsert here targets a unique constraint, and Postgres rejects an
    ON CONFLICT that would affect the same row twice within one statement:

      ON CONFLICT DO UPDATE command cannot affect row a second time

    That's a 500 from PostgREST and it kills the whole run, so any batch built
    by looping over clubs needs this — a player or an absence can legitimately
    appear under two of them.
    """
    unique: dict[Any, dict[str, Any]] = {}
    for row in rows:
        unique[row.get(key)] = row
    return list(unique.values())


def club_rows(teams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "sportmonks_id": str(team["id"]),
            "name": team.get("name"),
            "short_name": team.get("short_code") or (team.get("name") or "")[:3].upper(),
            "crest_url": team.get("image_path"),
        }
        for team in teams
    ]


def has_left(player: dict[str, Any], club_sportmonks_id: str) -> bool:
    """Has this player moved on from the club whose squad we're reading?

    The squad endpoints don't know. Both /squads/teams/{id} and the
    season-scoped variant still list Casemiro at Manchester United months after
    he signed in MLS, and the contract `end` field doesn't separate him — it's
    null for him and also null for both of United's goalkeepers, so it means
    "no end recorded", not "gone".

    What does distinguish them is the player's own membership history. The club
    they actually play for is the one whose spell started most recently:

        Bruno Fernandes  team 14      start 2020-01-29   <- still United
        Casemiro         team 239235  start 2026-07-22   <- left
                         team 14      start 2022-08-22

    Deliberately fails open. Without membership data we keep the player, because
    wrongly dropping someone removes a real footballer from every draft board
    and roster, while wrongly keeping one costs a manager a pick. The same
    caution applies to a loan: the loan spell starts later, so the borrowing
    club wins, which is what we want.
    """
    memberships = player.get("teams") or []

    dated = [row for row in memberships if row.get("start")]
    if not dated:
        return False

    latest = max(dated, key=lambda row: str(row["start"]))
    return str(latest.get("team_id")) != str(club_sportmonks_id)


def player_rows(
    squad: list[dict[str, Any]],
    club_id: str,
    club_sportmonks_id: str,
) -> list[dict[str, Any]]:
    rows = []

    for entry in squad:
        player = entry.get("player") or {}
        position = POSITIONS.get(player.get("position_id") or entry.get("position_id"))

        # Coaches and unknown position ids aren't draftable.
        if not position:
            continue

        if has_left(player, club_sportmonks_id):
            continue

        rows.append(
            {
                "sportmonks_id": str(player["id"]),
                "first_name": player.get("firstname"),
                "last_name": player.get("lastname") or player.get("name"),
                "display_name": player.get("display_name") or player.get("common_name"),
                "position": position,
                "club_id": club_id,
                "shirt_number": entry.get("jersey_number"),
                "photo_url": player.get("image_path"),
                "date_of_birth": player.get("date_of_birth"),
                "is_active": True,
            }
        )

    return rows


def absence_rows(
    sidelined: list[dict[str, Any]],
    player_ids: dict[str, str],
    today: date,
) -> list[dict[str, Any]]:
    """Current injuries and suspensions for one club.

    An entry counts as current when it isn't completed and either has no end
    date — out indefinitely — or an end date still in the future. Historical
    absences come back in the same list and have to be filtered out, or every
    player who has ever been injured looks unavailable.
    """
    rows = []

    for entry in sidelined:
        if entry.get("completed"):
            continue

        end = entry.get("end_date")
        if end:
            try:
                if date.fromisoformat(end) < today:
                    continue
            except ValueError:
                pass

        player_id = player_ids.get(str(entry.get("player_id")))
        if not player_id:
            continue

        category = (entry.get("category") or "").lower()
        description = (entry.get("type") or {}).get("name")

        rows.append(
            {
                "id": player_id,
                "availability": "s" if category == "suspension" else "i",
                "news": description or category.title() or "Unavailable",
                "expected_return": end,
                "games_missed": entry.get("games_missed"),
            }
        )

    return rows


def missing_player_rows(
    fixture: dict[str, Any],
    player_ids: dict[str, str],
    club_ids: dict[str, str],
) -> list[dict[str, Any]]:
    """Players in this fixture's lineups that we don't hold yet.

    Needed because a past season's lineups are full of people who are no longer
    in the league. Without rows for them their matches are dropped, which skews
    every positional baseline and every replacement level computed from that
    season — the numbers the draft board is built on.

    Created inactive. They are historical: they should count towards last
    season's totals and draft rankings without appearing in the player list,
    the draft board or free agency.
    """
    rows: dict[str, dict[str, Any]] = {}

    for entry in fixture.get("lineups") or []:
        provider_id = str(entry.get("player_id"))
        if not provider_id or provider_id in player_ids or provider_id in rows:
            continue

        player = entry.get("player") or {}
        position = POSITIONS.get(player.get("position_id") or entry.get("position_id"))

        # Position is an enum and not nullable, and a player we can't place
        # can't be scored either. Rare enough to skip rather than guess.
        if not position:
            continue

        name = player.get("display_name") or player.get("name")
        if not name:
            continue

        rows[provider_id] = {
            "sportmonks_id": provider_id,
            "display_name": name,
            "first_name": player.get("firstname"),
            "last_name": player.get("lastname") or name,
            "position": position,
            "photo_url": player.get("image_path"),
            # The club they turned out for in this match, which for a past
            # season is more useful than wherever they are now.
            "club_id": club_ids.get(str(entry.get("team_id"))),
            "date_of_birth": player.get("date_of_birth"),
            "is_active": False,
        }

    return list(rows.values())


def stat_rows(
    fixture: dict[str, Any],
    fixture_id: str,
    player_ids: dict[str, str],
    conceded_by_team: dict[int, int],
) -> list[dict[str, Any]]:
    """One row per player who appeared, from lineups[].details[]."""
    rows = []

    for entry in fixture.get("lineups") or []:
        player_id = player_ids.get(str(entry.get("player_id")))
        if not player_id:
            continue

        values: dict[str, Any] = defaultdict(int)
        for detail in entry.get("details") or []:
            column = STAT_TYPES.get(detail.get("type_id"))
            value = (detail.get("data") or {}).get("value")

            if column and value is not None:
                # Booleans appear for flags like captain; ignore those here.
                if isinstance(value, bool):
                    continue
                values[column] = value
            elif detail.get("type_id") == YELLOW_RED:
                values["red_cards"] = (values.get("red_cards") or 0) + 1

        minutes = int(values.get("minutes") or 0)
        if minutes == 0 and entry.get("type_id") != STARTER_TYPE:
            continue  # unused substitute

        conceded = conceded_by_team.get(entry.get("team_id"), 0)

        rows.append(
            {
                "fixture_id": fixture_id,
                "player_id": player_id,
                "minutes": minutes,
                "goals": int(values.get("goals") or 0),
                "assists": int(values.get("assists") or 0),
                # Derived, not reported: their cleansheet statistic isn't
                # reliably present per match.
                "clean_sheet": conceded == 0 and minutes >= 60,
                "goals_conceded": int(values.get("goals_conceded") or conceded),
                "own_goals": int(values.get("own_goals") or 0),
                "penalties_scored": int(values.get("penalties_scored") or 0),
                "penalties_missed": int(values.get("penalties_missed") or 0),
                "penalties_saved": int(values.get("penalties_saved") or 0),
                "saves": int(values.get("saves") or 0),
                "yellow_cards": int(values.get("yellow_cards") or 0),
                "red_cards": int(values.get("red_cards") or 0),
                # No equivalent: bonus was an FPL invention.
                "bonus": 0,
                "shots_on_target": int(values.get("shots_on_target") or 0),
                "key_passes": int(values.get("key_passes") or 0),
                "tackles": int(values.get("tackles") or 0),
                "interceptions": int(values.get("interceptions") or 0),
                "big_chances_created": int(values.get("big_chances_created") or 0),
                "duels_won": int(values.get("duels_won") or 0),
                "rating": values.get("rating"),
                "expected_goals": values.get("expected_goals"),
            }
        )

    return rows


def main() -> int:
    settings = get_settings()

    if not settings.sportmonks_token:
        print("SPORTMONKS_TOKEN not set — skipping", file=sys.stderr)
        return 1

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print("Supabase credentials missing.", file=sys.stderr)
        return 1

    with (
        Sportmonks(settings.sportmonks_token) as api,
        SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db,
    ):
        season = current_season(api)
        print(f"Season {season['id']} ({season.get('name')})")
        phase = Phase()

        seasons = db.select("seasons", select="id,label", is_current="is.true")
        if not seasons:
            print("No current season in the database.", file=sys.stderr)
            return 1
        season_row_id = seasons[0]["id"]

        # --- clubs -------------------------------------------------------
        teams = api.paged(f"/teams/seasons/{season['id']}")
        clubs = club_rows(teams)
        db.upsert("clubs", dedupe(clubs, "sportmonks_id"), on_conflict="sportmonks_id")
        phase.mark("clubs", str(len(clubs)))

        club_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select("clubs", select="id,sportmonks_id")
            if row["sportmonks_id"]
        }

        # --- players and absences ----------------------------------------
        # One request per club, not two. Squad and sidelined both hang off the
        # club, and the two separate loops cost 119s and 201s in a measured run
        # — over two thirds of the whole ingest, almost all of it round-trip
        # latency rather than payload.
        #
        # player.teams is what makes departures visible; without it the squad
        # list includes players who left months ago.
        players: list[dict[str, Any]] = []
        sidelined_by_club: dict[str, list[dict[str, Any]]] = {}

        for team in teams:
            club_id = club_ids.get(str(team["id"]))
            if not club_id:
                continue

            detail = api.get(
                f"/teams/{team['id']}",
                include="squad.player.position;squad.player.teams;sidelined.type",
            )
            data = detail.get("data") or {}
            squad = data.get("squad")

            # Fall back rather than silently ingesting an empty squad, which
            # would trip the circuit breaker below and abort the run. Costs the
            # two requests this change exists to avoid, but only for that club
            # and only while the combined include is unavailable.
            if squad is None:
                print(
                    f"  club {team['id']}: combined include returned no squad, "
                    "falling back to separate requests",
                    file=sys.stderr,
                )
                squad = (
                    api.get(
                        f"/squads/teams/{team['id']}",
                        include="player.position;player.teams",
                    ).get("data")
                    or []
                )
                data["sidelined"] = (
                    api.get(f"/teams/{team['id']}", include="sidelined.type")
                    .get("data", {})
                    .get("sidelined")
                    or []
                )

            players.extend(player_rows(squad, club_id, str(team["id"])))
            sidelined_by_club[str(team["id"])] = data.get("sidelined") or []

        # Nothing tells us a player has left — they simply stop appearing in any
        # squad. So is_active has to be rebuilt from the squads just fetched
        # rather than only ever being set true, which is the same reset-then-
        # reapply the absence list below uses. The FPL ingestion did this; the
        # switch to Sportmonks lost it, and the active pool grew every run until
        # it held roughly twice as many players as the league actually has.
        #
        # The floor is a circuit breaker: a partial API response would otherwise
        # deactivate the entire league and empty every player list on the site.
        if len(players) < MINIMUM_SQUAD_TOTAL:
            print(
                f"Only {len(players)} players across {len(teams)} squads — expected at "
                f"least {MINIMUM_SQUAD_TOTAL}. Refusing to deactivate anyone on what "
                "looks like a partial response.",
                file=sys.stderr,
            )
            return 1

        # A player mid-transfer appears in both clubs' squads, and Postgres
        # refuses an ON CONFLICT that would touch the same row twice in one
        # statement — so a single transfer window breaks the whole run. Keeping
        # the last listing is arbitrary but harmless: the next run corrects it
        # once the provider drops them from the old squad, and the club only
        # affects which fixture we read for them.
        unique_players = dedupe(players, "sportmonks_id")
        moved = len(players) - len(unique_players)
        if moved:
            print(f"  {moved} player(s) listed at two clubs — keeping the later listing")

        db.update("players", {"is_active": False}, is_active="is.true")
        db.upsert("players", unique_players, on_conflict="sportmonks_id")
        phase.mark("players", f"{len(unique_players)} active, everyone else deactivated")

        player_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select("players", select="id,sportmonks_id")
            if row["sportmonks_id"]
        }

        # --- injuries and suspensions ------------------------------------
        # Cleared first, then reapplied. Without the reset a player who has
        # recovered keeps their old flag forever, because nothing tells us an
        # absence ended — it just stops appearing in the list.
        db.update(
            "players",
            {"availability": None, "news": None, "expected_return": None, "games_missed": None},
            is_active="is.true",
        )

        today = datetime.now(timezone.utc).date()
        absences: list[dict[str, Any]] = []

        for team in teams:
            # Already fetched alongside the squad above.
            sidelined = sidelined_by_club.get(str(team["id"]), [])
            absences.extend(absence_rows(sidelined, player_ids, today))

        for absence in absences:
            player_id = absence.pop("id")
            db.update("players", absence, id=f"eq.{player_id}")

        phase.mark("absences", f"{len(absences)} players injured or suspended")

        # --- fixtures ----------------------------------------------------
        fixtures = api.paged(
            "/fixtures",
            filters=f"fixtureSeasons:{season['id']}",
            include="participants;round;state;scores",
        )
        phase.mark("fixtures returned", str(len(fixtures)))

        # --- gameweeks ---------------------------------------------------
        # Rounds are gameweeks. Sportmonks has no concept of a lineup deadline,
        # so we set our own: the first kickoff of the round. That's stricter
        # than FPL's (90 minutes before the first match) and, more importantly,
        # it's ours to choose rather than inherited.
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
            if number not in rounds or kickoff < rounds[number]:
                rounds[number] = kickoff

        # status is deliberately absent. This is an upsert, so including it
        # would reset every gameweek to 'upcoming' on every run — which is
        # exactly what stopped anything from ever being scored. New rows take
        # the column default; existing rows keep whatever
        # refresh_gameweek_statuses last derived.
        gameweek_rows = [
            {
                "season_id": season_row_id,
                "number": number,
                "deadline_at": deadline_from(kickoff),
            }
            for number, kickoff in sorted(rounds.items())
        ]

        db.upsert("gameweeks", gameweek_rows, on_conflict="season_id,number")
        phase.mark("gameweeks", str(len(gameweek_rows)))

        gameweek_ids = {
            row["number"]: row["id"]
            for row in db.select(
                "gameweeks", select="id,number", season_id=f"eq.{season_row_id}"
            )
        }

        fixture_rows = []
        for fixture in fixtures:
            round_number = (fixture.get("round") or {}).get("name")
            gameweek_id = gameweek_ids.get(int(round_number)) if round_number else None

            participants = fixture.get("participants") or []
            home = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "home"),
                None,
            )
            away = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "away"),
                None,
            )

            if not (gameweek_id and home and away):
                continue

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
                    "home_club_id": club_ids.get(str(home["id"])),
                    "away_club_id": club_ids.get(str(away["id"])),
                    "home_score": goals.get(home["id"]),
                    "away_score": goals.get(away["id"]),
                    "kickoff_at": fixture.get("starting_at"),
                }
            )

        db.upsert("fixtures", dedupe(fixture_rows, "sportmonks_id"), on_conflict="sportmonks_id")

        # Now that the fixtures are current, let the database work out which
        # gameweeks are upcoming, live or finished. Scoring keys off this.
        changed = db.rpc("refresh_gameweek_statuses", {"p_season_id": season_row_id})
        if changed:
            print(f"  gameweek statuses updated: {changed}")
        phase.mark("fixtures written", str(len(fixture_rows)))

        # --- match statistics --------------------------------------------
        # Only played matches, and only ones we haven't already recorded.
        # Each needs its own request, so this is where the rate limit bites:
        # 380 fixtures a season, 3,000 requests an hour. Fine incrementally,
        # deliberate on a first backfill.
        fixture_row_ids = {
            row["sportmonks_id"]: row["id"]
            for row in db.select(
                "fixtures", select="id,sportmonks_id", season_id=f"eq.{season_row_id}"
            )
            if row["sportmonks_id"]
        }

        already = {
            row["fixture_id"]
            for row in db.select("player_match_stats", select="fixture_id")
        }

        played = [
            fixture
            for fixture in fixtures
            if (fixture.get("state") or {}).get("short_name") in ("FT", "AET", "FT_PEN")
            and fixture_row_ids.get(str(fixture["id"])) not in already
        ]

        phase.mark("fixtures needing stats", str(len(played)))

        written = 0
        for fixture in played:
            detail = api.get(
                f"/fixtures/{fixture['id']}",
                include="lineups.details;scores;participants",
            )
            data = detail.get("data") or {}

            # Goals conceded per side, for deriving clean sheets.
            conceded: dict[int, int] = {}
            participants = data.get("participants") or []
            scores = {}
            for score in data.get("scores") or []:
                if score.get("description") == "CURRENT":
                    entry = score.get("score") or {}
                    scores[score.get("participant_id")] = entry.get("goals")

            for team in participants:
                opponent = next((p for p in participants if p["id"] != team["id"]), None)
                if opponent:
                    conceded[team["id"]] = scores.get(opponent["id"]) or 0

            rows = stat_rows(
                data,
                fixture_row_ids[str(fixture["id"])],
                player_ids,
                conceded,
            )

            if rows:
                db.upsert(
                    "player_match_stats", rows, on_conflict="fixture_id,player_id"
                )
                written += len(rows)

            # Store the score too: team attacking and defensive strength is
            # derived from it, and we already have it here.
            home = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "home"),
                None,
            )
            away = next(
                (p for p in participants if (p.get("meta") or {}).get("location") == "away"),
                None,
            )
            if home and away:
                db.update(
                    "fixtures",
                    {
                        "home_score": scores.get(home["id"]),
                        "away_score": scores.get(away["id"]),
                        "status": "finished",
                    },
                    id=f"eq.{fixture_row_ids[str(fixture['id'])]}",
                )

        phase.mark("player match rows", str(written))
        print(f"  total: {phase.total():.1f}s")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
