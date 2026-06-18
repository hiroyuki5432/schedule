"""Organization endpoint."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Organization, User
from app.schemas import OrgOut
from app.security import current_user

router = APIRouter(prefix="/api/org", tags=["org"])


@router.get("", response_model=OrgOut)
def get_org(user: User = Depends(current_user), db: Session = Depends(get_db)) -> Organization:
    org = db.get(Organization, user.org_id)
    if org is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Organization not found")
    return org
