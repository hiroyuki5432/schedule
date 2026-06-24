"""Organization endpoint."""
from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Organization, User
from app.schemas import OrgOut, OrgSignup, OrgUpdate
from app.security import current_user, get_user_by_email, hash_password, require_admin

router = APIRouter(prefix="/api/org", tags=["org"])


def _unique_slug(db: Session, org_name: str) -> str:
    """Derive a URL-safe, unique slug from the group name (falling back to a
    random token when the name has no usable ASCII, e.g. Japanese-only names)."""
    base = re.sub(r"[^a-z0-9]+", "-", org_name.lower()).strip("-")
    if not base:
        base = "group"
    base = base[:40]
    slug = base
    while db.execute(select(Organization).where(Organization.slug == slug)).scalar_one_or_none():
        slug = f"{base}-{uuid.uuid4().hex[:6]}"
    return slug


@router.post("/signup", response_model=OrgOut, status_code=status.HTTP_201_CREATED)
def signup_org(payload: OrgSignup, request: Request, db: Session = Depends(get_db)) -> Organization:
    """Public self-service: create a new group with its first admin, then log them
    in. The new group starts with one empty schedule sheet so it is usable at once."""
    from app.seed import create_starter_sheet  # local import avoids a cycle

    if not payload.org_name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="グループ名を入力してください")
    if not payload.admin_email.strip() or not payload.admin_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="管理者のIDとパスワードを入力してください")
    if get_user_by_email(db, payload.admin_email) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="このIDは既に使われています")

    org = Organization(
        name=payload.org_name.strip(),
        slug=_unique_slug(db, payload.org_name),
        settings={"week_start_weekday": 1},
    )
    db.add(org)
    db.flush()

    admin = User(
        org_id=org.id,
        email=payload.admin_email.strip(),
        name=payload.admin_name.strip() or payload.admin_email.strip(),
        role="admin",
        password_hash=hash_password(payload.admin_password),
    )
    db.add(admin)
    db.flush()

    create_starter_sheet(db, org.id, created_by=admin.id)

    db.commit()
    db.refresh(org)
    # Log the new admin in immediately.
    request.session["user_id"] = admin.id
    return org


@router.get("", response_model=OrgOut)
def get_org(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Organization:
    org = db.get(Organization, user.org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    return org


@router.patch("", response_model=OrgOut)
def update_org(
    payload: OrgUpdate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Organization:
    """Admin-only. `settings` is shallow-merged into existing top-level keys
    (e.g. set `worklog` masters without clobbering `week_start_weekday`)."""
    org = db.get(Organization, user.org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    if payload.name is not None:
        org.name = payload.name
    if payload.settings is not None:
        org.settings = {**(org.settings or {}), **payload.settings}
    db.commit()
    db.refresh(org)
    return org
