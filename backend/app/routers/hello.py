"""Placeholder endpoints used to confirm the stack is wired up."""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth import CurrentUserDep
from app.config import Settings, get_settings

router = APIRouter(prefix="/api", tags=["hello"])


class HelloResponse(BaseModel):
    message: str
    service: str
    environment: str


class MeResponse(BaseModel):
    id: str
    email: str | None
    role: str | None


@router.get("/hello", response_model=HelloResponse)
async def hello(settings: Annotated[Settings, Depends(get_settings)]) -> HelloResponse:
    return HelloResponse(
        message="Hello from the FantasyPrem API",
        service=settings.app_name,
        environment=settings.environment,
    )


@router.get("/me", response_model=MeResponse)
async def me(user: CurrentUserDep) -> MeResponse:
    """Example protected route — requires a valid Supabase access token."""
    return MeResponse(id=user.id, email=user.email, role=user.role)
