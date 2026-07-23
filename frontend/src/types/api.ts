// API entity types — mirror docs/API.md exactly.

export type Role = 'admin' | 'member'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  org_id: string
}

/** A node in the 実績入力 category master (大分類→中分類). */
export interface WorkLogCategoryNode {
  name: string
  children?: WorkLogCategoryNode[]
}

/** Org-level 実績入力 master: 2-level cascading categories (大→中) + a shared note. */
export interface WorkLogMaster {
  categories?: WorkLogCategoryNode[]
  /** Free-text 記載ルール shown at the bottom of 実績入力 for everyone. */
  note?: string
}

export interface OrgSettings {
  week_start_weekday?: number // 1..7, default 1 (Mon)
  /** Daily work-log masters (categories + properties). */
  worklog?: WorkLogMaster
  /** Per-group app title shown in the sidebar/login (defaults to 工数スケジュール). */
  app_title?: string
  /** Monthly close (締め日): aggregate months by 「月末の N 稼働日前締め」. When unset,
   *  totals use plain calendar months. `holidays` are extra org-specific 休日. */
  closing?: { offset_business_days?: number; holidays?: string[] }
  [k: string]: unknown
}

export interface Org {
  id: string
  name: string
  slug: string
  settings: OrgSettings
}

export interface Member {
  id: string
  name: string
  email: string
  role: Role
  /** Whether this user files a daily 日報 (drives 未入力 reminders). */
  worklog_required: boolean
  /** Whether the account is active. Frozen (凍結) accounts cannot log in. */
  is_active: boolean
}

/** A default phase/milestone preset configured per sheet. */
export interface DefaultMilestone {
  name: string
  color: string
  /** 'phase' = colored span (default); 'milestone' = ◇ point. Legacy = phase. */
  kind?: 'phase' | 'milestone'
  /** Phase only: relative width used to auto-distribute milestone dates across a
   *  row's 開始日→完了日 span. Default 1. */
  weight?: number
}

export interface SheetSettings {
  /** Frozen leading-column count on wide screens. Default 1. */
  pinned_columns?: number
  /** Frozen leading-column count on narrow screens (so the gantt stays scrollable). */
  pinned_columns_narrow?: number
  /** Default milestones (phases) a row starts from / picks colors from. */
  default_milestones?: DefaultMilestone[]
  /** Column ids offered as filters in the schedule 絞り込み panel. */
  filter_columns?: string[]
  /** When true, the manual progress column resets weekly. */
  progress_weekly_reset?: boolean
  /** Rows are "completed" (for the 完了を隠す toggle) when this column's value is
   *  one of `values`. When unset, falls back to status column === '完了'. */
  done_filter?: { column_id: string; values: string[] }
  /** Milestone diamond (◇) visibility for the whole sheet: all (default) / none /
   *  last-only. Set on the sheet settings page. */
  milestone_display?: 'all' | 'none' | 'last'
  [k: string]: unknown
}

export interface Sheet {
  id: string
  name: string
  order: number
  has_week_grid: boolean
  key_column_id: string | null
  color_basis_column_id: string | null
  settings?: SheetSettings
}

export type ColumnType =
  | 'text'
  | 'number'
  | 'date'
  | 'dropdown'
  | 'status'
  | 'member'
  | 'lookup'

export interface DropdownOption {
  /** Stable id so renaming the value can follow through to stored row data. */
  id?: string
  value: string
  color?: string
  /** Frozen options are kept (existing data still displays) but hidden from the
   *  picker so they can't be chosen for new rows (要望: リストの凍結). */
  frozen?: boolean
}

export interface StatusRuleCondition {
  col_id: string
  op: string
  value: unknown
}

export interface StatusRule {
  conditions: StatusRuleCondition[]
  label: string
  color: string
}

export interface ColumnConfig {
  // dropdown
  options?: DropdownOption[]
  // status
  rules?: StatusRule[]
  /** status: when true, the badge is auto-derived from the row's milestones. */
  auto_from_milestones?: boolean
  /** When true, this column's value resets each week (週次リセット). */
  weekly_reset?: boolean
  /** text only: edit in a large multi-line textarea (modal) instead of a single line. */
  multiline?: boolean
  /** Reserved date columns for the task span: 'start' = 開始日, 'end' = 完了日.
   *  Editing one re-distributes the row's milestone (◇) dates by phase weight. */
  sched_role?: 'start' | 'end'
  // lookup. Each of local_key/match/return may be the literal "__id__"
  // (meaning the row's key_value) or a column id.
  target_sheet_id?: string
  /** Which LOCAL value is the lookup key. Default "__id__" (this row's key_value). */
  local_key_column_id?: string
  /** Which TARGET column to match against. Default "__id__" (target row's key_value). */
  match_key_column_id?: string
  return_column_id?: string
  [k: string]: unknown
}

