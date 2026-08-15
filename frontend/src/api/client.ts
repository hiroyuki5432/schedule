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

export const createSheet = (body: { name: string; has_week_grid: boolean; is_master?: boolean }) =>
  http.post<Sheet>('/api/sheets', body)

export const getSheet = (id: string) => http.get<SheetDetail>(`/api/sheets/${id}`)

export const updateSheet = (
  id: string,
  body: Partial<
    Pick<
      Sheet,
      | 'name'
      | 'has_week_grid'
      | 'is_master'
      | 'key_column_id'
      | 'color_basis_column_id'
      | 'order'
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
  body: Partial<{
    name: string
    type: ColumnType
    config: ColumnConfig
    order: number
    /** 「いまこの値が入っている行をどこにあてがうか」。プルダウンの選択肢を消すとき、
     *  その値の行を別の値へ寄せる（null = 空にする）。列の属性ではなく、保存と同時に
     *  行へ適用される指示。 */
    value_remap: Record<string, string | null>
  }>,
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

/** Upload an .xlsx to upsert rows (matched by ID). With no plan this behaves as
 *  before (active worksheet, row 1 = header, column A = ID). Returns counts. */
export const importXlsx = (sheetId: string, file: File, plan: Partial<ImportPlan> = {}) =>
  postForm<ImportResult>(`/api/sheets/${sheetId}/import.xlsx`, importForm(file, plan))

/** What an import writes back. `notes` explains anything the import decided on
 *  its own — today: which プルダウン列 gained選択肢, and which were left alone for
 *  having too many distinct values. */
export interface ImportResult {
  created: number
  updated: number
  /** 「入れ替え」で取り込み前に消した行数。入れ替え以外では返らない。 */
  deleted?: number
  notes?: string[]
}

/** One Excel column as seen by the EXISTING-sheet wizard. `target` is the sheet
 *  column (or reserved header) it will be written into; '' = 取り込まない. */
export interface ImportRowsColumn {
  index: number
  header: string
  target: string
  role: '' | 'attr' | 'week' | 'progress' | 'deps' | 'milestone'
  type: string
  /** A target that was asked for but cannot be written — the column was renamed,
   *  deleted, or turned into a 参照(LOOKUP) column (computed, never imported).
   *  `target` is cleared in that case so the counts stay honest. */
  lost_target: string
  lost_reason: '' | 'computed' | 'missing'
  /** Set when the header is an ISO week date (週次工数の列). */
  week_start: string | null
  filled: number
  samples: string[]
  invalid: number
  invalid_samples: string[]
}

export interface ImportRowsInspection {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  last_row: number
  sheet_last_row: number
  id_column: number
  match_mode: ImportMatchMode
  total_rows: number
  /** Data rows below the header with NO cut applied. */
  available_rows: number
  preview: { row: number; cells: string[] }[]
  tail_preview: { row: number; cells: string[] }[]
  columns: ImportRowsColumn[]
  /** What an Excel column may be mapped onto (this sheet's columns + reserved). */
  targets: { key: string; label: string; type: string; role: string }[]
  new_rows: number
  updated_rows: number
  /** 「入れ替え」のときに消える、いまシートにある行数。 */
  deleted_rows: number
  blank_ids: number
  duplicate_ids: number
}

/** Read an .xlsx against an EXISTING sheet without importing: proposed column
 *  mapping, 新規/更新の件数, and values that would not convert. */
export const inspectImportRowsXlsx = (
  sheetId: string,
  file: File,
  plan: Partial<ImportPlan> = {},
) =>
  postForm<ImportRowsInspection>(
    `/api/sheets/${sheetId}/import.xlsx/inspect`,
    importForm(file, plan),
  )

/** 行の照合のしかた（要望: 1列目が被るだけで1行にまとめないでほしい）。
 *  - `none`    … 照合しない。Excelの1行＝アプリの1行（ウィザードの既定）
 *  - `id`      … ID列で既存の行を探して更新する（同じIDは1行になる）
 *  - `replace` … 取り込む前にシートの行を全部消す（入れ替え） */
export type ImportMatchMode = 'none' | 'id' | 'replace'

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
  /** Present only when the Excel column holds formulas. `expr` is the translated
   *  `[列名]` expression, or null with `reason` explaining why it stayed values.
   *  `lookup` is filled instead when the formula is an XLOOKUP/VLOOKUP. */
  formula?: {
    cells: number
    expr: string | null
    reason: string | null
    sample: string | null
    /** XLOOKUP / VLOOKUP と書いてある列か。`lookup`（＝キー列・照合列・取得列に
     *  **分解できた** とき）とは別物で、分解できなくても立つ。
     *
     *  「参照先を選ぶ…」を出す条件はこちら。`lookup` を条件にすると、式の書き方
     *  しだいでボタンが出たり出なかったりして、利用者からは理由の分からない差に
     *  見える（要望: XLOOKUP も参照が選べるものと選べないものがある）。分解できな
     *  かった理由は `reason` に入っている。 */
    has_lookup: boolean
    /** 列の全行が数式か。false = 一部の行は手入力の値。 */
    covers_all_rows: boolean
    /** 数式列にした場合に計算値で置き換わる（＝消える）手入力の行数。 */
    replaced_values: number
    lookup?: ImportLookupInfo
  }
}

