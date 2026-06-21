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
}

/** A default phase (milestone) preset configured per sheet. */
export interface DefaultMilestone {
  name: string
  color: string
}

export interface SheetSettings {
  /** Frozen leading-column count on wide screens. Default 1. */
  pinned_columns?: number
  /** Frozen leading-column count on narrow screens (so the gantt stays scrollable). */
  pinned_columns_narrow?: number
  /** Default milestones (phases) a row starts from / picks colors from. */
  default_milestones?: DefaultMilestone[]
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
  value: string
  color?: string
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

export interface Milestone {
  id: string
  row_id: string
  name: string
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
