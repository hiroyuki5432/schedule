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
    # Whether this user is expected to file a daily work-log (日報). When false
    # (e.g. admins, 外注), they never receive 未入力 reminders. Default true.
    worklog_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Whether the account is active. Frozen accounts (凍結) keep all their data and
    # history but cannot log in and are excluded from new assignments/notifications.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
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
    # Week (week_start) the current progress applies to. With weekly-reset on, the
    # progress shows only for its own week, so it clears at the start of a new week
    # but is still visible when stepping back to that week (as-of).
    progress_week: Mapped[date | None] = mapped_column(Date, nullable=True)
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
    # 'phase' (色付き区間の開始境界) | 'milestone' (フェーズ間の◇点). Phases define
    # the colored gantt segment; milestones draw a diamond marker only.
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="phase")
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

    Categories (cat1/cat2/cat3 — 既定で 大分類/中分類、3段目は任意) are stored as plain
    strings (snapshots of the org master at entry time) so renaming/reordering the
    master never orphans historical logs. row_id is SET NULL on task delete to
    preserve the record.
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
    # Category levels. How many are actually used (and what they are called) is an
    # org setting: settings.worklog.category_levels (既定は 大分類→中分類の2段).
    cat1: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 大分類
    cat2: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 中分類
    cat3: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 小分類
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


class RowEvent(Base):
    """One recorded change to a task (変更履歴 / 変化点).

    Written synchronously by the row and effort endpoints. Unlike the weekly
    snapshot diff (which can only tell you "something changed between these two
    weeks"), this keeps the exact who/when/what for every edit.

    Labels are snapshots taken at write time (`field_label` holds the column name
    as it was then), so renaming or deleting a column never makes old history
    unreadable. `row_id` is SET NULL on task delete while `row_key` keeps the id
    the task had, so the deletion itself stays in the log.
    """

    __tablename__ = "row_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    sheet_id: Mapped[int] = mapped_column(
        ForeignKey("sheets.id", ondelete="CASCADE"), nullable=False
    )
    row_id: Mapped[int | None] = mapped_column(
        ForeignKey("rows.id", ondelete="SET NULL"), nullable=True
    )
    # key_value at the time of the change (survives the row being deleted).
    row_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # 'create' | 'update' | 'delete' | 'effort'
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # Human-readable name of what changed (column name / 工数 2026-06-15 / ID …).
    field_label: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    old_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        Index("ix_rowevent_row_at", "row_id", "created_at"),
        Index("ix_rowevent_sheet_at", "sheet_id", "created_at"),
    )


class ImportPreset(Base):
    """A saved Excel 取り込み設定 (要望: 一度決めた設定を記憶して一括で取り込みたい).

    Written automatically whenever an import wizard finishes, keyed by the SOURCE
    worksheet's name — so setting a sheet up carefully the first time *is* the
    setup. The 一括取り込み screen then matches every worksheet of a dropped
    workbook against these presets and can re-run the whole book in one action,
    which is what makes the second, third… data load cheap.

    `target_sheet_id` NULL means "create a new sheet named `target_sheet_name`".
    It is SET NULL on sheet delete, so a preset for a deleted sheet degrades into
    "make a new one" instead of disappearing.

    Org-scoped on purpose: whoever set the import up, everyone can re-run it.
    """

    __tablename__ = "import_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    # Display name (既定はワークシート名).
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The Excel worksheet this setting belongs to — the 一括取り込み matching key.
    worksheet_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # File name it was last saved from. Display only — renaming the file must not
    # break the match, so it is deliberately NOT part of the key.
    workbook_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    target_sheet_id: Mapped[int | None] = mapped_column(
        ForeignKey("sheets.id", ondelete="SET NULL"), nullable=True
    )
    # Name to give the sheet when target_sheet_id is NULL (新規作成).
    target_sheet_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    has_week_grid: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # 1-based 見出し行 (0 = 自動判定), 0-based ID列 (-1 = 自動採番).
    header_row: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    id_column: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Last worksheet row to take, 1-based inclusive (0 = 最後まで). Sheets routinely
    # end in a 合計行 or notes that must not become tasks, and where that line falls
    # is a property of the source sheet — so it is remembered with everything else.
    last_row: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # [{index, name, type}] — the same JSON the wizards post as `columns`.
    mapping: Mapped[list] = mapped_column("mapping", JSONB, nullable=False, default=list)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # One setting per source worksheet: re-running the wizard on the same
        # worksheet updates it rather than piling up near-duplicates.
        UniqueConstraint("org_id", "worksheet_name", name="uq_import_preset_org_ws"),
    )


class Backup(Base):
    """A full point-in-time snapshot of one group's data (バックアップ / リストア).

    `payload` holds every org-scoped table verbatim — **including primary keys**.
    Restoring re-inserts those original ids rather than allocating new ones,
    because ids are referenced from inside JSONB all over the app (`row.data` is
    keyed by column id; lookup columns point at a sheet/column id; a sheet's
    `worklog_task_columns` and status rules hold column ids). Re-numbering would
    mean rewriting every one of those by hand, and anything missed would corrupt
    a setting silently. Keeping the ids makes the restore exact.

    This table is deliberately NOT part of the payload: a restore must not wipe
    the very list of backups you would need to undo it.
    """

    __tablename__ = "backups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # Payload layout version — a restore refuses a version it does not understand
    # rather than half-applying it.
    format_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Row counts per table, so the list can describe a backup without loading the
    # (potentially large) payload.
    summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Display name of who took it, snapshotted so it survives that account going.
    created_by_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")

    __table_args__ = (Index("ix_backup_org_at", "org_id", "created_at"),)


class Notification(Base):
    """An in-app notification (ベル). Created lazily on access — no cron:

    - behind / dep(逆ザヤ) / overrun / milestone超過 are registered by the front
      end when it detects the condition while rendering the schedule, addressed to
      the task's assignee.
    - worklog_missing is generated server-side when the recipient opens the app
      (GET /api/notifications) for past business days they have no 日報.

    `dedupe_key` (unique per user) makes every condition-occurrence idempotent, so
    re-detection on each page view never creates duplicates.
    """

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    org_id: Mapped[int] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    ref_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 'row' | 'worklog_day'
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    dedupe_key: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("user_id", "dedupe_key", name="uq_notif_user_dedupe"),
        Index("ix_notif_user_unread", "user_id", "read_at", "created_at"),
    )
