"""Does the Sportmonks transfers endpoint work on this plan?

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_transfers

Reads only. Nothing here writes to the database or changes anything.

We derive transfers from squad changes (see player_club_changes and the
transfers block in sportmonks.py), which costs no extra requests but gives no
fee, no loan-versus-permanent, and no announcement date. Sportmonks documents a
transfers resource that would give all three.

This exists because guessing cost us before: `include=squad` on /teams/{id}
looked like an obvious saving, doesn't exist, and Sportmonks answers 404 rather
than omitting it — so the fallback never ran and the commit that reverted it
calls it "precisely the mistake this project keeps paying for."

So: ask, print exactly what comes back, and decide afterwards. Each endpoint is
tried independently, because a 404 on one says nothing about the others.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import httpx

BASE = "https://api.sportmonks.com/v3/football"

# Ordered cheapest-to-most-useful. The last one is what a feed would need.
CANDIDATES: list[tuple[str, str, dict[str, str]]] = [
    ("latest transfers", "/transfers/latest", {}),
    ("all transfers, page 1", "/transfers", {}),
    (
        "transfers between dates",
        "/transfers/between/2026-08-01/2026-09-30",
        {},
    ),
]


def show(name: str, response: httpx.Response) -> None:
    print(f"\n{name}")
    print(f"  {response.request.url}")
    print(f"  HTTP {response.status_code}")

    if response.status_code != 200:
        # The body is where Sportmonks explains a plan restriction, and it is
        # the difference between "wrong path" and "not included in your
        # subscription" — which is the actual question.
        print(f"  {response.text[:400]}")
        return

    payload = response.json()
    data = payload.get("data")

    if isinstance(data, list):
        print(f"  {len(data)} row(s)")
        if data:
            print("  first row:")
            print("   ", json.dumps(data[0], default=str)[:600])
    else:
        print("  ", json.dumps(payload, default=str)[:600])

    # Rate and subscription details ride along on every v3 response and say what
    # the plan actually covers.
    for key in ("subscription", "rate_limit"):
        if key in payload:
            print(f"  {key}: {json.dumps(payload[key], default=str)[:300]}")


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    print("Asking Sportmonks what it will give us about transfers.")
    print("Nothing is written. A 404 or 403 here is an answer, not a failure.")

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        for name, path, params in CANDIDATES:
            try:
                show(name, client.get(f"{BASE}{path}", params=params))
            except httpx.HTTPError as error:
                print(f"\n{name}\n  request failed: {error}")

    print(
        "\nIf any of those returned rows, send me the first row and I'll tell you "
        "whether it's worth ingesting over what we already derive."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