/** An XLOOKUP/VLOOKUP column read back as 参照(LOOKUP) settings.
 *
 *  `ready` means every piece resolved to something that exists in this app, so the
 *  column can be created as a 参照列. Otherwise `reason` says what is missing —
 *  usually that the master worksheet has not been imported yet.
 *
 *  式の形が想定外で分解できなかった列には、そもそもこれが付かない（`has_lookup` だけ
 *  立つ）。中途半端に空欄だらけの値を入れるより、無いほうが画面で扱いやすい。 */
export interface ImportLookupInfo {
  /** 0-based Excel column this row's key comes from, and its header. */
  local_index: number
  local_column: string
  /** Worksheet the formula points at, and the app sheet it resolved to. */
  target_worksheet: string
  sheet_id: number | null
  sheet_name: string
  match_column: string
  return_column: string
  /** Column ids in the target sheet ('__id__' = the row's ID/key_value). */
  match_key_column_id: string
  return_column_id: string
  ready: boolean
  reason: string | null
}

/** One column as the wizard sends it back.
 *
 *  `expr` only matters for `type: 'formula'` — the `[列名]` expression the column
 *  computes (translated from the Excel formula on import). `lookup` is the same
 *  for `type: 'lookup'`: where the XLOOKUP/VLOOKUP pointed. `local_index` is an
 *  EXCEL column position, not a column id — the app's columns do not exist yet at
 *  this point, so the server binds it after creating them. */
export interface ImportColumnPick {
  index: number
  name: string
  type: ColumnType | ''
  expr?: string
  lookup?: {
    sheet_id: number
    local_index: number
    match_key_column_id: string
    return_column_id: string
  }
}

export interface ImportInspection {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  last_row: number
  sheet_last_row: number
  id_column: number
  total_rows: number
  /** Data rows below the header with NO cut applied. */
  available_rows: number
  preview: { row: number; cells: string[] }[]
  tail_preview: { row: number; cells: string[] }[]
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
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで（末尾の合計行・注記を切る）。 */
  lastRow?: number
  /** Open the tail preview at this row (1-based); 0 = auto (末尾). Inspect only. */
  tailFrom?: number
  /** 0-based; -1 = no ID column (keys are auto-numbered). */
  idColumn?: number
  /** 行の照合。省略すると従来どおり「ID列があれば照合」に解決される。 */
  matchMode?: ImportMatchMode
  /** See `ImportColumnPick`. */
  columns?: ImportColumnPick[]
}