export interface Column {
  id: string
  sheet_id: string
  name: string
  type: ColumnType
  order: number
  is_key: boolean
  config: ColumnConfig | null
}

export type CellValue = string | number | boolean | null

export interface Row {
  id: string
  sheet_id: string
  /** Parent task id for a subtask (子タスク); null for top-level tasks. */
  parent_row_id: string | null
  key_value: string
  data: Record<string, CellValue>
  version: number
  /** Manual progress 0-100 (手入力進捗%); null if unset. */
  progress: number | null
  /** Week (YYYY-MM-DD) the current progress applies to (weekly reset). */
  progress_week: string | null
  /** Predecessor task ids (先行タスク). */
  depends_on: string[]
}

export interface SheetDetail {
  sheet: Sheet
  columns: Column[]
  rows: Row[]
}

export interface Effort {
  row_id: string
  week_start: string // YYYY-MM-DD
  planned_hours: number | null
  actual_hours: number | null
  version?: number
}

/** One cell in a bulk weekly-effort write (範囲貼り付け／一括クリア). */
export interface EffortBulkItem {
  row_id: string
  week_start: string
  planned_hours?: number | null
  actual_hours?: number | null
}

/** One result from the cross-sheet search (Ctrl+K). */
export interface SearchHit {
  row_id: string
  sheet_id: string
  sheet_name: string
  key_value: string | null
  title: string
  /** Column whose value matched; null when the ID or title matched. */
  matched_field: string | null
}

/** One recorded change to a task (変更履歴). Values are display strings. */
export interface RowEvent {
  id: string
  row_id: string | null
  /** Task ID as it was at the time (survives the task being deleted). */
  row_key: string | null
  user_name: string
  kind: 'create' | 'update' | 'delete' | 'effort'
  /** What changed — column name, 「工数 2026-06-15」, 「ID」 etc. */
  field_label: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export interface Milestone {
  id: string
  row_id: string
  name: string
  /** 'phase' = colored gantt segment start; 'milestone' = ◇ point between phases. */
  kind: 'phase' | 'milestone'
  boundary_date: string // YYYY-MM-DD (planned boundary)
  color: string
  order: number
  /** Whether this milestone (phase boundary) has been achieved. */
  done: boolean
  /** Actual completion date (YYYY-MM-DD), or null. Compared to boundary_date. */
  actual_date: string | null
}

export interface SnapshotResult {
  rows: Row[]
  effort: Effort[]
  /** Week the data actually represents (nearest record ≤ requested; oldest when
   *  the request predates all snapshots). null when no snapshot exists. */
  as_of_week?: string | null
  /** True when as_of_week equals the requested week (exact record for it). */
  exact?: boolean
}

export interface ChangeEntry {
  row_id: string
  field: string
  old: unknown
  new: unknown
}

export interface AggregateRow {
  group: string
  planned_sum: number
  actual_sum: number
  count: number
}

/** A work-log line (実績入力). Hours roll up into the task's weekly actual. */
export interface WorkLog {
  id: string
  user_id: string | null
  work_date: string // YYYY-MM-DD
  row_id: string | null
  /** Resolved label of the linked task (read-only, from the server). */
  row_key_value: string | null
  sheet_id: string | null
  cat1: string | null
  cat2: string | null
  memo: string | null
  hours: number
}

// `type` (not `interface`) so it gets an implicit index signature and is
// assignable to the http client's JSON body type (Record<string, unknown>).
export type WorkLogInput = {
  work_date: string
  row_id?: string | null
  cat1?: string | null
  cat2?: string | null
  memo?: string | null
  hours: number
}

/** A task the current user is assigned to (for the 実績入力 task dropdown). */
export interface TaskOption {
  row_id: string
  key_value: string | null
  title: string
  sheet_id: string
  sheet_name: string
}

/** One member's work logs for a day (みんなの入力一覧). */
export interface UserDayWorkLog {
  user_id: string
  user_name: string
  total_hours: number
  logs: WorkLog[]
}

// ---- Notifications (アプリ内通知・ベル) ----
export type NotificationType =
  | 'behind'
  | 'dep'
  | 'overrun'
  | 'milestone'
  | 'worklog_missing'

export interface Notification {
  id: string
  type: NotificationType
  title: string
  body: string | null
  ref_kind: string | null
  ref_id: string | null
  created_at: string
  read_at: string | null
}

/** One alert detected on the front end while rendering the schedule. */
export interface NotificationItem {
  target_user_id: string
  type: NotificationType
  title: string
  body?: string | null
  ref_kind?: string | null
  ref_id?: string | null
  dedupe_key: string
}
