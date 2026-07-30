// Typed API client — one function per endpoint in docs/API.md.
import { http, ApiError } from '@/lib/http'
import type {
  AggregateRow,
  ChangeEntry,
  Column,
  ColumnConfig,
  ColumnType,
  Effort,
  EffortBulkItem,
  Member,
  Milestone,
  Notification,
  NotificationItem,
  Org,
  Role,
  Row,
  RowEvent,
  SearchHit,
  Sheet,
  SheetDetail,
  SheetSettings,
  SnapshotResult,
  TaskOption,
  User,
  UserDayWorkLog,
  WorkLog,
  WorkLogInput,
} from '@/types/api'

// ---- Auth ----
export const login = (email: string, password: string) =>
  http.post<{ user: User }>('/api/auth/login', { email, password })

export const logout = () => http.post<void>('/api/auth/logout')

export const me = () => http.get<{ user: User }>('/api/auth/me')

// ---- Org / Members ----
export const signupOrg = (body: {
  org_name: string
  admin_name: string
  admin_email: string
  admin_password: string
}) => http.post<Org>('/api/org/signup', body)

export const getOrg = () => http.get<Org>('/api/org')

export const updateOrg = (body: { name?: string; settings?: Org['settings'] }) =>
  http.patch<Org>('/api/org', body)

export const getMembers = () => http.get<Member[]>('/api/members')

export const createMember = (body: {
  name: string
  email: string
  password: string
  role: Role
  worklog_required?: boolean
}) => http.post<Member>('/api/members', body)

export const updateMember = (
  id: string,
  body: {
    name?: string
    role?: Role
    password?: string
    worklog_required?: boolean
    is_active?: boolean
  },
) => http.patch<Member>(`/api/members/${id}`, body)

export const deleteMember = (id: string) => http.del<void>(`/api/members/${id}`)

// ---- Sheets ----
export const getSheets = () => http.get<Sheet[]>('/api/sheets')

export const createSheet = (body: { name: string; has_week_grid: boolean }) =>
  http.post<Sheet>('/api/sheets', body)

export const getSheet = (id: string) => http.get<SheetDetail>(`/api/sheets/${id}`)

export const updateSheet = (
  id: string,
  body: Partial<
    Pick<
      Sheet,
      'name' | 'has_week_grid' | 'key_column_id' | 'color_basis_column_id' | 'order'
    >
  > & { settings?: SheetSettings },
) => http.patch<Sheet>(`/api/sheets/${id}`, body)

export const deleteSheet = (id: string) => http.del<void>(`/api/sheets/${id}`)

/** Admin-only: empty a sheet's rows / 工数 / マイルストン / スナップショット, keeping
 *  columns and settings (採番 resets to 1). For repeated import testing. */
export const clearSheetRows = (id: string) =>
  http.del<{ deleted: number }>(`/api/sheets/${id}/rows`)

/** Admin-only: empty EVERY sheet's data in the group (settings kept). */
export const clearOrgData = () =>
  http.post<{ sheets: number; deleted: number }>('/api/org/clear-data')

// ---- Columns ----
export const getColumns = (sheetId: string) =>
  http.get<Column[]>(`/api/sheets/${sheetId}/columns`)

export const createColumn = (
  sheetId: string,
  body: { name: string; type: ColumnType; config?: ColumnConfig; order?: number },
) => http.post<Column>(`/api/sheets/${sheetId}/columns`, body)

export const updateColumn = (
  id: string,
  body: Partial<{ name: string; type: ColumnType; config: ColumnConfig; order: number }>,
) => http.patch<Column>(`/api/columns/${id}`, body)

export const deleteColumn = (id: string) => http.del<void>(`/api/columns/${id}`)

// ---- Rows ----
export const getRows = (sheetId: string) => http.get<Row[]>(`/api/sheets/${sheetId}/rows`)

export const createRow = (
  sheetId: string,
  body: { key_value?: string; data: Row['data'] },
) => http.post<Row>(`/api/sheets/${sheetId}/rows`, body)

/** Create a subtask (子タスク) under a parent task. Inherits weekly effort,
 *  milestones and 日報-driven actuals like any task; id = parent key + '-NN'. */
export const createChildRow = (
  parentId: string,
  body: { key_value?: string; data: Row['data'] },
) => http.post<Row>(`/api/rows/${parentId}/children`, body)

