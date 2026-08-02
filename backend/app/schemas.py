"""Pydantic v2 request/response models. Field names mirror docs/API.md exactly."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Role = Literal["admin", "member"]
ColumnType = Literal[
    "text", "number", "date", "dropdown", "status", "member", "lookup", "formula"
]
#: 値を自動計算する列（参照(LOOKUP)／数式）。手入力できず、Excel の取り込み・書き出し
#: の対象外。解決はフロント側で行う。
COMPUTED_COLUMN_TYPES = ("lookup", "formula")


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


class OrgSignup(BaseModel):
    """Public self-service org creation: makes a new group + its first admin."""
    org_name: str
    admin_name: str
    admin_email: str
    admin_password: str


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
    # Whether this user files a daily 日報 (drives 未入力 reminders).
    worklog_required: bool = True
    # Whether the account is active. Frozen (凍結) accounts cannot log in.
    is_active: bool = True


class MemberCreate(BaseModel):
    name: str
    email: str
    password: str
    role: Role = "member"
    worklog_required: bool = True


class MemberUpdate(BaseModel):
    name: Optional[str] = None
    role: Optional[Role] = None
    password: Optional[str] = None
    worklog_required: Optional[bool] = None
    is_active: Optional[bool] = None


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
    #: マスタシート（一覧に出さない参照用）。
    is_master: bool = False
    key_column_id: Optional[int] = None
    color_basis_column_id: Optional[int] = None
    settings: dict[str, Any] = Field(default_factory=dict)


class SheetCreate(BaseModel):
    name: str
    has_week_grid: bool = True
    is_master: bool = False


class SheetUpdate(BaseModel):
    name: Optional[str] = None
    has_week_grid: Optional[bool] = None
    is_master: Optional[bool] = None
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


class EffortBulkItem(BaseModel):
    """One cell in a bulk write (range paste / range clear / undo of either)."""

    row_id: int
    week_start: date
    planned_hours: Optional[float] = None
    actual_hours: Optional[float] = None


class EffortBulkRequest(BaseModel):
    items: list[EffortBulkItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Change history (変更履歴)
# ---------------------------------------------------------------------------
class RowEventOut(BaseModel):
    id: int
    row_id: Optional[int] = None
    row_key: Optional[str] = None
    # Resolved display name of who made the change ("(削除済み)" when the account
    # is gone).
    user_name: str
    kind: Literal["create", "update", "delete", "effort"]
    field_label: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: datetime


# ---------------------------------------------------------------------------
# Milestones
# ---------------------------------------------------------------------------
class MilestoneOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    row_id: int
    name: str
    kind: Literal["phase", "milestone"] = "phase"
    boundary_date: date
    color: Optional[str] = None
    order: int
    done: bool = False
    actual_date: Optional[date] = None


class MilestoneIn(BaseModel):
    name: str
    kind: Literal["phase", "milestone"] = "phase"
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
    # Week the returned data actually represents (nearest recorded snapshot <=
    # requested; oldest record when the request predates all snapshots). None when
    # no snapshot exists at all (brand-new sheet → live state).
    as_of_week: Optional[str] = None
    # True when as_of_week == the requested week (an exact record for that week).
    exact: bool = False


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
    # Display text for the linked task, built from the sheet's configured columns
    # (settings.worklog_task_columns). Falls back to ID＋件名.
    row_label: Optional[str] = None
    sheet_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    cat3: Optional[str] = None
    memo: Optional[str] = None
    hours: float


class WorkLogCreate(BaseModel):
    work_date: date
    row_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    cat3: Optional[str] = None
    memo: Optional[str] = None
    hours: float


class WorkLogUpdate(BaseModel):
    work_date: Optional[date] = None
    row_id: Optional[int] = None
    cat1: Optional[str] = None
    cat2: Optional[str] = None
    cat3: Optional[str] = None
    memo: Optional[str] = None
    hours: Optional[float] = None


class TaskOption(BaseModel):
    """A task (row) the current user is assigned to — for the 実績入力 picker."""
    row_id: int
    key_value: Optional[str] = None
    title: str
    # Display text from the sheet's configured columns (ID＋件名 by default).
    label: str = ""
    sheet_id: int
    sheet_name: str


class UserDayWorkLog(BaseModel):
    """One member's work logs for a day (みんなの入力一覧)."""
    user_id: int
    user_name: str
    total_hours: float
    logs: list[WorkLogOut]


# ---------------------------------------------------------------------------
# Notifications (アプリ内通知・ベル)
# ---------------------------------------------------------------------------
NotificationType = Literal["behind", "dep", "overrun", "milestone", "worklog_missing"]


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: NotificationType
    title: str
    body: Optional[str] = None
    ref_kind: Optional[str] = None
    ref_id: Optional[str] = None
    created_at: datetime
    read_at: Optional[datetime] = None


class NotificationItem(BaseModel):
    """One alert the front end detected while rendering the schedule. Addressed to
    `target_user_id` (the task assignee). `dedupe_key` makes it idempotent."""
    target_user_id: int
    type: NotificationType
    title: str
    body: Optional[str] = None
    ref_kind: Optional[str] = None
    ref_id: Optional[str] = None
    dedupe_key: str


class NotificationRegister(BaseModel):
    items: list[NotificationItem] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Cross-sheet search
# ---------------------------------------------------------------------------
class SearchHit(BaseModel):
    row_id: int
    sheet_id: int
    sheet_name: str
    key_value: Optional[str] = None
    title: str = ""
    # Column name whose value matched; None when the ID or title matched.
    matched_field: Optional[str] = None


# ---------------------------------------------------------------------------
# Excel 取り込み設定（プリセット）
# ---------------------------------------------------------------------------
class ImportPresetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    worksheet_name: str
    workbook_name: str
    # None = 取り込み時に新しいシートを作る（名前は target_sheet_name）。
    target_sheet_id: Optional[int] = None
    target_sheet_name: str
    has_week_grid: bool
    header_row: int
    # 1-based, inclusive; 0 = 最後まで（末尾の合計行・注記を切り落とす指定）。
    last_row: int
    id_column: int
    mapping: list[Any] = Field(default_factory=list)
    updated_at: datetime
    last_used_at: Optional[datetime] = None


class ImportPresetSave(BaseModel):
    """Upsert a 取り込み設定. Keyed by `worksheet_name` within the org, so finishing
    the wizard on the same worksheet again refreshes the setting instead of adding
    a near-duplicate."""

    worksheet_name: str
    name: str = ""
    workbook_name: str = ""
    target_sheet_id: Optional[int] = None
    target_sheet_name: str = ""
    has_week_grid: bool = True
    header_row: int = 0
    last_row: int = 0
    id_column: int = 0
    mapping: list[Any] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# バックアップ / リストア
# ---------------------------------------------------------------------------
class BackupOut(BaseModel):
    """List/detail shape. The payload itself is never returned here — it is the
    whole group and can be many MB; use the download endpoint for it."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    label: str
    format_version: int
    # Row counts per table (sheets / rows / work_logs / members …).
    summary: dict[str, Any] = Field(default_factory=dict)
    size_bytes: int
    created_at: datetime
    created_by_name: str


class BackupCreate(BaseModel):
    label: str = ""


class MarkReadRequest(BaseModel):
    # When omitted/empty, marks ALL of the caller's notifications read.
    ids: Optional[list[int]] = None


SheetDetailOut.model_rebuild()
