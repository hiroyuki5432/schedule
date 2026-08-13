import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePersistentState } from '@/hooks/usePersistentState'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useScheduleData } from '@/hooks/useScheduleData'
import type { ViewMode } from '@/hooks/useScheduleData'
import { useEffortMutation } from '@/hooks/useEffortMutation'
import { useEffortBulkMutation } from '@/hooks/useEffortBulkMutation'
import type { BulkEffortEdit } from '@/hooks/useEffortBulkMutation'
import { useRowMutation } from '@/hooks/useRowMutation'
import { useComputedValues } from '@/hooks/useComputedValues'
import { useUndo, useUndoHotkeys } from '@/hooks/useUndo'
import type { UndoDirection } from '@/hooks/useUndo'
import * as api from '@/api/client'
import { GanttGrid } from '@/components/schedule/GanttGrid'
import type { SortState, WeekEdit } from '@/components/schedule/GanttGrid'
import { Legend } from '@/components/schedule/Legend'
import { MilestoneEditor } from '@/components/schedule/MilestoneEditor'
import { DependencyEditor } from '@/components/schedule/DependencyEditor'
import { HistoryPanel } from '@/components/schedule/HistoryPanel'
import { RecordModal } from '@/components/RecordModal'
import { DefaultViewButton, SearchBox } from '@/components/ViewControls'
import { GridSkeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { SaveStatus } from '@/components/SaveStatus'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { Input } from '@/components/ui/Input'
import { PlusIcon, XIcon } from '@/components/ui/icons'
import { useAuth } from '@/hooks/useAuth'
import { buildColFilterOptions, matchColFilter } from '@/lib/colFilter'
import type { ColFilter } from '@/lib/colFilter'
import { addWeeks, fmtISO, fmtMD, parseDate, startOfWeek } from '@/lib/dates'
import { phaseWeightByName, redistributeMilestones } from '@/lib/milestones'
import { makeIsRowDone, resolveDisplayValue } from '@/lib/status'
import { cn } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { CellValue, Column, NotificationItem, Row } from '@/types/api'

/** One reversible edit. Entries hold DATA only — never a captured row object —
 *  so undoing later uses the row's current version instead of a stale one. */
type UndoEntry =
  | { label: string; kind: 'effort'; edits: WeekEdit[] }
  | {
      label: string
      kind: 'cell'
      rowId: string
      colId: string
      before: CellValue
      after: CellValue
    }
  | { label: string; kind: 'progress'; rowId: string; before: number | null; after: number | null }
  | { label: string; kind: 'key'; rowId: string; before: string; after: string }

const VIEW_MODES: Array<{ m: ViewMode; label: string }> = [
  { m: 'week', label: '週' },
  { m: 'month', label: '月' },
]

/** The filter + sort state a user can save as this sheet's 既定の表示. */
interface ViewPreset {
  colFilters: Record<string, ColFilter>
  sort: SortState | null
  search: string
  hideDone: boolean
  thisWeekOnly: boolean
}

/** "Nothing applied" — what 既定に戻す falls back to when nothing is saved. */
const EMPTY_VIEW: ViewPreset = {
  colFilters: {},
  sort: null,
  search: '',
  hideDone: false,
  thisWeekOnly: false,
}
const WEEK_W = 22 // weekly column width (px)
const MONTH_W = 52 // monthly column width (px)

interface Props {
  sheetId: string
  sheetName: string
}

export function SchedulePage({ sheetId, sheetName }: Props) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  // Notification deep-link: ?focus=<rowId>&t=<nonce> scrolls to + highlights a task.
  const [searchParams] = useSearchParams()
  const focusRowId = searchParams.get('focus')
  const focusNonce = Number(searchParams.get('t') ?? 0)
  const weekStartWeekday = useWeekStartWeekday()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])

  // View settings persist per sheet so reloading / navigating away resumes the
  // last view (要望: 前回の表示から開始).
  const k = (name: string) => `view:sched:${sheetId}:${name}`
  const [viewMode, setViewMode] = usePersistentState<ViewMode>(k('viewMode'), 'week')
  const colW = viewMode === 'month' ? MONTH_W : WEEK_W
  // as-of stepping: 0 = today (live); negative offset = weeks back. Lets the
  // user view a past week's recorded plan (週次スナップショット). Week view only.
  // Not persisted — always resume at today.
  const [asOfOffset, setAsOfOffset] = useState(0)
  const [milestoneRow, setMilestoneRow] = useState<Row | null>(null)
  // Full-record view opened from a row's 開く (全項目の編集＋そのタスクの変更履歴).
  // Held by id so the modal keeps showing fresh data across refetches.
  const [recordRowId, setRecordRowId] = useState<string | null>(null)
  const [depRow, setDepRow] = useState<Row | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [showDepLines, setShowDepLines] = usePersistentState(k('showDepLines'), false)
  // Excel-style per-column header filters + full-text search + quick toggles
  // (hide-done / this-week-only). Each column keeps a ColFilter: a checked value
  // set (text), a checked month set (date), or a min/max range (number). Key
  // absent = no filter. V3 key: value model changed from string[] → ColFilter.
  const [colFilters, setColFilters] = usePersistentState<Record<string, ColFilter>>(
    k('colFiltersV4'),
    {},
  )
  const [search, setSearch] = usePersistentState(k('search'), '')
  const [hideDone, setHideDone] = usePersistentState(k('hideDone'), false)
  const [thisWeekOnly, setThisWeekOnly] = usePersistentState(k('thisWeekOnly'), false)
  const [pinsCollapsed, setPinsCollapsed] = usePersistentState(k('pinsCollapsed'), false)
  // Sort lives here (not inside GanttGrid) so it survives the grid unmounting —
  // which happens the moment a filter matches nothing (要望: 昇順のあとに検索フィルタ
  // すると並びが戻る) — and so it can be part of the saved default view.
  const [sort, setSort] = usePersistentState<SortState | null>(k('sort'), null)
  // 既定の表示 (default filter/sort): saved on demand, restored with one click.
  const [defaultView, setDefaultView] = usePersistentState<ViewPreset | null>(
    k('defaultView'),
    null,
  )

  const currentView = (): ViewPreset => ({
    colFilters,
    sort,
    search,
    hideDone,
    thisWeekOnly,
  })
  function applyView(v: ViewPreset) {
    setColFilters(v.colFilters ?? {})
    setSort(v.sort ?? null)
    setSearch(v.search ?? '')
    setHideDone(!!v.hideDone)
    setThisWeekOnly(!!v.thisWeekOnly)
  }
  function resetView() {
    applyView(defaultView ?? EMPTY_VIEW)
    toast.show(defaultView ? '既定の表示に戻しました' : '絞り込み・並べ替えを解除しました', 'success', 2000)
  }
  function saveAsDefault() {
    setDefaultView(currentView())
    toast.show('今の絞り込み・並べ替えを既定にしました', 'success', 2500)
  }

  // As-of stepping is meaningful in week view (column = week); disable in month.
  const live = asOfOffset === 0 || viewMode === 'month'

  const currentWeekStart = useMemo(
    () => startOfWeek(new Date(), weekStartWeekday),
    [weekStartWeekday],
  )
  const currentWeekIso = fmtISO(currentWeekStart)
  const asOfWeekStart = live ? null : addWeeks(currentWeekIso, asOfOffset)
  // Week being viewed (live current week, or as-of week) — for weekly-reset cells.
  const viewedWeekIso = asOfWeekStart ?? currentWeekIso

  const grid = useScheduleData({
    sheetId,
    weekStartWeekday,
    members,
    asOfWeek: asOfWeekStart,
    viewMode,
  })

  const { weeks, currentWeekIdx } = grid
  const lineIndex = live ? currentWeekIdx : Math.max(0, currentWeekIdx + asOfOffset)

  // Frozen-column count: 2-stage 通常/最小 (configured on the sheet settings
  // page; both can extend through the summary columns up to 進捗).
  const sheetSettings = grid.detail?.sheet.settings
  const colCount = grid.columns.length
  // ID + attribute columns + 5 summary columns (予定計/実績計/差/進捗/予実差).
  const freezeMax = colCount + 5
  const pinnedFull = Math.min(sheetSettings?.pinned_columns ?? 1, freezeMax)
  const pinnedMin = Math.min(
    sheetSettings?.pinned_columns_narrow ?? Math.min(1, pinnedFull),
    freezeMax,
  )
  const pinnedCount = Math.max(0, pinsCollapsed ? pinnedMin : pinnedFull)
  const defaultMilestones = useMemo(
    () => sheetSettings?.default_milestones ?? [],
    [sheetSettings],
  )

  const effortMut = useEffortMutation(sheetId)
  const bulkEffortMut = useEffortBulkMutation(sheetId)
  const rowMut = useRowMutation(sheetId)

  // Undo/redo needs the CURRENT rows when an entry is replayed (versions move on
  // after every save), so it reads them through a ref rather than a closure.
  const rowsRef = useRef(grid.rows)
  rowsRef.current = grid.rows

  const memberName = useMemo(
    () => new Map(members.map((m) => [String(m.id), m.name])),
    [members],
  )
  // Grid display value / 完了判定 — shared with マイタスク so both agree (lib/status).
  const resolveColValue = useCallback(
    (r: (typeof grid.rows)[number], col: Column): string =>
      resolveDisplayValue(r, col, memberName),
    [memberName],
  )

  const doneFilter = sheetSettings?.done_filter
  const isRowDone = useMemo(
    () => makeIsRowDone(grid.columns, memberName, doneFilter),
    [grid.columns, memberName, doneFilter],
  )

  // Per-column filter option metadata (distinct values / month keys / numeric
  // range), computed from the UNFILTERED rows so header menus always show every
  // choice. Every attribute column is filterable (要望: 全属性見出し).
  const filterOptions = useMemo(
    () => buildColFilterOptions(grid.columns, grid.rows, resolveColValue),
    [grid.columns, grid.rows, resolveColValue],
  )

  // A column filter is active whenever its key is present (we delete the key when
  // a filter no longer narrows anything, so any surviving key means real narrowing).
  const anyColFilter = Object.keys(colFilters).length > 0
  const filtersActive =
    search.trim() !== '' || hideDone || thisWeekOnly || anyColFilter

  // Rows added in this session. A brand-new row is empty, so it matches almost no
  // filter and vanishes the instant it is created — you press 新規行 and nothing
  // happens (要望). Keeping just these visible lets you fill the row in and have
  // it settle into the filter naturally; a reload or clearing the filter drops the
  // exemption.
  const [newRowIds, setNewRowIds] = useState<string[]>([])
  useEffect(() => setNewRowIds([]), [sheetId])
  const keptNew = useMemo(() => new Set(newRowIds), [newRowIds])

  const visibleRows = useMemo(() => {
    if (!filtersActive) return grid.rows
    const q = search.trim().toLowerCase()
    const colById = new Map(grid.columns.map((c) => [String(c.id), c]))
    const colEntries = Object.entries(colFilters)
    const match = (r: (typeof grid.rows)[number]) => {
      if (keptNew.has(String(r.row.id))) return true
      for (const [colId, f] of colEntries) {
        const col = colById.get(String(colId))
        // Row passes only if its resolved value satisfies the column filter.
        if (col && !matchColFilter(f, resolveColValue(r, col))) return false
      }
      if (hideDone && isRowDone(r)) return false
      if (thisWeekOnly) {
        if (r.startIdx == null || r.finishIdx == null) return false
        if (currentWeekIdx < r.startIdx || currentWeekIdx > r.finishIdx) return false
      }
      if (q) {
        const parts = [r.keyValue, r.title]
        for (const c of grid.columns) parts.push(resolveColValue(r, c))
        if (!parts.join(' ').toLowerCase().includes(q)) return false
      }
      return true
    }
    // Strict filtering (Excel-like): show exactly the rows that match. We do NOT
    // re-add a filtered-out parent just because a child matched — that made hidden
    // values (e.g. status「遅延」) reappear. A matched subtask whose parent is
    // filtered out still renders standalone (GanttGrid shows orphans); a matched
    // parent keeps its roll-up even with children hidden.
    return grid.rows.filter(match)
  }, [
    grid.rows,
    grid.columns,
    colFilters,
    search,
    hideDone,
    thisWeekOnly,
    filtersActive,
    currentWeekIdx,
    resolveColValue,
    isRowDone,
    keptNew,
  ])

  // True when the viewed past week has no recorded snapshot and we're showing the
  // oldest available record instead (週次スナップショットが残っていない週).
  const asOfMissing = !live && grid.asOfExact === false
  function stepBack() {
    // Don't step past the oldest record: once a week with no snapshot is shown,
    // going further back would keep showing the same oldest record.
    if (asOfMissing) return
    if (currentWeekIdx + asOfOffset > 1) setAsOfOffset((o) => o - 1)
  }
  function stepFwd() {
    if (asOfOffset < 0) setAsOfOffset((o) => o + 1)
  }
  function backToToday() {
    setAsOfOffset(0)
  }

  /** One grid edit → the actual per-week writes. In month view the entered total
   *  is spread evenly over that month's weeks (remainder on the first week). */
  const expandEdit = useCallback(
    (edit: WeekEdit, value: number | null): BulkEffortEdit[] => {
      if (viewMode === 'month' && grid.monthWeeks) {
        const weeksOfMonth = grid.monthWeeks.get(edit.weekStart) ?? [edit.weekStart]
        const n = weeksOfMonth.length || 1
        const total = value ?? 0
        const share = Math.round((total / n) * 100) / 100
        return weeksOfMonth.map((ws, i) => ({
          rowId: edit.rowId,
          weekStart: ws,
          field: edit.field,
          value:
            total === 0
              ? null
              : i === 0
                ? Math.round((total - share * (n - 1)) * 100) / 100
                : share,
        }))
      }
      return [
        { rowId: edit.rowId, weekStart: edit.weekStart, field: edit.field, value },
      ]
    },
    [viewMode, grid.monthWeeks],
  )

  /** Write a cell without recording undo — shared by the editor and by replay. */
  const writeCell = useCallback(
    (row: Row, colId: string, value: CellValue) => {
      const col = grid.columns.find((c) => String(c.id) === String(colId))
      // 開始日/完了日 (sched_role) columns also re-distribute the row's ◇ dates.
      if (col?.config?.sched_role) {
        void saveSpanCell(row, col, value)
        return
      }
      const patch: Record<string, CellValue> = { [colId]: value }
      // Weekly-reset columns: stamp the current week so the value shows this week
      // and clears next week (visible again when stepping back to this week).
      if (col?.config?.weekly_reset) patch[`__wk_${colId}`] = currentWeekIso
      rowMut.mutate({ row, patch })
    },
    // saveSpanCell is a hoisted function declaration in this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid.columns, currentWeekIso, rowMut],
  )

  const applyUndoEntry = useCallback(
    (entry: UndoEntry, dir: UndoDirection) => {
      if (entry.kind === 'effort') {
        const items = entry.edits.flatMap((e) =>
          expandEdit(e, dir === 'undo' ? e.prev : e.value),
        )
        bulkEffortMut.mutate(items)
        return
      }
      const model = rowsRef.current.find((r) => String(r.row.id) === entry.rowId)
      if (!model) {
        toast.show('対象の行が見つかりませんでした（削除された可能性があります）', 'warn')
        return
      }
      const row = model.row
      if (entry.kind === 'cell') {
        writeCell(row, entry.colId, dir === 'undo' ? entry.before : entry.after)
      } else if (entry.kind === 'progress') {
        rowMut.mutate({ row, patch: {}, progress: dir === 'undo' ? entry.before : entry.after })
      } else {
        rowMut.mutate({ row, patch: {}, keyValue: dir === 'undo' ? entry.before : entry.after })
      }
    },
    [expandEdit, bulkEffortMut, writeCell, rowMut],
  )

  // The stack resets per sheet: recorded row ids mean nothing on another sheet.
  const undo = useUndo<UndoEntry>(applyUndoEntry, sheetId)

  const doUndo = useCallback(() => {
    const entry = undo.undo()
    if (!entry) {
      toast.show('元に戻せる操作はありません', 'info', 2000)
      return
    }
    toast.show(`「${entry.label}」を元に戻しました`, 'success', 2500)
  }, [undo])

  const doRedo = useCallback(() => {
    const entry = undo.redo()
    if (!entry) {
      toast.show('やり直せる操作はありません', 'info', 2000)
      return
    }
    toast.show(`「${entry.label}」をやり直しました`, 'success', 2500)
  }, [undo])

  useUndoHotkeys(doUndo, doRedo)

  function saveWeek(edit: WeekEdit) {
    if (edit.value === edit.prev) return
    undo.push({ kind: 'effort', label: '工数の入力', edits: [edit] })
    for (const item of expandEdit(edit, edit.value)) effortMut.mutate(item)
  }

  /** Range paste / range clear — one request for the whole block. */
  function saveWeeksBulk(edits: WeekEdit[]) {
    if (edits.length === 0) return
    undo.push({ kind: 'effort', label: `工数 ${edits.length}セルの一括編集`, edits })
    bulkEffortMut.mutate(edits.flatMap((e) => expandEdit(e, e.value)))
  }

  function saveRowCell(row: Row, colId: string, value: CellValue) {
    const col = grid.columns.find((c) => String(c.id) === String(colId))
    const before = row.data[colId] ?? null
    if (before === value) return
    undo.push({
      kind: 'cell',
      label: col?.name ?? '項目の変更',
      rowId: String(row.id),
      colId,
      before,
      after: value,
    })
    writeCell(row, colId, value)
  }

  function saveRowKey(row: Row, key: string) {
    undo.push({
      kind: 'key',
      label: 'IDの変更',
      rowId: String(row.id),
      before: row.key_value,
      after: key,
    })
    rowMut.mutate({ row, patch: {}, keyValue: key })
  }

  function saveProgress(row: Row, value: number | null) {
    undo.push({
      kind: 'progress',
      label: '進捗の変更',
      rowId: String(row.id),
      before: row.progress,
      after: value,
    })
    rowMut.mutate({ row, patch: {}, progress: value })
  }

  // 開始日/完了日 (sched_role 列) を編集 (Feature 2): その列を保存し、両日付が
  // 揃っていて◇があれば割合に応じてマイルストン日付を自動再配分する。
  const schedStartCol = useMemo(
    () => grid.columns.find((c) => c.config?.sched_role === 'start'),
    [grid.columns],
  )
  const schedEndCol = useMemo(
    () => grid.columns.find((c) => c.config?.sched_role === 'end'),
    [grid.columns],
  )
  async function saveSpanCell(row: Row, col: Column, value: CellValue) {
    const model = grid.rows.find((r) => String(r.row.id) === String(row.id))
    const curOf = (c: Column | undefined) =>
      c ? ((row.data[c.id] as string | null) ?? '') : ''
    const start = col.config?.sched_role === 'start' ? (value as string | null) ?? '' : curOf(schedStartCol)
    const end = col.config?.sched_role === 'end' ? (value as string | null) ?? '' : curOf(schedEndCol)
    try {
      await api.updateRow(row.id, {
        data: { ...row.data, [col.id]: value },
        version: row.version,
      })
      if (model && model.milestones.length > 0 && start && end) {
        const next = redistributeMilestones(
          model.milestones,
          start,
          end,
          phaseWeightByName(defaultMilestones),
        )
        await api.putMilestones(row.id, next)
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones', sheetId] }),
      ])
    } catch {
      void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
    }
  }

  // Raw rows + the lookup resolver the record modal needs (the grid keeps its own
  // copies internally, but the modal is rendered by this page).
  const rawRows = useMemo(() => grid.rows.map((m) => m.row), [grid.rows])
  const recordRow = rawRows.find((r) => String(r.id) === recordRowId) ?? null
  const { computedValue } = useComputedValues(grid.columns, members)

  // Candidate predecessor tasks for the dependency picker.
  const depCandidates = useMemo(
    () => grid.rows.map((r) => ({ id: r.row.id, key_value: r.keyValue, title: r.title })),
    [grid.rows],
  )

  function newRow() {
    api
      .createRow(sheetId, { data: {} })
      .then((r) => {
        // Exempt it from the active filters so it does not disappear on creation.
        setNewRowIds((prev) => [...prev, String(r.id)])
        return qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
      })
      .catch(() => {
        /* surfaced via grid reload; TODO: toast on failure */
      })
  }

  function addChild(parentRow: Row) {
    // Inherit the parent's assignee so the subtask appears in that member's
    // 実績入力 picker right away (実績も入れれるように).
    const memberCol = grid.columns.find((c) => c.type === 'member')
    const data: Record<string, CellValue> = {}
    if (memberCol && parentRow.data[memberCol.id] != null)
      data[memberCol.id] = parentRow.data[memberCol.id]
    api
      .createChildRow(parentRow.id, { data })
      .then((r) => {
        setNewRowIds((prev) => [...prev, String(r.id)])
        return qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
      })
      .catch(() => {
        /* TODO: toast on failure */
      })
  }

  function deleteRow(row: Row) {
    const childCount = grid.rows.filter(
      (r) => r.parentRowId === String(row.id),
    ).length
    const msg =
      childCount > 0
        ? `行「${row.key_value}」と子タスク${childCount}件を削除しますか？`
        : `行「${row.key_value}」を削除しますか？`
    if (!confirm(msg)) return
    api
      .deleteRow(row.id)
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
      .catch(() => {
        /* TODO: toast on failure */
      })
  }

  // Detection → notification register (cron-free): when the live schedule renders,
  // turn each behind / 逆ザヤ / マイルストン超過 into a notification for the task's
  // assignee. Idempotent server-side (dedupe_key); a per-session ref also avoids
  // re-POSTing the same alert on every re-render.
  const sentKeys = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (grid.loading || !live || grid.rows.length === 0) return
    const todayIso = fmtISO(new Date())
    const items: NotificationItem[] = []
    const push = (it: NotificationItem) => {
      if (sentKeys.current.has(it.dedupe_key)) return
      items.push(it)
    }
    for (const r of grid.rows) {
      if (!r.assigneeId) continue // unassigned: no one to notify
      const label = r.keyValue || r.title || '無題タスク'
      // ref points at the exact task so the bell can scroll+highlight it.
      const ref = `${sheetId}:${r.row.id}`
      if (r.behind) {
        const wk = r.statusDelayWeeks
        push({
          target_user_id: r.assigneeId,
          type: 'behind',
          title: `遅延: ${label}`,
          body: `進捗が予定を下回っています${wk ? `（約${wk}週遅れ）` : ''}。`,
          ref_kind: 'row',
          ref_id: ref,
          dedupe_key: `behind:${r.row.id}:${currentWeekIso}`,
        })
      }
      for (const v of r.depViolations) {
        push({
          target_user_id: r.assigneeId,
          type: 'dep',
          title: `逆ザヤ: ${label}`,
          body: `先行「${v.predKey}」の完了前に開始予定です（${v.weeks}週）。`,
          ref_kind: 'row',
          ref_id: ref,
          dedupe_key: `dep:${r.row.id}:${v.predKey}:${currentWeekIso}`,
        })
      }
      for (const m of r.milestones) {
        if (m.done || m.boundary_date >= todayIso) continue
        push({
          target_user_id: r.assigneeId,
          type: 'milestone',
          title: `マイルストン超過: ${label}`,
          body: `「${m.name}」の予定日 ${m.boundary_date} を過ぎています。`,
          ref_kind: 'row',
          ref_id: ref,
          dedupe_key: `milestone:${m.id}`,
        })
      }
    }
    if (items.length === 0) return
    for (const it of items) sentKeys.current.add(it.dedupe_key)
    api
      .registerNotifications(items)
      .then((res) => {
        if (res.created > 0) qc.invalidateQueries({ queryKey: ['notifications'] })
      })
      .catch(() => {
        // Detection is best-effort; drop the keys so a later render can retry.
        for (const it of items) sentKeys.current.delete(it.dedupe_key)
      })
  }, [grid.loading, grid.rows, live, sheetId, currentWeekIso, qc])

  const lineWeek = weeks[lineIndex]
  const asOfLabel = live ? '基準週: 今日' : `基準週: ${lineWeek ? fmtMD(lineWeek) : ''}`

  return (
    <>
      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3 px-[22px] pb-3 pt-4">
        <div className="min-w-0">
          <SheetTitleInline sheetId={sheetId} name={sheetName} />
          <div className="mt-0.5 text-[12px] text-[var(--ink3)]">
            週次工数 ・ 過去=実績 / 未来=予定
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SaveStatus />

          {/* undo / redo — the keyboard shortcuts exist too, but most people
              won't guess that a web grid supports Ctrl+Z unless it's shown. */}
          <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
            <button
              onClick={doUndo}
              disabled={!undo.canUndo}
              title="元に戻す（Ctrl+Z）"
              aria-label="元に戻す"
              className="px-2.5 py-1.5 text-[13px] leading-none text-[var(--ink2)] enabled:hover:bg-[var(--line2)] disabled:text-[var(--line)]"
            >
              ↶
            </button>
            <button
              onClick={doRedo}
              disabled={!undo.canRedo}
              title="やり直す（Ctrl+Y）"
              aria-label="やり直す"
              className="border-l border-[var(--line)] px-2.5 py-1.5 text-[13px] leading-none text-[var(--ink2)] enabled:hover:bg-[var(--line2)] disabled:text-[var(--line)]"
            >
              ↷
            </button>
          </div>

          {/* change history (誰がいつ何を変えたか) */}
          <button
            onClick={() => setHistoryOpen(true)}
            title="このシートの変更履歴（誰がいつ何を変えたか）"
            className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            変更履歴
          </button>

          {/* as-of stepper (week view only) — view a past week's recorded plan.
              No banner; the blue 基準 line + this label indicate the as-of week. */}
          {viewMode === 'week' && (
            <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
              <button
                className="px-2.5 py-1.5 text-[14px] leading-none text-[var(--ink2)] hover:bg-[var(--line2)]"
                title="前の週の計画（断面）へ"
                onClick={stepBack}
              >
                ‹
              </button>
              <span
                className={cn(
                  'whitespace-nowrap px-2.5 text-[12px]',
                  live ? 'text-[var(--ink2)]' : 'font-medium text-[#34507A]',
                )}
              >
                {asOfLabel}
              </span>
              <button
                className="px-2.5 py-1.5 text-[14px] leading-none text-[var(--ink2)] hover:bg-[var(--line2)]"
                title="次の週へ"
                onClick={stepFwd}
              >
                ›
              </button>
              {!live && (
                <button
                  className="border-l border-[var(--line)] px-2 py-1.5 text-[11px] text-[var(--green-d)] hover:bg-[var(--line2)]"
                  title="今日に戻る"
                  onClick={backToToday}
                >
                  今日
                </button>
              )}
            </div>
          )}

          {/* week / month view */}
          <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
            {VIEW_MODES.map((v) => (
              <button
                key={v.m}
                onClick={() => setViewMode(v.m)}
                title={v.m === 'month' ? '月単位（4〜5週の合計）で表示' : '週単位で表示'}
                className={cn(
                  'px-3.5 py-1.5 text-[12px]',
                  viewMode === v.m
                    ? 'bg-[var(--green)] font-medium text-white'
                    : 'text-[var(--ink2)] hover:bg-[var(--line2)]',
                )}
              >
                {v.label}
              </button>
            ))}
          </div>

          {/* dependency lines toggle (先行→後段の依存・逆ザヤを線で表示) */}
          <button
            onClick={() => setShowDepLines((v) => !v)}
            title="タスク依存（先行→後段）を線で表示。逆ザヤ（後段が先行の完了前に開始）は赤線。"
            className={cn(
              'rounded-[9px] border px-3 py-1.5 text-[12px]',
              showDepLines
                ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
                : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink2)] hover:bg-[var(--line2)]',
            )}
          >
            依存線
          </button>

          {/* frozen columns 通常/最小 toggle (列数はシート設定) */}
          <button
            onClick={() => setPinsCollapsed((c) => !c)}
            title="固定列を通常／最小に切替（固定する列数はシート設定で指定。最小は狭い画面向け）"
            className={cn(
              'rounded-[9px] border px-3 py-1.5 text-[12px]',
              pinsCollapsed
                ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
                : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink2)] hover:bg-[var(--line2)]',
            )}
          >
            固定列: {pinsCollapsed ? '最小' : '通常'}
          </button>

          {/* hide completed */}
          <button
            onClick={() => setHideDone((v) => !v)}
            title={
              doneFilter?.column_id && doneFilter.values?.length
                ? `「完了とみなす条件」に一致する行を隠す（${doneFilter.values.join('・')}）`
                : 'ステータスが「完了」の行を隠す（シート設定で条件を変更できます）'
            }
            className={cn(
              'rounded-[9px] border px-3 py-1.5 text-[12px]',
              hideDone
                ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
                : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink2)] hover:bg-[var(--line2)]',
            )}
          >
            完了を隠す
          </button>

          {/* this week only */}
          <button
            onClick={() => setThisWeekOnly((v) => !v)}
            title="今週に稼働のあるタスクだけ表示"
            className={cn(
              'rounded-[9px] border px-3 py-1.5 text-[12px]',
              thisWeekOnly
                ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
                : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink2)] hover:bg-[var(--line2)]',
            )}
          >
            今週のみ
          </button>

          {/* full-text search (all columns) */}
          <SearchBox value={search} onChange={setSearch} />

          {/* Active-filter indicator + clear-all (絞り込みは各列の見出しから) */}
          {anyColFilter && (
            <button
              onClick={() => setColFilters({})}
              title="すべての列の絞り込みを解除"
              className="flex items-center gap-1 rounded-[9px] border border-[var(--green)] bg-[var(--green-l)]/15 px-2.5 py-1.5 text-[12px] text-[var(--green-d)] hover:bg-[var(--green-l)]/30"
            >
              絞り込み {visibleRows.length}/{grid.rows.length}
              <XIcon className="h-[13px] w-[13px]" />
            </button>
          )}
          {/* Say WHY a row that does not match is on screen, so the count and the
              grid never look like they disagree. */}
          {filtersActive && newRowIds.length > 0 && (
            <button
              onClick={() => setNewRowIds([])}
              title="追加した行の常時表示をやめる（絞り込みに合わない行は隠れます）"
              className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
            >
              追加した {newRowIds.length} 行を表示中 ×
            </button>
          )}

          {/* 既定の表示: one click back to the saved filter/sort (or to nothing). */}
          <DefaultViewButton
            hasDefault={defaultView != null}
            onReset={resetView}
            onSave={saveAsDefault}
            onClear={() => {
              setDefaultView(null)
              toast.show('既定の表示を削除しました', 'info', 2000)
            }}
          />

          <Button size="sm" onClick={newRow}>
            <PlusIcon className="h-[15px] w-[15px]" />
            新規行
          </Button>
          <Avatar name={user?.name} seed={user?.id} size="sm" />
        </div>
      </div>

      {asOfMissing && (
        <div className="mx-[22px] mb-1 rounded-[8px] border border-[#E4C9A8] bg-[#FBF3E6] px-3 py-1.5 text-[11.5px] text-[#8A5A1E]">
          {fmtMD(lineWeek ?? new Date())} 週の記録は残っていません（週次スナップショットの保存開始より前）。
          {grid.asOfActualWeek
            ? `残っている最古の記録（${fmtMD(parseDate(grid.asOfActualWeek))} 週）を表示しています。`
            : '現在の状態を表示しています。'}
        </div>
      )}

      <Legend rows={grid.rows} defaultMilestones={defaultMilestones} />

      {/* Board */}
      <div className="flex min-h-0 flex-1 flex-col px-[22px] pb-5">
        {grid.loading ? (
          <GridSkeleton />
        ) : grid.rows.length === 0 ? (
          <EmptyState
            title="まだタスクがありません"
            body="このシートはこれから作るところです。1件追加して週ごとの予定工数を入れるか、すでにExcelで管理しているなら、シート設定から取り込めます。"
            actions={
              <>
                <Button size="sm" onClick={newRow}>
                  <PlusIcon className="h-[15px] w-[15px]" />
                  最初のタスクを追加
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/sheets/${sheetId}/settings`)}
                >
                  シート設定（列・Excel取込）
                </Button>
              </>
            }
          />
        ) : visibleRows.length === 0 ? (
          <EmptyState
            title="条件に一致するタスクがありません"
            body="絞り込みや検索の条件を緩めると表示されます。"
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => applyView(EMPTY_VIEW)}
              >
                絞り込みをすべて解除
              </Button>
            }
          />
        ) : (
          <GanttGrid
            sheetId={sheetId}
            rows={visibleRows}
            columns={grid.columns}
            members={members}
            weeks={grid.weeks}
            monthStart={grid.monthStart}
            lineIndex={lineIndex}
            live={live}
            weekColWidth={colW}
            viewMode={viewMode}
            editable={live}
            pinnedCount={pinnedCount}
            showDepLines={showDepLines}
            viewedWeekIso={viewedWeekIso}
            scrollStorageKey={live ? k(`scroll:${viewMode}`) : undefined}
            focusRowId={focusRowId}
            focusNonce={focusNonce}
            colFilters={colFilters}
            filterOptions={filterOptions}
            sort={sort}
            onSortChange={setSort}
            onColFilterChange={(colId, next) =>
              setColFilters((f) => {
                const c = { ...f }
                if (next === undefined) delete c[colId]
                else c[colId] = next
                return c
              })
            }
            onSaveWeek={saveWeek}
            onBulkSaveWeeks={saveWeeksBulk}
            onEditRowCell={saveRowCell}
            onEditRowKey={saveRowKey}
            onEditMilestones={setMilestoneRow}
            onOpenRecord={(r) => setRecordRowId(String(r.id))}
            onAddChild={addChild}
            onEditProgress={saveProgress}
            onEditDeps={setDepRow}
            onDeleteRow={deleteRow}
          />
        )}
        <div className="mt-2 px-1 text-[11.5px] text-[var(--ink3)]">
          セルはクリックで入力（Enter保存／Esc取消）。ドラッグで範囲選択 → Ctrl+C / Ctrl+V
          でコピー・貼り付け、Delete でまとめて消去。Ctrl+Z で元に戻せます。
        </div>
      </div>

      {milestoneRow && (
        <MilestoneEditor
          row={milestoneRow}
          defaults={defaultMilestones}
          startColId={schedStartCol?.id}
          endColId={schedEndCol?.id}
          onClose={() => setMilestoneRow(null)}
        />
      )}

      {depRow && (
        <DependencyEditor
          row={depRow}
          candidates={depCandidates}
          sheetId={sheetId}
          onClose={() => setDepRow(null)}
        />
      )}

      {recordRow && (
        <RecordModal
          row={recordRow}
          columns={grid.columns}
          members={members}
          rows={rawRows}
          computedValue={computedValue}
          onClose={() => setRecordRowId(null)}
          onSaveCell={(colId, v) => rowMut.mutate({ row: recordRow, patch: { [colId]: v } })}
          onSaveKey={(v) => saveRowKey(recordRow, v)}
          onDelete={() => {
            setRecordRowId(null)
            deleteRow(recordRow)
          }}
        />
      )}

      {historyOpen && (
        <HistoryPanel
          scope={{ kind: 'sheet', sheetId, name: sheetName }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </>
  )
}


// (sheet title editor below)
/** Inline-editable sheet title in the top bar. */
function SheetTitleInline({ sheetId, name }: { sheetId: string; name: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (!editing) setVal(name)
  }, [name, editing])
  useEffect(() => {
    if (editing) {
      ref.current?.focus()
      ref.current?.select()
      done.current = false
    }
  }, [editing])

  function commit() {
    if (done.current) return
    done.current = true
    const next = val.trim()
    setEditing(false)
    if (!next || next === name) return
    api
      .updateSheet(sheetId, { name: next })
      .then(() => qc.invalidateQueries({ queryKey: ['sheets'] }))
      .catch(() => {
        /* TODO: toast on failure */
      })
  }

  if (editing) {
    return (
      <Input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
        className="w-[260px] py-1 text-[18px] font-semibold"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="クリックでシート名を編集"
      className="rounded text-left text-[18px] font-semibold hover:bg-[var(--line2)]"
    >
      {name}
    </button>
  )
}