export const updateRow = (
  id: string,
  body: {
    data: Row['data']
    version: number
    key_value?: string
    progress?: number | null
    depends_on?: string[]
  },
) => http.patch<Row>(`/api/rows/${id}`, body)

export const deleteRow = (id: string) => http.del<void>(`/api/rows/${id}`)

// ---- Effort (weekly hours) ----
export const getEffort = (sheetId: string, from?: string, to?: string) => {
  const q = new URLSearchParams()
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  const qs = q.toString()
  return http.get<Effort[]>(`/api/sheets/${sheetId}/effort${qs ? `?${qs}` : ''}`)
}

export const putEffort = (
  rowId: string,
  weekStart: string,
  body: { planned_hours?: number | null; actual_hours?: number | null; version?: number },
) => http.put<Effort>(`/api/rows/${rowId}/effort/${weekStart}`, body)

/** Write many weekly cells in one request (範囲貼り付け / 一括クリア / その取り消し). */
export const putEffortBulk = (items: EffortBulkItem[]) =>
  http.put<Effort[]>('/api/effort/bulk', { items })

// ---- Cross-sheet search (Ctrl+K) ----
export const searchRows = (q: string) =>
  http.get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`)

// ---- Change history (変更履歴) ----
export const getRowHistory = (rowId: string) =>
  http.get<RowEvent[]>(`/api/rows/${rowId}/history`)

export const getSheetHistory = (sheetId: string, limit = 200) =>
  http.get<RowEvent[]>(`/api/sheets/${sheetId}/history?limit=${limit}`)

// ---- Milestones ----
/** All milestones for every row in a sheet (one request — used by the schedule). */
export const getSheetMilestones = (sheetId: string) =>
  http.get<Milestone[]>(`/api/sheets/${sheetId}/milestones`)

export const getMilestones = (rowId: string) =>
  http.get<Milestone[]>(`/api/rows/${rowId}/milestones`)

export const putMilestones = (rowId: string, milestones: Milestone[]) =>
  http.put<Milestone[]>(`/api/rows/${rowId}/milestones`, milestones)

// ---- Snapshot / Changes (as-of, change points) ----
export const getSnapshot = (sheetId: string, week: string) =>
  http.get<SnapshotResult>(`/api/sheets/${sheetId}/snapshot?week=${week}`)

export const getChanges = (sheetId: string, week: string) =>
  http.get<ChangeEntry[]>(`/api/sheets/${sheetId}/changes?week=${week}`)

// ---- Aggregate (dashboard) ----
export const getAggregate = (
  sheetId: string,
  groupBy: string,
  from?: string,
  to?: string,
) => {
  const q = new URLSearchParams({ group_by: groupBy })
  if (from) q.set('from', from)
  if (to) q.set('to', to)
  return http.get<AggregateRow[]>(`/api/sheets/${sheetId}/aggregate?${q.toString()}`)
}

// ---- Export / Import ----
export const exportCsvUrl = (sheetId: string) => `/api/sheets/${sheetId}/export.csv`
export const exportXlsxUrl = (sheetId: string) => `/api/sheets/${sheetId}/export.xlsx`

/** Upload an .xlsx to upsert rows (matched by ID). Returns counts. */
export async function importXlsx(
  sheetId: string,
  file: File,
): Promise<{ created: number; updated: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/sheets/${sheetId}/import.xlsx`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const text = await res.text()
  const payload = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new ApiError(res.status, payload?.detail ?? `HTTP ${res.status}`)
  }
  return payload
}

/** How a header column will be treated on a schedule sheet. */
export type ImportColumnRole = 'attr' | 'week' | 'progress' | 'deps' | 'milestone'

/** One column the user can pick in the 取り込みウィザード. */
export interface ImportColumnInfo {
  index: number
  header: string
  role: ImportColumnRole
  type: ColumnType | ''
  selected: boolean
  filled: number
  samples: string[]
  options: string[]
  /** Cells that would NOT convert to `type` (dropped or blanked on import). */
  invalid: number
  invalid_samples: string[]
}

export interface ImportInspection {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  id_column: number
  total_rows: number
  preview: { row: number; cells: string[] }[]
  columns: ImportColumnInfo[]
  blank_ids: number
  duplicate_ids: number
}

