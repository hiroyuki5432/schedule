"""Authentication endpoints (Cookie session)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.schemas import LoginRequest, UserOut
from app.security import current_user, get_user_by_email, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


class UserEnvelope(BaseModel):
    """Contract (docs/API.md): auth responses wrap the user as {"user": {...}}."""

    user: UserOut


@router.post("/login", response_model=UserEnvelope)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    user = get_user_by_email(db, payload.email)
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    request.session["user_id"] = user.id
    return {"user": user}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserEnvelope)
def me(user: User = Depends(current_user)) -> dict:
    return {"user": user}
