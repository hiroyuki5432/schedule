"""Member (user) management. List is open to any member; mutations are admin-only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.schemas import MemberCreate, MemberOut, MemberUpdate
from app.security import current_user, get_user_by_email, hash_password, require_admin

router = APIRouter(prefix="/api/members", tags=["members"])


@router.get("", response_model=list[MemberOut])
def list_members(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[User]:
    return list(
        db.execute(
            select(User).where(User.org_id == user.org_id).order_by(User.id)
        ).scalars()
    )


@router.post("", response_model=MemberOut, status_code=status.HTTP_201_CREATED)
def create_member(
    payload: MemberCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    if get_user_by_email(db, payload.email) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
    member = User(
        org_id=admin.org_id,
        email=payload.email,
        name=payload.name,
        role=payload.role,
        password_hash=hash_password(payload.password),
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def _get_member_in_org(db: Session, member_id: int, org_id: int) -> User:
    member = db.get(User, member_id)
    if member is None or member.org_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    return member


@router.patch("/{member_id}", response_model=MemberOut)
def update_member(
    member_id: int,
    payload: MemberUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    member = _get_member_in_org(db, member_id, admin.org_id)
    if payload.name is not None:
        member.name = payload.name
    if payload.role is not None:
        member.role = payload.role
    if payload.password is not None:
        member.password_hash = hash_password(payload.password)
    db.commit()
    db.refresh(member)
    return member


@router.delete("/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_member(
    member_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    member = _get_member_in_org(db, member_id, admin.org_id)
    if member.id == admin.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete yourself")
    db.delete(member)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
