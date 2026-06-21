import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useScheduleData } from '@/hooks/useScheduleData'
import type { ScheduleRowModel, ViewMode } from '@/hooks/useScheduleData'
import { useEffortMutation } from '@/hooks/useEffortMutation'
import { useRowMutation } from '@/hooks/useRowMutation'
import * as api from '@/api/client'
import { GanttGrid } from '@/components/schedule/GanttGrid'
import type { WeekEdit } from '@/components/schedule/GanttGrid'
import { Legend } from '@/components/schedule/Legend'
import { MilestoneEditor } from '@/components/schedule/MilestoneEditor'
import { DependencyEditor } from '@/components/schedule/DependencyEditor'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { FilterIcon, PlusIcon, SearchIcon, XIcon } from '@/components/ui/icons'
import { useAuth } from '@/hooks/useAuth'
import { addWeeks, fmtISO, fmtMD, startOfWeek } from '@/lib/dates'
import { cn } from '@/lib/format'
import type { CellValue, Column, Row } from '@/types/api'

const VIEW_MODES: Array<{ m: ViewMode; label: string }> = [
  { m: 'week', label: '週' },
  { m: 'month', label: '月' },
]
const WEEK_W = 22 // weekly column width (px)
const MONTH_W = 52 // monthly column width (px)

interface Props {
  sheetId: string
  sheetName: string
}

