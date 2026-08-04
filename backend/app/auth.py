"""Supabase JWT verification.

Two verification modes, picked automatically:

* SUPABASE_JWT_SECRET set  -> legacy shared-secret (HS256) verification.
* SUPABASE_URL set         -> asymmetric verification against the project's
                              JWKS endpoint (current Supabase default).
"""

from functools import lru_cache
from typing import Annotated, Any

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.config import Settings, get_settings

bearer_scheme = HTTPBearer(auto_error=False)


class CurrentUser(BaseModel):
    """The authenticated Supabase user, as described by the access token."""

    id: str
    email: str | None = None
    role: str | None = None
    claims: dict[str, Any]


@lru_cache
def _jwk_client(jwks_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(jwks_url, cache_keys=True)


def _decode(token: str, settings: Settings) -> dict[str, Any]:
    options = {"verify_aud": False}

    if settings.supabase_jwt_secret:
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            options=options,
        )

    if not settings.supabase_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth is not configured: set SUPABASE_URL or SUPABASE_JWT_SECRET.",
        )

    jwks_url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
    signing_key = _jwk_client(jwks_url).get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["ES256", "RS256"],
        options=options,
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CurrentUser:
    """FastAPI dependency: require a valid Supabase access token."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        claims = _decode(credentials.credentials, settings)
    except HTTPException:
        raise
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    subject = claims.get("sub")
    if not subject:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is missing a subject claim.",
        )

    return CurrentUser(
        id=subject,
        email=claims.get("email"),
        role=claims.get("role"),
        claims=claims,
    )


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]
