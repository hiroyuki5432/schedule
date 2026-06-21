"""Pydantic v2 request/response models. Field names mirror docs/API.md exactly."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["admin", "member"]
ColumnType = Literal["text", "number", "date", "dropdown", "status", "member", "lookup"]


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: Role
    org_id: int


# ---------------------------------------------------------------------------
# Organization
# ---------------------------------------------------------------------------
class OrgOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    settings: dict[str, Any]


class OrgUpdate(BaseModel):
    name: Optional[str] = None
    # Shallow-merged into the existing settings (top-level keys), so updating
    # `worklog` masters never clobbers `week_start_weekday`.
    settings: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------
class MemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    email: str
    role: Role


class MemberCreate(BaseModel):
    name: str
    email: str
    password: str
    role: Role = "member"


class MemberUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[Role] = None
    password: Optional[str] = None


# ---------------------------------------------------------------------------
# Columns
# ---------------------------------------------------------------------------
class ColumnOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sheet_id: int
    name: str
    type: ColumnType
    order: int
    is_key: bool
    config: dict[str, Any]


class ColumnCreate(BaseModel):
    name: str
    type: ColumnType
    config: dict[str, Any] = Field(default_factory=dict)
    order: Optional[int] = None
    is_key: Optional[bool] = None


class ColumnUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[ColumnType] = None
    config: Optional[dict[str, Any]] = None
    order: Optional[int] = None
    is_key: Optional[bool] = None


# ---------------------------------------------------------------------------
# Sheets
# ---------------------------------------------------------------------------
class SheetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    order: int
    has_week_grid: bool
    key_column_id: Optional[int] = None
    color_basis_column_id: Optional[int] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class SheetCreate(BaseModel):
    name: str
    has_week_grid: bool = True


class SheetUpdate(BaseModel):
    name: Optional[str] = None
    has_week_grid: Optional[bool] = None
    key_column_id: Optional[int] = None
    color_basis_column_id: Optional[int] = None
    order: Optional[int] = None
    settings: Optional[dict[str, Any]] = None


class SheetDetailOut(BaseModel):
    sheet: SheetOut
    columns: list[ColumnOut]
    rows: list["RowOut"]


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------
class RowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sheet_id: int
    # Parent task id for a subtask (子タスク); null for top-level tasks.
    parent_row_id: Optional[int] = None
    key_value: Optional[str] = None
    data: dict[str, Any]
    version: int
    # Manual progress 0-100 (手入力進捗%); null if unset.
    progress: Optional[int] = None
    # Week (week_start) the current progress applies to.
    progress_week: Optional[date] = None
    # Predecessor task ids (先行タスク).
    depends_on: list[int] = Field(default_factory=list)


class RowCreate(BaseModel):
    key_value: Optional[str] = None
    data: dict[str, Any] = Field(default_factory=dict)


class RowUpdate(BaseModel):
    data: dict[str, Any]
    version: int
    key_value: Optional[str] = None
    # Optional: only applied when present in the request body.
    progress: Optional[int] = None
    depends_on: Optional[list[int]] = None


# ---------------------------------------------------------------------------
# Effort
# ---------------------------------------------------------------------------
class EffortOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    row_id: int
    week_start: date
    planned_hours: Optional[float] = None
    actual_hours: Optional[float] = None
    version: int


class EffortUpsert(BaseModel):
    planned_hours: Optional[float] = None
    actual_hours: Optional[float] = None
    version: Optional[int] = None


# ---------------------------------------------------------------------------
# Milestones
# ---------------------------------------------------------------------------
class MilestoneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    row_id: int
    name: str
    boundary_date: date
    color: Optional[str] = None
    order: int
    done: bool = False
    actual_date: Optional[date] = None


class MilestoneIn(BaseModel):
    name: str
    boundary_date: date
    color: Optional[str] = None
    order: int = 0
    done: bool = False
    actual_date: Optional[date] = None


# ---------------------------------------------------------------------------
# Snapshot / changes
# ---------------------------------------------------------------------------
class SnapshotOut(BaseModel):
    rows: list[dict[str, Any]]
    effort: list[dict[str, Any]]


class ChangeOut(BaseModel):
    row_id: Optional[int] = None
    field: str
    old: Any = None
    new: Any = None


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------
class AggregateRow(BaseModel):
    group: Any
    planned_sum: float
    actual_sum: float
    count: int


# ---------------------------------------------------------------------------
# Work logs (日報)
# ---------------------------------------------------------------------------
class WorkLogOut(BaseModel):
    id: int
    user_id: Optional[int] = None
    work_date: date
    row_id: Optional[int] = None
    # Resolved for display (the linked task); null if unlinked or deleted.
    row_key_value: Optional[str] = None
    sheet_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    memo: Optional[str] = None
    hours: float


class WorkLogCreate(BaseModel):
    work_date: date
    row_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    memo: Optional[str] = None
    hours: float


class WorkLogUpdate(BaseModel):
    work_date: Optional[date] = None
    row_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    memo: Optional[str] = None
    hours: Optional[float] = None


class TaskOption(BaseModel):
    """A task (row) the current user is assigned to — for the 実績入力 picker."""
    row_id: int
    key_value: Optional[str] = None
    title: str
    sheet_id: int
    sheet_name: str


class UserDayWorkLog(BaseModel):
    """One member's work logs for a day (みんなの入力一覧)."""
    user_id: int
    user_name: str
    total_hours: float
    logs: list[WorkLogOut]


SheetDetailOut.model_rebuild()
