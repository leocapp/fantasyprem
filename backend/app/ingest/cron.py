"""Everything the app needs done on a schedule, in one command.

    python -m app.ingest.cron

Four steps, in order:

1. Refresh reference data — squads, gameweek deadlines, fixture status.
2. Ingest match stats for played gameweeks and score every league.
3. Project expected performance for the next two gameweeks.
4. Settle any trades whose veto window has closed.

Safe to run repeatedly: every step is an upsert or a no-op when there's
nothing to do. Designed for GitHub Actions, but any scheduler works.
"""

from __future__ import annotations

import sys

from app.config import get_settings
from app.ingest import fpl, projections, stats
from app.ingest.supabase_rest import SupabaseRest


def main() -> int:
    settings = get_settings()

    if not settings.supabase_url or not settings.supabase_service_role_key:
        print(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
            file=sys.stderr,
        )
        return 1

    print("[1/3] Refreshing clubs, players, gameweeks and fixtures")
    code = fpl.main()
    if code != 0:
        return code

    print("[2/3] Ingesting match stats and scoring leagues")
    code = stats.main([])
    if code != 0:
        return code

    print("[3/4] Projecting the next gameweeks")
    code = projections.main()
    if code != 0:
        return code

    print("[4/4] Settling trades past their veto window")
    with SupabaseRest(settings.supabase_url, settings.supabase_service_role_key) as db:
        settled = db.rpc("execute_all_due_trades", {})
        print(f"  settled {settled} trade(s)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