export function SchedulePage({ sheetId, sheetName }: Props) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const weekStartWeekday = useWeekStartWeekday()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])

  const [viewMode, setViewMode] = useState<ViewMode>('week')
  const colW = viewMode === 'month' ? MONTH_W : WEEK_W
  // as-of stepping: 0 = today (live); negative offset = weeks back. Lets the
  // user view a past week's recorded plan (週次スナップショット). Week view only.
  const [asOfOffset, setAsOfOffset] = useState(0)
  // Optional range extension (weeks) before / after the default ~3yr window.
  const [extraBefore, setExtraBefore] = useState(0)
  const [extraAfter, setExtraAfter] = useState(0)
  const RANGE_STEP = 26 // ~half a year per click
  const [milestoneRow, setMilestoneRow] = useState<Row | null>(null)
  const [depRow, setDepRow] = useState<Row | null>(null)
  const [showDepLines, setShowDepLines] = useState(false)
  // Filters: per-column value filters (configured in settings) + full-text
  // search + quick toggles (hide-done / this-week-only).
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [thisWeekOnly, setThisWeekOnly] = useState(false)
  const [pinsCollapsed, setPinsCollapsed] = useState(false)
  const [showFilter, setShowFilter] = useState(false)

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
    extraBefore,
    extraAfter,
    viewMode,
  })

  const { weeks, currentWeekIdx } = grid
  const lineIndex = live ? currentWeekIdx : Math.max(0, currentWeekIdx + asOfOffset)

  // Frozen-column count: 2-stage 通常/最小 (configured on the sheet settings
  // page; both can extend through the summary columns up to 進捗).
  const sheetSettings = grid.detail?.sheet.settings
  const colCount = grid.columns.length
  const freezeMax = colCount + 4
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
  const rowMut = useRowMutation(sheetId)

  const memberName = useMemo(
    () => new Map(members.map((m) => [String(m.id), m.name])),
    [members],
  )
  const resolveColValue = useCallback(
    (r: (typeof grid.rows)[number], col: Column): string => {
      if (col.type === 'member') return memberName.get(String(r.row.data[col.id] ?? '')) ?? ''
      if (col.type === 'status') {
        // Match the grid display: auto-status shows the derived badge, otherwise
        // the stored value wins (falling back to the derived status badge).
        if (col.config?.auto_from_milestones) return r.status?.label ?? ''
        const stored = r.row.data[col.id]
        if (stored != null && stored !== '') return String(stored)
        return r.status?.label ?? ''
      }
      const v = r.row.data[col.id]
      return v == null ? '' : String(v)
    },
    [memberName],
  )

  // Status columns — for the 完了を隠す toggle.
  const statusCols = useMemo(
    () => grid.columns.filter((c) => c.type === 'status'),
    [grid.columns],
  )

  // Columns offered in the 絞り込み panel (configured in sheet settings; default
  // = member + status columns).
  const filterCols = useMemo(() => {
    const byId = new Map(grid.columns.map((c) => [String(c.id), c]))
    const ids = sheetSettings?.filter_columns
    if (ids && ids.length)
      return ids.map((id) => byId.get(String(id))).filter(Boolean) as Column[]
    return grid.columns.filter((c) => c.type === 'member' || c.type === 'status')
  }, [grid.columns, sheetSettings])

  const filtersActive =
    search.trim() !== '' ||
    hideDone ||
    thisWeekOnly ||
    Object.values(colFilters).some((v) => v)

  const visibleRows = useMemo(() => {
    if (!filtersActive) return grid.rows
    const q = search.trim().toLowerCase()
    const colById = new Map(grid.columns.map((c) => [String(c.id), c]))
    const colEntries = Object.entries(colFilters).filter(([, v]) => v)
    const match = (r: (typeof grid.rows)[number]) => {
      for (const [colId, val] of colEntries) {
        const col = colById.get(String(colId))
        if (col && resolveColValue(r, col) !== val) return false
      }
      if (hideDone && statusCols.some((c) => resolveColValue(r, c) === '完了')) return false
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
    // Keep parent/child integrity: include a matched row, plus its parent and —
    // when a parent matches — its subtasks (so the roll-up stays meaningful).
    const matched = new Set<string>()
    for (const r of grid.rows) if (match(r)) matched.add(String(r.row.id))
    const show = new Set<string>(matched)
    for (const r of grid.rows) {
      const id = String(r.row.id)
      if (matched.has(id) && r.parentRowId) show.add(r.parentRowId)
      if (r.parentRowId && matched.has(r.parentRowId)) show.add(id)
    }
    return grid.rows.filter((r) => show.has(String(r.row.id)))
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
    statusCols,
  ])

  function stepBack() {
    if (currentWeekIdx + asOfOffset > 1) setAsOfOffset((o) => o - 1)
  }
  function stepFwd() {
    if (asOfOffset < 0) setAsOfOffset((o) => o + 1)
  }
  function backToToday() {
    setAsOfOffset(0)
  }

  function saveWeek(edit: WeekEdit) {
    // Month view: the edited "week" is a month column. Distribute the entered
    // total evenly across that month's weeks (remainder on the first week),
    // writing the same field (past month → actual, else planned).
    if (viewMode === 'month' && grid.monthWeeks) {
      const weeksOfMonth = grid.monthWeeks.get(edit.weekStart) ?? [edit.weekStart]
      const n = weeksOfMonth.length || 1
      const total = edit.value ?? 0
      const share = Math.round((total / n) * 100) / 100
      weeksOfMonth.forEach((ws, i) => {
        const value =
          total === 0
            ? null
            : i === 0
              ? Math.round((total - share * (n - 1)) * 100) / 100
              : share
        effortMut.mutate({ rowId: edit.rowId, weekStart: ws, field: edit.field, value })
      })
      return
    }
    effortMut.mutate({
      rowId: edit.rowId,
      weekStart: edit.weekStart,
      field: edit.field,
      value: edit.value,
    })
  }

  function saveRowCell(row: Row, colId: string, value: CellValue) {
    const col = grid.columns.find((c) => String(c.id) === String(colId))
    const patch: Record<string, CellValue> = { [colId]: value }
    // Weekly-reset columns: stamp the current week so the value shows this week
    // and clears next week (visible again when stepping back to this week).
    if (col?.config?.weekly_reset) patch[`__wk_${colId}`] = currentWeekIso
    rowMut.mutate({ row, patch })
  }

  function saveRowKey(row: Row, key: string) {
    rowMut.mutate({ row, patch: {}, keyValue: key })
  }

  function saveProgress(row: Row, value: number | null) {
    rowMut.mutate({ row, patch: {}, progress: value })
  }

  // Candidate predecessor tasks for the dependency picker.
  const depCandidates = useMemo(
    () => grid.rows.map((r) => ({ id: r.row.id, key_value: r.keyValue, title: r.title })),
    [grid.rows],
  )

  function newRow() {
    api
      .createRow(sheetId, { data: {} })
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
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
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
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

          {/* range extension */}
          <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
            <button
              className="px-2.5 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
              title="表示範囲をさらに前へ広げる"
              onClick={() => setExtraBefore((n) => n + RANGE_STEP)}
            >
              ◀ もっと前
            </button>
            <span className="border-l border-[var(--line)]" />
            <button
              className="px-2.5 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
              title="表示範囲をさらに後へ広げる"
              onClick={() => setExtraAfter((n) => n + RANGE_STEP)}
            >
              もっと後 ▶
            </button>
          </div>

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
            title="ステータスが「完了」の行を隠す"
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
          <div className="flex items-center gap-1 rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2">
            <SearchIcon className="h-[14px] w-[14px] flex-shrink-0 text-[var(--ink3)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="検索（全列）"
              className="w-[150px] bg-transparent py-1.5 text-[12px] outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="flex-shrink-0 text-[var(--ink3)] hover:text-[var(--ink)]"
                title="検索クリア"
              >
                <XIcon className="h-[14px] w-[14px]" />
              </button>
            )}
          </div>

          <div className="relative">
            <Button
              variant={Object.values(colFilters).some((v) => v) ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setShowFilter((s) => !s)}
            >
              <FilterIcon className="h-[15px] w-[15px]" />
              絞り込み
              {filtersActive && (
                <span className="ml-0.5 rounded-full bg-white/25 px-1.5 text-[10px]">
                  {visibleRows.length}/{grid.rows.length}
                </span>
              )}
            </Button>
            {showFilter && (
              <FilterPopover
                filterCols={filterCols}
                rows={grid.rows}
                colFilters={colFilters}
                resolveValue={resolveColValue}
                onChange={(colId, value) =>
                  setColFilters((f) => ({ ...f, [colId]: value }))
                }
                onClear={() => setColFilters({})}
                onClose={() => setShowFilter(false)}
              />
            )}
          </div>
          <Button size="sm" onClick={newRow}>
            <PlusIcon className="h-[15px] w-[15px]" />
            新規行
          </Button>
          <Avatar name={user?.name} seed={user?.id} size="sm" />
        </div>
      </div>

      <Legend rows={grid.rows} defaultMilestones={defaultMilestones} />

      {/* Board */}
      <div className="flex min-h-0 flex-1 flex-col px-[22px] pb-5">
        {grid.loading ? (
          <div className="flex flex-1 items-center justify-center rounded-[14px] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink3)]">
            読み込み中…
          </div>
        ) : (
          <GanttGrid
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
            onSaveWeek={saveWeek}
            onEditRowCell={saveRowCell}
            onEditRowKey={saveRowKey}
            onEditMilestones={setMilestoneRow}
            onAddChild={addChild}
            onEditProgress={saveProgress}
            onEditDeps={setDepRow}
            onDeleteRow={deleteRow}
          />
        )}
        <div className="mt-2 px-1 text-[11.5px] text-[var(--ink3)]">
          値のある所だけフェーズ色で塗る（ゼロは無色）。◇は境界＝マイルストン、節目超過は遅延色、変化点（今週の断面から変更）は文字色。右上「週/月」で表示単位を切替（月＝その月の合計、月セルに入力するとその月の各週へ均等に分割）。セルはクリックで直接入力（Enter/離れて保存、Escで取消）。
        </div>
      </div>

      {milestoneRow && (
        <MilestoneEditor
          row={milestoneRow}
          defaults={defaultMilestones}
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

function FilterPopover({
  filterCols,
  rows,
  colFilters,
  resolveValue,
  onChange,
  onClear,
  onClose,
}: {
  filterCols: Column[]
  rows: ScheduleRowModel[]
  colFilters: Record<string, string>
  resolveValue: (r: ScheduleRowModel, col: Column) => string
  onChange: (colId: string, value: string) => void
  onClear: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [onClose])

  // Distinct values present for each configured filter column.
  const optionsByCol = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const col of filterCols) {
      const set = new Set<string>()
      for (const r of rows) {
        const v = resolveValue(r, col)
        if (v) set.add(v)
      }
      m.set(String(col.id), [...set].sort((a, b) => a.localeCompare(b, 'ja')))
    }
    return m
  }, [filterCols, rows, resolveValue])

  return (
    <div
      ref={ref}
      className="absolute right-0 z-40 mt-1.5 w-[260px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12.5px] font-semibold">絞り込み</span>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-[var(--ink3)] hover:bg-[var(--line2)]"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
      {filterCols.length === 0 ? (
        <p className="mb-2 text-[11.5px] text-[var(--ink3)]">
          絞り込みに使う列が未設定です。シート設定で指定してください。
        </p>
      ) : (
        filterCols.map((col) => (
          <label key={col.id} className="mb-2 block text-[11.5px] text-[var(--ink2)]">
            {col.name}
            <Select
              className="mt-1 w-full"
              value={colFilters[String(col.id)] ?? ''}
              onChange={(e) => onChange(String(col.id), e.target.value)}
            >
              <option value="">（すべて）</option>
              {(optionsByCol.get(String(col.id)) ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </label>
        ))
      )}
      <div className="mt-1 flex justify-between">
        <Button variant="ghost" size="sm" onClick={onClear}>
          クリア
        </Button>
        <Button size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </div>
  )
}