/** What the wizard sends back: which worksheet / 見出し行 / ID列 / 列 to take. */
export interface ImportPlan {
  name?: string
  hasWeekGrid: boolean
  sheetName?: string
  /** 1-based; 0 = auto-detect. */
  headerRow?: number
  /** 0-based; -1 = no ID column (keys are auto-numbered). */
  idColumn?: number
  columns?: { index: number; name: string; type: ColumnType | '' }[]
}

function importForm(file: File, plan: Partial<ImportPlan>): FormData {
  const form = new FormData()
  form.append('file', file)
  if (plan.name) form.append('name', plan.name)
  if (plan.hasWeekGrid !== undefined) form.append('has_week_grid', String(plan.hasWeekGrid))
  if (plan.sheetName) form.append('sheet_name', plan.sheetName)
  if (plan.headerRow) form.append('header_row', String(plan.headerRow))
  if (plan.idColumn !== undefined) form.append('id_column', String(plan.idColumn))
  if (plan.columns) form.append('columns', JSON.stringify(plan.columns))
  return form
}

async function postForm<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: 'POST', credentials: 'include', body: form })
  const text = await res.text()
  const payload = text ? JSON.parse(text) : {}
  if (!res.ok) {
    throw new ApiError(res.status, payload?.detail ?? `HTTP ${res.status}`)
  }
  return payload
}

/** Read an .xlsx WITHOUT importing: worksheets, the guessed 見出し行, a preview and
 *  per-column types / samples / conversion warnings. Pass `columns` to re-check the
 *  warnings against the user's own picks before committing. */
export const inspectImportXlsx = (file: File, plan: Partial<ImportPlan>) =>
  postForm<ImportInspection>('/api/sheets/import.xlsx/inspect', importForm(file, plan))

/** Upload an .xlsx as a BRAND NEW sheet, following the wizard's plan (or, with no
 *  plan, the auto-detected header row and inferred types). Returns id + counts. */
export const importNewSheetXlsx = (file: File, plan: ImportPlan) =>
  postForm<{
    sheet_id: number
    name: string
    columns: number
    created: number
    updated: number
  }>('/api/sheets/import.xlsx', importForm(file, plan))

export const exportWorklogXlsxUrl = (from: string, to: string) =>
  `/api/worklog/export.xlsx?from=${from}&to=${to}`

/** Admin-only: bulk-add work logs from .xlsx. Returns counts. */
export async function importWorklogXlsx(
  file: File,
): Promise<{ created: number; skipped: number; duplicates: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/worklog/import.xlsx', {
    method: 'POST',
    credentials: 'include',
    body: form,
  })
  const text = await res.text()
  const payload = text ? JSON.parse(text) : {}
  if (!res.ok) throw new ApiError(res.status, payload?.detail ?? `HTTP ${res.status}`)
  return payload
}

// ---- Work logs (日報) ----
export const getWorkLogs = (params?: { from?: string; to?: string; userId?: string }) => {
  const q = new URLSearchParams()
  if (params?.from) q.set('from', params.from)
  if (params?.to) q.set('to', params.to)
  if (params?.userId) q.set('user_id', params.userId)
  const qs = q.toString()
  return http.get<WorkLog[]>(`/api/worklog${qs ? `?${qs}` : ''}`)
}

// Tasks the current user is assigned to (across all sheets) for the picker.
export const getMyTasks = () => http.get<TaskOption[]>('/api/worklog/tasks')

// Every member's work logs for one day (みんなの入力一覧).
export const getAllUsersWorklog = (date: string) =>
  http.get<UserDayWorkLog[]>(`/api/worklog/all?date=${date}`)

export const createWorkLog = (body: WorkLogInput) => http.post<WorkLog>('/api/worklog', body)

export const updateWorkLog = (id: string, body: Partial<WorkLogInput>) =>
  http.patch<WorkLog>(`/api/worklog/${id}`, body)

export const deleteWorkLog = (id: string) => http.del<void>(`/api/worklog/${id}`)

// ---- Notifications (アプリ内通知・ベル) ----
export const getNotifications = () => http.get<Notification[]>('/api/notifications')

// Register schedule-derived alerts; deduped server-side. Returns count created.
export const registerNotifications = (items: NotificationItem[]) =>
  http.post<{ created: number }>('/api/notifications/register', { items })

// Mark notifications read (omit ids to mark all).
export const markNotificationsRead = (ids?: string[]) =>
  http.post<{ updated: number }>('/api/notifications/mark-read', ids ? { ids } : {})
