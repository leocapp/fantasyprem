"""Everything the app needs done on a schedule, in one command.

    python -m app.ingest.cron

Five steps, in order:

1. Refresh squads, fixtures, gameweeks and match statistics from Sportmonks.
2. Score every league from those statistics.
3. Project expected performance for the next two gameweeks.
4. Recompute draft rankings, and settle trades past their veto window.
5. Email managers who haven't set a lineup before the deadline.

Safe to run repeatedly: every step is an upsert or a no-op when there's nothing
to do. Designed for GitHub Actions, but any scheduler works.

The FPL ingestion (app.ingest.fpl) is retained but no longer called. Reverting
means changing step 1 back — the data model is provider-agnostic, so nothing
downstream cares which one filled the tables.
"""

from __future__ import annotations

import sys
import time

from app.config import get_settings
from app.ingest import projections, reminders, sportmonks
from app.ingest.supabase_rest import SupabaseRest


def main() -> int:
    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
            file=sys.stderr,
        )
        return 1

    # The workflow gives the job eight minutes. Printing each step's elapsed
    # time means a run that creeps toward that says which step is creeping.
    started = time.monotonic()

    def elapsed(step: str) -> None:
        print(f"[{step} took {time.monotonic() - started:.0f}s total so far]")

    # A provider outage used to stop everything. Steps 2 to 5 read the
    # database rather than the API, so scoring, projections and reminders all
    # work fine on whatever was last ingested — and refusing to run them means
    # a Sportmonks outage becomes a scoring outage, which is a far worse
    # failure for anyone playing.
    #
    # The run still ends non-zero so it shows up red rather than passing
    # quietly with stale data.
    print("[1/5] Refreshing squads, fixtures and match statistics")
    ingest_failed = False

    try:
        if sportmonks.main([]) != 0:
            ingest_failed = True
    except Exception as exc:  # noqa: BLE001 - any provider failure, not ours
        ingest_failed = True
        print(f"  ingest failed: {exc}", file=sys.stderr)

    if ingest_failed:
        print(
            "  continuing with the data already in the database — scoring and "
            "reminders do not need the provider",
            file=sys.stderr,
        )

    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        # Live gameweeks are scored too, not just finished ones. That's what
        # makes matchup scores move during a match — score_gameweek marks a
        # matchup 'final' only once its gameweek is complete, 'live' before
        # that. It also means a gameweek waiting on one postponed fixture keeps
        # updating instead of showing nothing until the match is played.
        print("[2/5] Scoring live and completed gameweeks")

        # Restricted to the current season. The backfilled season's gameweeks
        # are all complete and belong to no league, so scoring them is 38
        # round trips an hour to do nothing.
        seasons = db.select("seasons", select="id", is_current="is.true")
        season_id = seasons[0]["id"] if seasons else None

        gameweeks = (
            db.select(
                "gameweeks",
                select="id,number,status",
                season_id=f"eq.{season_id}",
                status="in.(active,complete)",
                order="number",
            )
            if season_id
            else []
        )
        for gameweek in gameweeks:
            leagues = db.rpc("score_all", {"p_gameweek_id": gameweek["id"]})
            if leagues:
                print(f"  gameweek {gameweek['number']}: {leagues} league(s)")

        elapsed("through step 2")

        print("[3/5] Projecting the next gameweeks")
        code = projections.main()
        if code != 0:
            return code

        print("[4/5] Draft rankings and trade settlement")
        ranked = db.rpc("recompute_all_draft_values", {})
        print(f"  ranked {ranked} player-league rows")
        settled = db.rpc("execute_all_due_trades", {})
        print(f"  settled {settled} trade(s)")

    elapsed("through step 4")

    print("[5/5] Sending lineup reminders")
    code = reminders.main()
    elapsed("everything")

    # Non-zero if either half failed, so a degraded run is still visibly red.
    return 1 if ingest_failed else code


if __name__ == "__main__":
    raise SystemExit(main())
