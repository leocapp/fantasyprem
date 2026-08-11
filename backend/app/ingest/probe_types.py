"""Find the statistic type ids that didn't appear in a single sampled match.

    export SPORTMONKS_TOKEN=your_token
    python -m app.ingest.probe_types

Assists, red cards, own goals and saved penalties all have type ids, but a
given match may contain none of them. This pages through the core types
dictionary and prints everything that looks relevant to fantasy scoring.
"""

from __future__ import annotations

import os
import sys
from typing import Any

import httpx

CORE = "https://api.sportmonks.com/v3/core"

# Anything whose name contains one of these is worth seeing.
KEYWORDS = (
    "assist",
    "red",
    "own goal",
    "penalt",
    "clean",
    "goal",
    "card",
    "save",
    "minute",
    "substitut",
    "rating",
)


def main() -> int:
    token = os.environ.get("SPORTMONKS_TOKEN")
    if not token:
        print("export SPORTMONKS_TOKEN=your_token", file=sys.stderr)
        return 1

    matches: list[dict[str, Any]] = []
    page = 1

    with httpx.Client(timeout=45.0, params={"api_token": token}) as client:
        while True:
            response = client.get(f"{CORE}/types", params={"page": page, "per_page": 100})
            if response.is_error:
                print(f"page {page}: {response.status_code}", file=sys.stderr)
                break

            payload = response.json()
            rows = payload.get("data") or []

            for row in rows:
                name = str(row.get("name") or "").lower()
                if any(keyword in name for keyword in KEYWORDS):
                    matches.append(row)

            pagination = payload.get("pagination") or {}
            if not pagination.get("has_more"):
                break

            page += 1
            if page > 40:  # safety valve
                break

    print(f"Scanned {page} pages\n")
    print(f"{'id':>7}  {'name':<36} {'code':<32} model_type")
    for row in sorted(matches, key=lambda r: str(r.get("model_type"))):
        print(
            f"{row.get('id'):>7}  {str(row.get('name')):<36} "
            f"{str(row.get('code')):<32} {row.get('model_type')}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
