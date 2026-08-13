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

    print("[1/5] Refreshing squads, fixtures and match statistics")
    code = sportmonks.main()
    if code != 0:
        return code

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

        print("[3/5] Projecting the next gameweeks")
        code = projections.main()
        if code != 0:
            return code

        print("[4/5] Draft rankings and trade settlement")
        ranked = db.rpc("recompute_all_draft_values", {})
        print(f"  ranked {ranked} player-league rows")
        settled = db.rpc("execute_all_due_trades", {})
        print(f"  settled {settled} trade(s)")

    print("[5/5] Sending lineup reminders")
    return reminders.main()


if __name__ == "__main__":
    raise SystemExit(main())
