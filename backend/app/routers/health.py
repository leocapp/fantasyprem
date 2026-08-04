"""Liveness / readiness endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.config import Settings, get_settings

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    environment: str
    supabase_configured: bool


class RootResponse(BaseModel):
    service: str
    docs: str
    health: str


@router.get("/", response_model=RootResponse)
async def root(settings: Annotated[Settings, Depends(get_settings)]) -> RootResponse:
    """Signpost for anyone hitting the API root in a browser."""
    return RootResponse(service=settings.app_name, docs="/docs", health="/health")


@router.get("/health", response_model=HealthResponse)
async def health(settings: Annotated[Settings, Depends(get_settings)]) -> HealthResponse:
    return HealthResponse(
        status="ok",
        environment=settings.environment,
        supabase_configured=settings.is_supabase_configured,
    )
