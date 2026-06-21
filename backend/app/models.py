"""SQLAlchemy ORM models (SPEC §3)."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    settings: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=lambda: {"week_start_weekday": 1}
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    users: Mapped[list["User"]] = relationship(back_populates="org", cascade="all, delete-orphan")
    sheets: Mapped[list["Sheet"]] = relationship(back_populates="org", cascade="all, delete-orphan")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member")  # 'admin' | 'member'
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    org: Mapped["Organization"] = relationship(back_populates="users")


class Sheet(Base):
    __tablename__ = "sheets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    order: Mapped[int] = mapped_column("order", Integer, nullable=False, default=0)
    has_week_grid: Mapped[bool] = mapped_column(default=True, nullable=False)
    # Nullable FKs to columns. Defined without DB-level FK to avoid create_all ordering issues
    # (columns table references sheets); validated at the application layer.
    key_column_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    color_basis_column_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    numbering_rule: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=lambda: {"prefix": "", "digits": 3, "next_seq": 1}
    )
    # Sheet-level UI settings (JSONB):
    #   pinned_columns:      how many leading attribute columns stay frozen left
    #   default_milestones:  [{name, color}] — defaults for a row's phases
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    org: Mapped["Organization"] = relationship(back_populates="sheets")
    columns: Mapped[list["Column"]] = relationship(
        back_populates="sheet",
        cascade="all, delete-orphan",
        order_by="Column.order",
    )
    rows: Mapped[list["Row"]] = relationship(
        back_populates="sheet", cascade="all, delete-orphan"
    )
    snapshots: Mapped[list["SheetSnapshot"]] = relationship(
        back_populates="sheet", cascade="all, delete-orphan"
    )


class Column(Base):
    __tablename__ = "columns"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("sheets.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    order: Mapped[int] = mapped_column("order", Integer, nullable=False, default=0)
    type: Mapped[str] = mapped_column(String(32), nullable=False)  # text|number|date|dropdown|status|member|lookup
    is_key: Mapped[bool] = mapped_column(default=False, nullable=False)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    sheet: Mapped["Sheet"] = relationship(back_populates="columns")


class Row(Base):
    __tablename__ = "rows"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("sheets.id", ondelete="CASCADE"), nullable=False)
    # Parent task for a subtask (子タスク). Null = top-level task. One level only:
    # a subtask never has its own children. Deleting a parent cascades to children
    # (and their effort/milestones) at the DB level.
    parent_row_id: Mapped[int | None] = mapped_column(
        ForeignKey("rows.id", ondelete="CASCADE"), nullable=True, index=True
    )
    key_value: Mapped[str | None] = mapped_column(String(255), nullable=True)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Manual progress 0-100 (手入力の進捗%). Null = not set. A parent with
    # children shows an effort-weighted roll-up instead (computed on the front end).
    progress: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Predecessor task ids (先行タスク). The task should start only after these
    # finish; the front end flags 逆ザヤ (starting before a predecessor ends).
    depends_on: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    updated_by: Mapped[int | None] = mapped_column(Integer, nullable=True)

    sheet: Mapped["Sheet"] = relationship(back_populates="rows")
    effort_entries: Mapped[list["EffortEntry"]] = relationship(
        back_populates="row", cascade="all, delete-orphan"
    )
    milestones: Mapped[list["RowMilestone"]] = relationship(
        back_populates="row", cascade="all, delete-orphan", order_by="RowMilestone.order"
    )

    # NOTE: key_value is intentionally NOT unique within a sheet — the same ID
    # may be reused for repeated work (e.g. recurring development). Lookups then
    # resolve to the first matching row (SPEC: 先頭一致).


class EffortEntry(Base):
    __tablename__ = "effort_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    row_id: Mapped[int] = mapped_column(ForeignKey("rows.id", ondelete="CASCADE"), nullable=False)
    week_start: Mapped[date] = mapped_column(Date, nullable=False)
    planned_hours: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    actual_hours: Mapped[float | None] = mapped_column(Numeric(8, 2), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    updated_by: Mapped[int | None] = mapped_column(Integer, nullable=True)

    row: Mapped["Row"] = relationship(back_populates="effort_entries")

    __table_args__ = (
        UniqueConstraint("row_id", "week_start", name="uq_effort_row_week"),
    )


class RowMilestone(Base):
    __tablename__ = "row_milestones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    row_id: Mapped[int] = mapped_column(ForeignKey("rows.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    boundary_date: Mapped[date] = mapped_column(Date, nullable=False)
    color: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order: Mapped[int] = mapped_column("order", Integer, nullable=False, default=0)
    # Achievement flag: whether this milestone (phase boundary) has been reached.
    done: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Actual completion date (実績完了日). Set when achieved; compared with
    # boundary_date (planned) to show 遅延日数. Null until done.
    actual_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    row: Mapped["Row"] = relationship(back_populates="milestones")


class SheetSnapshot(Base):
    __tablename__ = "sheet_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sheet_id: Mapped[int] = mapped_column(ForeignKey("sheets.id", ondelete="CASCADE"), nullable=False)
    for_week: Mapped[date] = mapped_column(Date, nullable=False)
    state: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    sheet: Mapped["Sheet"] = relationship(back_populates="snapshots")

    __table_args__ = (
        UniqueConstraint("sheet_id", "for_week", name="uq_snapshot_sheet_week"),
    )


class WorkLog(Base):
    """One work-log line (実績入力). Hours roll up into the weekly EffortEntry
    actual_hours for the linked task (row) — see app.worklog_service.

    Categories (cat1=大分類, cat2=中分類) are stored as plain strings (snapshots of
    the org master at entry time) so renaming/reordering the master never orphans
    historical logs. row_id is SET NULL on task delete to preserve the record.
    """

    __tablename__ = "work_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    work_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Linked task. Nullable + SET NULL: deleting a task keeps the historical log.
    row_id: Mapped[int | None] = mapped_column(
        ForeignKey("rows.id", ondelete="SET NULL"), nullable=True
    )
    cat1: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 大分類
    cat2: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 中分類
    memo: Mapped[str | None] = mapped_column(Text, nullable=True)
    hours: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_worklog_row_date", "row_id", "work_date"),
        Index("ix_worklog_org_user_date", "org_id", "user_id", "work_date"),
    )
