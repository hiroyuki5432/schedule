"""Organization endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Organization, User
from app.schemas import OrgOut, OrgUpdate
from app.security import current_user, require_admin

router = APIRouter(prefix="/api/org", tags=["org"])


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
