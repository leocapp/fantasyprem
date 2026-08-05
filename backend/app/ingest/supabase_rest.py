"""Minimal PostgREST client for ingestion jobs.

Uses the service role key, which bypasses Row Level Security. This module must
never be imported by request-handling code.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any

import httpx

CHUNK_SIZE = 500


def _chunks(rows: Sequence[dict[str, Any]], size: int) -> Iterator[Sequence[dict[str, Any]]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


class SupabaseRest:
    def __init__(self, url: str, service_role_key: str, timeout: float = 60.0) -> None:
        self._client = httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
            },
            timeout=timeout,
        )

    def __enter__(self) -> SupabaseRest:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    def select(self, table: str, **params: str) -> list[dict[str, Any]]:
        response = self._client.get(f"/{table}", params=params)
        response.raise_for_status()
        return response.json()

    def upsert(self, table: str, rows: Sequence[dict[str, Any]], on_conflict: str) -> int:
        """Insert rows, updating any that collide on `on_conflict`."""
        if not rows:
            return 0

        for chunk in _chunks(rows, CHUNK_SIZE):
            response = self._client.post(
                f"/{table}",
                params={"on_conflict": on_conflict},
                json=list(chunk),
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            )
            if response.is_error:
                # PostgREST puts the useful diagnostics in the body.
                raise RuntimeError(f"{table} upsert failed ({response.status_code}): {response.text}")

        return len(rows)