function importForm(file: File, plan: Partial<ImportPlan>): FormData {
  const form = new FormData()
  form.append('file', file)
  if (plan.name) form.append('name', plan.name)
  if (plan.hasWeekGrid !== undefined) form.append('has_week_grid', String(plan.hasWeekGrid))
  if (plan.sheetName) form.append('sheet_name', plan.sheetName)
  if (plan.headerRow) form.append('header_row', String(plan.headerRow))
  if (plan.lastRow) form.append('last_row', String(plan.lastRow))
  if (plan.tailFrom) form.append('tail_from', String(plan.tailFrom))
  if (plan.idColumn !== undefined) form.append('id_column', String(plan.idColumn))
  if (plan.matchMode) form.append('match_mode', plan.matchMode)
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
  postForm<
    ImportResult & { sheet_id: number; name: string; columns: number }
  >('/api/sheets/import.xlsx', importForm(file, plan))

export const exportWorklogXlsxUrl = (from: string, to: string) =>
  `/api/worklog/export.xlsx?from=${from}&to=${to}`

/** How the 日報 wizard describes a file: worksheet, 見出し行, and which column
 *  feeds each field (0-based; -1 = 使わない). */
export interface WorklogImportPlan {
  sheetName?: string
  headerRow?: number
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  lastRow?: number
  /** Open the tail preview at this row (1-based); 0 = auto (末尾). Inspect only. */
  tailFrom?: number
  mapping?: Record<string, number>
}

export interface WorklogImportField {
  key: string
  label: string
  required: boolean
  /** Column index this field reads from; -1 when unmapped. */
  index: number
  samples: string[]
}

export interface WorklogInspection {
  worksheets: { name: string; rows: number; columns: number }[]
  sheet_name: string
  header_row: number
  suggested_header_row: number
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  last_row: number
  sheet_last_row: number
  total_rows: number
  /** Data rows below the header with NO cut applied. */
  available_rows: number
  preview: { row: number; cells: string[] }[]
  tail_preview: { row: number; cells: string[] }[]
  headers: string[]
  fields: WorklogImportField[]
  created: number
  skipped: number
  duplicates: number
  issues: { row: number; reason: string }[]
}

function worklogForm(file: File, plan: WorklogImportPlan): FormData {
  const form = new FormData()
  form.append('file', file)
  if (plan.sheetName) form.append('sheet_name', plan.sheetName)
  if (plan.headerRow) form.append('header_row', String(plan.headerRow))
  if (plan.lastRow) form.append('last_row', String(plan.lastRow))
  if (plan.tailFrom) form.append('tail_from', String(plan.tailFrom))
  if (plan.mapping) form.append('mapping', JSON.stringify(plan.mapping))
  return form
}

/** Admin-only, writes nothing: what the 日報 import WOULD do (件数・理由つき). */
export const inspectWorklogXlsx = (file: File, plan: WorklogImportPlan = {}) =>
  postForm<WorklogInspection>('/api/worklog/import.xlsx/inspect', worklogForm(file, plan))

/** Admin-only: bulk-add work logs from .xlsx. Returns counts. */
export const importWorklogXlsx = (file: File, plan: WorklogImportPlan = {}) =>
  postForm<{ created: number; skipped: number; duplicates: number }>(
    '/api/worklog/import.xlsx',
    worklogForm(file, plan),
  )

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

// ---- Excel 取り込み設定（プリセット）と一括取り込み ----

/** One saved 取り込み設定, keyed by the SOURCE worksheet's name. Written
 *  automatically when a wizard finishes, so the careful first pass is the setup. */
export interface ImportPreset {
  id: number
  name: string
  worksheet_name: string
  workbook_name: string
  /** null = 取り込み時に新しいシートを作る（名前は target_sheet_name）。 */
  target_sheet_id: number | null
  target_sheet_name: string
  has_week_grid: boolean
  header_row: number
  /** Last worksheet row to take, 1-based inclusive; 0 = 最後まで. */
  last_row: number
  id_column: number
  match_mode: ImportMatchMode
  mapping: { index: number; name: string; type: string }[]
  updated_at: string
  last_used_at: string | null
}

export interface ImportPresetSave {
  worksheet_name: string
  name?: string
  workbook_name?: string
  target_sheet_id?: number | null
  target_sheet_name?: string
  has_week_grid?: boolean
  header_row?: number
  last_row?: number
  id_column?: number
  match_mode?: ImportMatchMode
  mapping?: { index: number; name: string; type: ColumnType | '' }[]
}

export const getImportPresets = () => http.get<ImportPreset[]>('/api/import/presets')

/** Create or refresh the setting for a worksheet (upsert by worksheet name). */
export const saveImportPreset = (body: ImportPresetSave) =>
  http.post<ImportPreset>('/api/import/presets', body as unknown as Record<string, unknown>)

export const deleteImportPreset = (id: number) => http.del<void>(`/api/import/presets/${id}`)

/** What one worksheet of a dropped workbook will do. `action` is 'skip' unless a
 *  preset matched — dropping a book never silently creates a pile of sheets. */
export interface WorkbookSheetPlan {
  worksheet: string
  sheet_rows: number
  sheet_columns: number
  preset_id: number | null
  preset_updated_at: string | null
  action: 'existing' | 'new' | 'skip'
  target_sheet_id: number | null
  target_sheet_name: string
  has_week_grid: boolean
  header_row: number
  suggested_header_row: number
  last_row: number
  sheet_last_row: number
  id_column: number
  match_mode: ImportMatchMode
  mapping: { index: number; name: string; type: string }[] | null
  total_rows: number
  available_rows: number
  column_count: number
  new_rows: number
  updated_rows: number
  /** 「入れ替え」で消える行数（それ以外は 0）。 */
  deleted_rows: number
  blank_ids: number
  duplicate_ids: number
  invalid: number
  warnings: string[]
  /** Set when this worksheet could not be analysed at all (空シート等). */
  error: string | null
}

export interface WorkbookInspection {
  workbook_name: string
  worksheets: WorkbookSheetPlan[]
}

/** What the 一括取り込み screen sends back — only the fields it changed. */
export interface WorkbookPlanItem {
  worksheet: string
  action?: 'existing' | 'new' | 'skip'
  target_sheet_id?: number | null
  target_sheet_name?: string
  has_week_grid?: boolean
  header_row?: number
  last_row?: number
  id_column?: number
  match_mode?: ImportMatchMode
  /** See `ImportColumnPick`. */
  columns?: ImportColumnPick[]
}

function workbookForm(file: File, plan?: WorkbookPlanItem[], savePresets?: boolean): FormData {
  const form = new FormData()
  form.append('file', file)
  if (plan) form.append('plan', JSON.stringify(plan))
  if (savePresets !== undefined) form.append('save_presets', String(savePresets))
  return form
}

/** Dry-run a whole workbook: every worksheet matched to its saved setting, with
 *  新規/更新の件数 and warnings. Writes nothing. */
export const inspectWorkbook = (file: File, plan?: WorkbookPlanItem[]) =>
  postForm<WorkbookInspection>('/api/import/workbook/inspect', workbookForm(file, plan))

/** Import every non-skipped worksheet in ONE transaction (どれか失敗したら全部取消). */
export const importWorkbook = (file: File, plan: WorkbookPlanItem[], savePresets = true) =>
  postForm<{
    results: {
      worksheet: string
      sheet_id: number
      name: string
      header_row: number
      columns: number
      created: number
      updated: number
      deleted?: number
    }[]
    created: number
    updated: number
    deleted: number
  }>('/api/import/workbook', workbookForm(file, plan, savePresets))

// ---- 一括置換（列のみ / シート全体） ----

/** 置換の指定。`column_id` を省くとシートの全列。`'__id__'` は ID(key_value) だけ。
 *  `dry_run` が既定で true — 先に「何件・どう変わるか」を見てから確定する。 */
export interface ReplaceInput {
  column_id?: string | null
  find: string
  replace?: string
  /** セル全体が一致したときだけ置換する（Excel の「完全に同一」）。 */
  whole_cell?: boolean
  case_sensitive?: boolean
  /** シート全体のとき、ID(key_value) も置換の対象にする。 */
  include_key?: boolean
  /** プルダウンの選択肢も同じ規則で置換する（既定 true）。 */
  include_options?: boolean
  dry_run?: boolean
}

export interface ReplaceResult {
  rows: number
  cells: number
  options: number
  applied: boolean
  samples: { row_key: string; column_name: string; before: string; after: string }[]
}

export const replaceValues = (sheetId: string, body: ReplaceInput) =>
  http.post<ReplaceResult>(
    `/api/sheets/${sheetId}/replace`,
    body as unknown as Record<string, unknown>,
  )

// ---- データのお掃除（管理者のみ） ----

export interface MaintenanceUsage {
  /** DB全体のバイト数（Postgres のみ／取れないときは null）。 */
  database_bytes: number | null
  tables: { name: string; label: string; rows: number; bytes: number | null }[]
  cleanable: {
    row_events_total: number
    row_events_old: number
    row_events_keep_days: number
    snapshots_total: number
    snapshots_old: number
    snapshots_keep_weeks: number
    notifications_read: number
    /** 消した列の値（`rows.data` に残ったまま画面に出ないセル）。 */
    orphan_cells: number
    orphan_rows: number
    /** 開始日/完了日を列に移す前の値のうち、列と重複しているコピー。 */
    legacy_cells: number
    legacy_rows: number
    empty_effort: number
    backups_total: number
    backups_old: number
    backups_keep: number
    backups_bytes: number
    backups_old_bytes: number
  }
}

export interface CleanupInput {
  row_events_keep_days?: number | null
  snapshots_keep_weeks?: number | null
  notifications_read?: boolean
  orphan_cells?: boolean
  legacy_cells?: boolean
  empty_effort?: boolean
  backups_keep?: number | null
  dry_run?: boolean
}

export const getMaintenanceUsage = (params: {
  rowEventsKeepDays: number
  snapshotsKeepWeeks: number
  backupsKeep: number
}) =>
  http.get<MaintenanceUsage>(
    `/api/maintenance/usage?row_events_keep_days=${params.rowEventsKeepDays}` +
      `&snapshots_keep_weeks=${params.snapshotsKeepWeeks}&backups_keep=${params.backupsKeep}`,
  )

export const runMaintenanceCleanup = (body: CleanupInput) =>
  http.post<{ dry_run: boolean; deleted: Record<string, number>; total: number }>(
    '/api/maintenance/cleanup',
    body as unknown as Record<string, unknown>,
  )

// ---- バックアップ / リストア (グループ管理・管理者のみ) ----

/** One stored snapshot. The payload itself is not sent here (it is the whole
 *  group and can be many MB) — use the download URL for that. */
export interface Backup {
  id: number
  label: string
  format_version: number
  /** Row counts per table: sheets / rows / work_logs / members … */
  summary: Record<string, number>
  size_bytes: number
  created_at: string
  created_by_name: string
}

export interface RestoreResult {
  restored_from: string
  counts: Record<string, number>
  /** Backup taken automatically just before the restore — the way back. */
  safety_backup_id: number
  /** True when the restored data has no account for the current user, i.e. this
   *  session is now invalid and the next request will bounce to the login page. */
  signed_out: boolean
}

export const getBackups = () => http.get<Backup[]>('/api/backups')

export const createBackup = (label?: string) =>
  http.post<Backup>('/api/backups', { label: label ?? '' })

export const deleteBackup = (id: number) => http.del<void>(`/api/backups/${id}`)

export const backupDownloadUrl = (id: number) => `/api/backups/${id}/download`

/** Put the group back to this backup's state — everything, settings included. */
export const restoreBackup = (id: number) =>
  http.post<RestoreResult>(`/api/backups/${id}/restore`)

/** Restore from a previously downloaded .json (the path back after losing the DB). */
export const restoreBackupFile = (file: File) => {
  const form = new FormData()
  form.append('file', file)
  return postForm<RestoreResult>('/api/backups/restore-file', form)
}

// ---- Notifications (アプリ内通知・ベル) ----
export const getNotifications = () => http.get<Notification[]>('/api/notifications')

// Register schedule-derived alerts; deduped server-side. Returns count created.
export const registerNotifications = (items: NotificationItem[]) =>
  http.post<{ created: number }>('/api/notifications/register', { items })

// Mark notifications read (omit ids to mark all).
export const markNotificationsRead = (ids?: string[]) =>
  http.post<{ updated: number }>('/api/notifications/mark-read', ids ? { ids } : {})

// ---- Build info (画面のバージョン表示) ----
/** サーバ側の実バージョン。フロントの埋め込み値と突き合わせてズレを検出する。 */
export const getServerVersion = () =>
  http.get<{ version: string; commit: string; built_at: string }>('/api/version')

/** 複数行をまとめて削除（1トランザクション）。子タスクは親と一緒に消える。 */
export const bulkDeleteRows = (ids: string[]) =>
  http.post<{ deleted: number }>('/api/rows/bulk-delete', { ids })
