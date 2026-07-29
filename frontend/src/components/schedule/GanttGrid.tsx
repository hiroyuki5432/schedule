// The continuous weekly gantt grid.
//
//  Layout = three horizontal zones inside one scroll container:
//   1. PINNED (sticky-left): ID (key_value + milestone/delete) + 件名 (title).
//      Only these stay put during horizontal scroll, so the gantt stays usable
//      on narrow viewports.
//   2. ATTR block (scrolls): 担当 / ステータス / custom columns / 予定計.
//   3. WEEK area (scrolls, virtualized): ~1yr of thin weekly columns.
//  Colored cells = phase color where hours > 0; numbers overlaid; change-points
//  in accent color; milestone diamonds at boundaries; today/as-of line.
//  Clicking a week cell turns it into an inline <input>; Enter/blur saves.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import { InlineCell } from '@/components/schedule/InlineCell'
import { ColumnHeaderMenu } from '@/components/schedule/ColumnHeaderMenu'
import { filterKindOf } from '@/lib/colFilter'
import type { ColFilter, ColFilterOptions } from '@/lib/colFilter'
import { defaultColWidth, fitWidth, useColumnWidths } from '@/lib/colWidth'
import { useLookupTargets } from '@/hooks/useLookupTargets'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { DiamondIcon, PlusIcon, TrashIcon } from '@/components/ui/icons'
import { cn, fmtHours, normalizeDateForSort } from '@/lib/format'
import { toast } from '@/lib/toast'
import { fmtISO, fmtMD, parseDate } from '@/lib/dates'
import type { WeekCell } from '@/lib/gantt'
import type { StatusBadge } from '@/lib/status'
import type { CellValue, Column, Member, Row } from '@/types/api'

const ROW_H = 38
const FOOT_H = 34 // sticky 週計 (per-week totals) footer
const YEAR_H = 18 // year band above the month numbers
const MONTH_H = 28 // month-number band
const HEAD_H = YEAR_H + MONTH_H
const ID_W = 176 // key_value + ◇ milestone + tree toggle + dep / add / delete buttons
const TOTAL_W = 60 // 予定計 column
const ACTUAL_W = 60 // 実績計 column
const DIFF_W = 60 // 差（予定−実績）column
const PROG_W = 66 // 進捗 column (手入力%、ビハインド色)
const PACE_W = 70 // 予実差 column (進捗 − 予定上の想定%、前倒し/遅延)

// The trailing summary columns. They follow the attribute columns and can be
// frozen too: the freeze count covers [attribute cols…, summary cols…], so the
// freeze can extend up to 進捗.
const SUMMARY_COLS = [
  { key: 'plan', w: TOTAL_W, label: '予定計' },
  { key: 'actual', w: ACTUAL_W, label: '実績計' },
  { key: 'diff', w: DIFF_W, label: '差' },
  { key: 'prog', w: PROG_W, label: '進捗' },
  { key: 'pace', w: PACE_W, label: '予実差' },
] as const
type SummaryDescriptor = (typeof SUMMARY_COLS)[number]

/** Round to 1 decimal for compact hour totals. */
const round1 = (x: number) => Math.round(x * 10) / 10

/** Human delay text from an actual−planned day count (+ = late). */
function delayText(delay: number | null): string {
  if (delay == null) return ''
  if (delay > 0) return `${delay}日 遅れ`
  if (delay < 0) return `${-delay}日 前倒し`
  return '予定通り'
}

/** Escape user-entered text before it goes into the tooltip's innerHTML.
 *  Task IDs / phase names are free text, so an unescaped 「<img onerror=…>」 would
 *  otherwise run on hover. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Milestone tooltip: planned vs actual date + delay (plain text). */
function milestoneTip(cell: WeekCell): string {
  if (!cell.milestoneMarker && !cell.milestoneActual) return ''
  const p = cell.msPlannedDate ? fmtMD(parseDate(cell.msPlannedDate)) : '—'
  const label = cell.phaseLabel ? `${cell.phaseLabel}：` : ''
  if (cell.msActualDate) {
    const a = fmtMD(parseDate(cell.msActualDate))
    return `${label}予定 ${p} ／ 実績 ${a}（${delayText(cell.msDelayDays)}）`
  }
  return `${label}予定 ${p}（${cell.milestoneDone ? '達成' : '未達成'}）`
}

// ---- Client-side sorting (Feature 1) ----------------------------------------
type SortDir = 'asc' | 'desc'
// A column key is the column id, or the synthetic ID (key_value) key.
type SortKey = string
const SORT_ID: SortKey = '__id__'

export interface SortState {
  key: SortKey
  dir: SortDir
}

/** Resolve the comparable value for a row under a given sort key. */
function sortValueFor(
  model: ScheduleRowModel,
  key: SortKey,
  column: Column | undefined,
  members: Member[],
  lookupValue: (column: Column, row: Row) => string | null,
): string | number {
  if (key === SORT_ID) return model.keyValue ?? ''
  // Summary columns (予定計/実績計/差/進捗/予実差) are computed, not real columns —
  // sort by their derived numbers. '' sorts empty rows last.
  switch (key) {
    case 'plan':
      return model.gantt.plannedSum
    case 'actual':
      return model.gantt.actualSum
    case 'diff':
      return model.gantt.plannedSum - model.gantt.actualSum
    case 'prog':
      return model.progress ?? ''
    case 'pace': {
      const hasPlan = model.gantt.plannedSum > 0
      return model.progress != null && hasPlan
        ? model.progress - model.expectedPct * 100
        : ''
    }
  }
  if (!column) return ''
  if (column.type === 'status') {
    // Sort by the resolved/display badge label.
    return model.status?.label ?? ''
  }
  if (column.type === 'member') {
    const id = model.row.data[column.id]
    const m = members.find((x) => String(x.id) === String(id ?? ''))
    return m?.name ?? ''
  }
  if (column.type === 'lookup') {
    return lookupValue(column, model.row) ?? ''
  }
  const v = model.row.data[column.id]
  if (v == null || v === '') return ''
  if (column.type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  // Date columns: treat a literal placeholder dash as empty so 「-」 sorts last.
  if (column.type === 'date') return normalizeDateForSort(v)
  return String(v)
}

function compareValues(a: string | number, b: string | number): number {
  // Empty values sort last regardless of direction handling at the call site.
  const aEmpty = a === '' || a == null
  const bEmpty = b === '' || b == null
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'ja')
}

function SortArrow({ dir }: { dir: SortDir | null }) {
  if (!dir) return null
  return <span className="ml-0.5 text-[9px] leading-none">{dir === 'asc' ? '▲' : '▼'}</span>
}

/** Display string for a cell, used only to measure content width. */
function measureValue(
  c: Column,
  r: ScheduleRowModel,
  members: Member[],
  lookupValue: (column: Column, row: Row) => string | null,
): string {
  if (c.type === 'member') {
    const id = r.row.data[c.id]
    return members.find((m) => String(m.id) === String(id ?? ''))?.name ?? ''
  }
  if (c.type === 'status') return r.status?.label ?? ''
  if (c.type === 'lookup') return lookupValue(c, r.row) ?? ''
  const v = r.row.data[c.id]
  return v == null ? '' : String(v)
}

export interface WeekEdit {
  rowId: string
  weekStart: string
  field: 'planned_hours' | 'actual_hours'
  value: number | null
  /** The value before this edit — lets the page offer 元に戻す (Ctrl+Z). */
  prev: number | null
}

/** A cell address in the week area (row id + week index). */
interface CellRef {
  rowId: string
  wi: number
}

/** The selected rectangle, as display-row and week index bounds (inclusive). */
interface SelRect {
  r0: number
  r1: number
  w0: number
  w1: number
}

/** How many week columns to render beyond the viewport on each side. */
const WEEK_OVERSCAN = 6

interface Props {
  rows: ScheduleRowModel[]
  columns: Column[]
  members: Member[]
  weeks: Date[]
  monthStart: boolean[]
  lineIndex: number
  live: boolean
  weekColWidth: number
  /** 'month' aggregates columns into calendar months (cosmetic labels here). */
  viewMode?: 'week' | 'month'
  editable: boolean
  /** How many leading attribute columns stay frozen next to the ID. */
  pinnedCount: number
  /** Draw predecessor→successor dependency lines over the gantt (toggle). */
  showDepLines: boolean
  /** Week being viewed (live or as-of) — for weekly-reset column display. */
  viewedWeekIso?: string
  /** localStorage key to persist/restore the horizontal scroll position. When set
   *  (live view), reopening the sheet resumes the last scroll instead of today. */
  scrollStorageKey?: string
  /** Notification deep-link: scroll to + briefly highlight this task (row id). */
  focusRowId?: string | null
  /** Changes on each notification click so re-clicking the same task re-flashes. */
  focusNonce?: number
  /** Excel-style header filters: current per-column selections + option metadata
   *  (built from the UNFILTERED rows) + a change handler. Keyed by column id. */
  colFilters: Record<string, ColFilter>
  filterOptions: Map<string, ColFilterOptions>
  onColFilterChange: (colId: string, next: ColFilter | undefined) => void
  /** Sort lives on the page (persisted per sheet) so filtering — which can briefly
   *  unmount this grid when nothing matches — never silently drops it
   *  (要望: 昇順のあとに絞り込むと並びが戻る). */
  sort: SortState | null
  onSortChange: (next: SortState | null) => void
  onSaveWeek: (edit: WeekEdit) => void
  /** Range paste / range clear — written in one request instead of per cell. */
  onBulkSaveWeeks: (edits: WeekEdit[]) => void
  onEditRowCell: (row: Row, colId: string, value: CellValue) => void
  onEditRowKey: (row: Row, key: string) => void
  onEditMilestones: (row: Row) => void
  /** Add a subtask (子タスク) under this top-level task. */
  onAddChild: (parentRow: Row) => void
  /** Save the manual progress % for a leaf task (null clears). */
  onEditProgress: (row: Row, value: number | null) => void
  /** Open the dependency (先行タスク) editor for a row. */
  onEditDeps: (row: Row) => void
  onDeleteRow: (row: Row) => void
}

interface EditingCell {
  rowId: string
  wi: number
  /** Typed character that opened the editor (Excel-style type-to-replace). */
  seed?: string
}

export function GanttGrid({
  rows,
  columns,
  members,
  weeks,
  monthStart,
  lineIndex,
  live,
  weekColWidth,
  viewMode = 'week',
  editable,
  pinnedCount,
  showDepLines,
  viewedWeekIso,
  scrollStorageKey,
  focusRowId,
  focusNonce,
  colFilters,
  filterOptions,
  onColFilterChange,
  sort,
  onSortChange,
  onSaveWeek,
  onBulkSaveWeeks,
  onEditRowCell,
  onEditRowKey,
  onEditMilestones,
  onAddChild,
  onEditProgress,
  onEditDeps,
  onDeleteRow,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const didScrollRef = useRef(false)
  // The hover tooltip is driven through a ref, NOT state: it used to be a
  // useState set from every week cell's onMouseMove, which re-rendered the whole
  // grid (all virtual rows × all visible week columns) on every pointer move —
  // the main reason the board felt heavy once the sheet grew.
  const tipRef = useRef<HTMLDivElement>(null)
  const showTip = useCallback((x: number, y: number, html: string) => {
    const el = tipRef.current
    if (!el) return
    el.innerHTML = html
    el.style.transform = `translate(${x}px, ${y}px)`
    el.style.visibility = 'visible'
  }, [])
  const hideTip = useCallback(() => {
    const el = tipRef.current
    if (el) el.style.visibility = 'hidden'
  }, [])
  const [editing, setEditing] = useState<EditingCell | null>(null)
  // Excel-style range selection over the week cells: an anchor plus a moving
  // focus corner. Drag with the mouse, extend with Shift+arrows.
  const [sel, setSel] = useState<{ anchor: CellRef; focus: CellRef } | null>(null)
  // Set while the mouse is down inside the week area. `moved` (set once the
  // pointer reaches a DIFFERENT cell) distinguishes a plain click — which opens
  // the editor, the long-standing behaviour — from a drag, which selects a range.
  const dragRef = useRef<{ start: CellRef; moved: boolean } | null>(null)
  // Transient highlight for a notification-focused task (cleared after a few s).
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // Which column header menu is open (column id, or SORT_ID for the ID column).
  const [openMenu, setOpenMenu] = useState<SortKey | null>(null)
  // Collapsed parents (子タスクを畳む). Empty = all expanded.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (rowId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) next.delete(rowId)
      else next.add(rowId)
      return next
    })

  const ordered = useMemo(
    () => [...columns].sort((a, b) => a.order - b.order),
    [columns],
  )
  const { lookupValue } = useLookupTargets(columns, members)

  // Content-fit column widths: size each attribute column to its longest value
  // (header included), clamped per type so nothing gets too wide or too narrow.
  const colWidths = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of ordered)
      m.set(
        c.id,
        fitWidth(
          c,
          rows.map((r) => measureValue(c, r, members, lookupValue)),
        ),
      )
    return m
  }, [ordered, rows, members, lookupValue])

  // Manual width overrides (drag the column edge, double-click to reset).
  // Persisted per column id; a column without an override falls back to its
  // content-fit width above.
  const { colW, startResize, resetWidth } = useColumnWidths()
  const cw = (c: Column) => colW[c.id] ?? colWidths.get(c.id) ?? defaultColWidth(c)

  // Tree display order: top-level tasks (client-sortable) each followed by their
  // subtasks (子タスク, key_value asc) when expanded. Subtasks always stay grouped
  // under their parent; sorting only reorders the top level.
  const displayRows = useMemo(() => {
    const childrenOf = new Map<string, ScheduleRowModel[]>()
    const top: ScheduleRowModel[] = []
    for (const r of rows) {
      if (r.parentRowId) {
        const arr = childrenOf.get(r.parentRowId) ?? []
        arr.push(r)
        childrenOf.set(r.parentRowId, arr)
      } else {
        top.push(r)
      }
    }
    for (const arr of childrenOf.values())
      arr.sort((a, b) => compareValues(a.keyValue, b.keyValue))

    let sortedTop = top
    if (sort) {
      const column = columns.find((c) => c.id === sort.key)
      const dir = sort.dir === 'asc' ? 1 : -1
      sortedTop = [...top].sort((a, b) => {
        const av = sortValueFor(a, sort.key, column, members, lookupValue)
        const bv = sortValueFor(b, sort.key, column, members, lookupValue)
        const cmp = compareValues(av, bv)
        if (cmp === 0) return 0
        const aEmpty = av === '' || av == null
        const bEmpty = bv === '' || bv == null
        if (aEmpty || bEmpty) return cmp
        return cmp * dir
      })
    }

    const out: ScheduleRowModel[] = []
    const emitted = new Set<string>()
    for (const p of sortedTop) {
      out.push(p)
      emitted.add(String(p.row.id))
      if (p.hasChildren && !collapsed.has(String(p.row.id))) {
        out.push(...(childrenOf.get(String(p.row.id)) ?? []))
      }
    }
    // Safety: children whose parent isn't in this list (e.g. filtered out) are
    // shown standalone so they're never lost.
    for (const [pid, kids] of childrenOf)
      if (!emitted.has(pid)) out.push(...kids)
    return out
  }, [rows, sort, columns, members, lookupValue, collapsed])

  // Explicit sort from a header menu (昇順/降順/解除). null clears.
  function setSortDir(key: SortKey, dir: SortDir | null) {
    onSortChange(dir ? { key, dir } : null)
  }
  const dirFor = (key: SortKey): SortDir | null =>
    sort?.key === key ? sort.dir : null
  const toggleMenu = (key: SortKey) =>
    setOpenMenu((cur) => (cur === key ? null : key))

  // Plain rows (for status option lists) + lookup resolver for lookup columns.
  const plainRows = useMemo(() => displayRows.map((r) => r.row), [displayRows])
  // Freezable sequence = [attribute columns…, summary columns…]. The first
  // `pinnedCount` of them stay frozen next to the ID; the rest scroll. So the
  // freeze can reach the summary columns (予定計…進捗) once all attrs are frozen.
  const N = ordered.length
  const pinCount = Math.max(0, Math.min(pinnedCount, N + SUMMARY_COLS.length))
  const pinAttrCount = Math.min(pinCount, N)
  const pinSummaryCount = Math.max(0, pinCount - N)
  const pinnedCols = useMemo(() => ordered.slice(0, pinAttrCount), [ordered, pinAttrCount])
  const scrollCols = useMemo(() => ordered.slice(pinAttrCount), [ordered, pinAttrCount])
  const pinnedSummary = SUMMARY_COLS.slice(0, pinSummaryCount)
  const scrollSummary = SUMMARY_COLS.slice(pinSummaryCount)
  // The status column auto-derives its badge from milestones (Feature 6) when
  // its config opts in; then the gantt shows the computed badge read-only.
  const autoStatusColId = useMemo(
    () =>
      ordered.find((c) => c.type === 'status' && c.config?.auto_from_milestones)
        ?.id ?? null,
    [ordered],
  )

  const pinnedW =
    ID_W +
    pinnedCols.reduce((s, c) => s + cw(c), 0) +
    pinnedSummary.reduce((s, c) => s + c.w, 0)
  const attrW =
    scrollCols.reduce((s, c) => s + cw(c), 0) +
    scrollSummary.reduce((s, c) => s + c.w, 0)

  const rowVirt = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  })

  // ---- Week-column virtualization -------------------------------------------
  // Rows were already virtualized, but every visible row still painted ~3 years
  // of week cells, so the DOM grew with (visible rows × weeks). We now render
  // only the weeks inside the viewport. The week area starts at pinnedW + attrW
  // in scroll-content coordinates, and the frozen columns cover the leftmost
  // `pinnedW` pixels of the viewport, so both offsets enter the calculation.
  const [weekRange, setWeekRange] = useState<[number, number]>([0, 0])
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const recompute = () => {
      raf = 0
      const gridLeft = pinnedW + attrW
      const viewLeft = el.scrollLeft + pinnedW
      const viewRight = el.scrollLeft + el.clientWidth
      const start = Math.max(
        0,
        Math.floor((viewLeft - gridLeft) / weekColWidth) - WEEK_OVERSCAN,
      )
      const end = Math.min(
        weeks.length,
        Math.ceil((viewRight - gridLeft) / weekColWidth) + WEEK_OVERSCAN,
      )
      setWeekRange((prev) =>
        prev[0] === start && prev[1] === end ? prev : [start, Math.max(start, end)],
      )
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(recompute)
    }
    recompute()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [pinnedW, attrW, weekColWidth, weeks.length])

  /** Week indices currently worth rendering (viewport + overscan). */
  const visibleWeeks = useMemo(() => {
    const out: number[] = []
    for (let i = weekRange[0]; i < weekRange[1]; i++) out.push(i)
    return out
  }, [weekRange])

  /** Scroll horizontally so a week column is not hidden behind the frozen area. */
  const ensureWeekVisible = useCallback(
    (wi: number) => {
      const el = scrollRef.current
      if (!el) return
      const cellLeft = pinnedW + attrW + wi * weekColWidth
      const cellRight = cellLeft + weekColWidth
      const viewLeft = el.scrollLeft + pinnedW
      const viewRight = el.scrollLeft + el.clientWidth
      if (cellLeft < viewLeft) el.scrollLeft = cellLeft - pinnedW - 8
      else if (cellRight > viewRight) el.scrollLeft = cellRight - el.clientWidth + 8
    },
    [pinnedW, attrW, weekColWidth],
  )

  const gridW = weeks.length * weekColWidth
  const totalW = pinnedW + attrW + gridW
  const totalH = displayRows.length * ROW_H

  // ---- Cell selection, keyboard navigation and clipboard ---------------------
  const rowIndexById = useMemo(() => {
    const m = new Map<string, number>()
    displayRows.forEach((r, i) => m.set(String(r.row.id), i))
    return m
  }, [displayRows])

  /** Can this cell take a typed value? Past weeks hold 実績 (entered on 日報),
   *  and in month view a parent's cell is a read-only roll-up of its subtasks. */
  const isCellEditable = useCallback(
    (m: ScheduleRowModel, wi: number) =>
      editable && wi >= lineIndex && (viewMode === 'week' || !m.hasChildren),
    [editable, lineIndex, viewMode],
  )

  const selRect: SelRect | null = useMemo(() => {
    if (!sel) return null
    const a = rowIndexById.get(String(sel.anchor.rowId))
    const b = rowIndexById.get(String(sel.focus.rowId))
    if (a == null || b == null) return null
    return {
      r0: Math.min(a, b),
      r1: Math.max(a, b),
      w0: Math.min(sel.anchor.wi, sel.focus.wi),
      w1: Math.max(sel.anchor.wi, sel.focus.wi),
    }
  }, [sel, rowIndexById])

  const selCount = selRect
    ? (selRect.r1 - selRect.r0 + 1) * (selRect.w1 - selRect.w0 + 1)
    : 0

  /** The number a cell currently shows: 実績 for past weeks, 予定 from now on. */
  const shownValue = useCallback(
    (m: ScheduleRowModel, wi: number): number | null => {
      const cell = m.gantt.cells[wi]
      if (!cell) return null
      const past = wi < lineIndex && live
      const v = past ? cell.actual : cell.planned
      return v ? round1(v) : null
    },
    [lineIndex, live],
  )

  /** Turn a value the user typed into what gets stored. On a parent task the
   *  entered number is the combined (親＋子) total, so we store the parent's own
   *  share; a leaf stores the number as-is. */
  const toStored = useCallback(
    (m: ScheduleRowModel, wi: number, value: number | null): number | null => {
      if (!m.hasChildren || value == null) return value
      const childSum = m.childPlannedByWeek?.get(fmtISO(weeks[wi])) ?? 0
      return Math.max(0, round1(value - childSum))
    },
    [weeks],
  )

  /** Build the write for one cell, including the value it had before (for undo).
   *
   *  Both `value` and `prev` are in STORED space (a parent's own share), not the
   *  combined 親＋子 number the cell displays — undo writes `prev` straight back,
   *  so mixing the two would inflate a parent by its children's hours. */
  const buildEdit = useCallback(
    (m: ScheduleRowModel, wi: number, value: number | null): WeekEdit => {
      const past = wi < lineIndex && live
      const field = past ? 'actual_hours' : 'planned_hours'
      const cell = m.gantt.cells[wi]
      const shown = past ? cell?.actual : cell?.planned
      const toStore = (v: number | null) =>
        field === 'planned_hours' ? toStored(m, wi, v) : v
      return {
        rowId: m.row.id,
        weekStart: fmtISO(weeks[wi]),
        field,
        value: toStore(value),
        prev: shown ? toStore(round1(shown)) : null,
      }
    },
    [weeks, toStored, lineIndex, live],
  )

  /** Build the writes for a whole operation (range paste / range clear).
   *
   *  A parent's cell shows 親＋子 combined, and buildEdit stores `entered −
   *  現在の子合計`. When the SAME operation also rewrites that parent's subtasks,
   *  the child total is about to change, so using the current one would leave the
   *  parent displaying entered + (child delta) instead of what was pasted. This
   *  nets out that delta so the parent lands on the number the user actually
   *  entered. */
  const buildEdits = useCallback(
    (cells: Array<{ m: ScheduleRowModel; wi: number; value: number | null }>): WeekEdit[] => {
      const childDelta = new Map<string, number>()
      for (const { m, wi, value } of cells) {
        if (!m.parentRowId) continue
        const before = m.gantt.cells[wi]?.planned ?? 0
        const key = `${m.parentRowId}|${wi}`
        childDelta.set(key, (childDelta.get(key) ?? 0) + ((value ?? 0) - before))
      }
      return cells.map(({ m, wi, value }) => {
        const edit = buildEdit(m, wi, value)
        if (!m.hasChildren || edit.value == null || edit.field !== 'planned_hours') return edit
        const delta = childDelta.get(`${String(m.row.id)}|${wi}`) ?? 0
        if (delta === 0) return edit
        return { ...edit, value: Math.max(0, round1(edit.value - delta)) }
      })
    },
    [buildEdit],
  )

  /** Move (or, with `extend`, grow) the selection by one cell. */
  const moveSelection = useCallback(
    (dir: 'up' | 'down' | 'left' | 'right', extend: boolean) => {
      if (!sel) return
      const idx = rowIndexById.get(String(sel.focus.rowId))
      if (idx == null) return
      const dr = dir === 'down' ? 1 : dir === 'up' ? -1 : 0
      const dw = dir === 'right' ? 1 : dir === 'left' ? -1 : 0
      const r = Math.max(0, Math.min(displayRows.length - 1, idx + dr))
      const w = Math.max(0, Math.min(weeks.length - 1, sel.focus.wi + dw))
      const focus: CellRef = { rowId: String(displayRows[r].row.id), wi: w }
      setSel(extend ? { anchor: sel.anchor, focus } : { anchor: focus, focus })
      ensureWeekVisible(w)
      rowVirt.scrollToIndex(r)
    },
    [sel, rowIndexById, displayRows, weeks.length, ensureWeekVisible, rowVirt],
  )

  // Spreadsheet-style cell navigation: from the currently-edited week cell, move
  // to the next editable cell in `dir` (Tab/Shift+Tab/arrows/Enter). Skips
  // non-editable cells (past weeks, parent rows in month view); stops at the grid
  // edge by closing the editor.
  const moveEditing = useCallback(
    (from: EditingCell, dir: 'up' | 'down' | 'left' | 'right') => {
      const curIdx = rowIndexById.get(String(from.rowId))
      if (curIdx == null) {
        setEditing(null)
        return
      }
      const stepRow = dir === 'down' ? 1 : dir === 'up' ? -1 : 0
      const stepCol = dir === 'right' ? 1 : dir === 'left' ? -1 : 0
      let r = curIdx
      let w = from.wi
      // Guard against runaway loops; the grid is finite anyway.
      for (let guard = 0; guard < 100000; guard++) {
        r += stepRow
        w += stepCol
        if (r < 0 || r >= displayRows.length || w < 0 || w >= weeks.length) break
        const m = displayRows[r]
        if (isCellEditable(m, w)) {
          setEditing({ rowId: m.row.id, wi: w })
          setSel({
            anchor: { rowId: String(m.row.id), wi: w },
            focus: { rowId: String(m.row.id), wi: w },
          })
          ensureWeekVisible(w)
          rowVirt.scrollToIndex(r)
          return
        }
      }
      setEditing(null)
    },
    [rowIndexById, displayRows, weeks.length, isCellEditable, ensureWeekVisible, rowVirt],
  )

  /** Clear every editable cell in the selection (Delete/Backspace). */
  const clearSelection = useCallback(() => {
    if (!selRect || !editable) return
    const cells: Array<{ m: ScheduleRowModel; wi: number; value: number | null }> = []
    for (let r = selRect.r0; r <= selRect.r1; r++) {
      const m = displayRows[r]
      for (let w = selRect.w0; w <= selRect.w1; w++) {
        if (!isCellEditable(m, w)) continue
        if (shownValue(m, w) == null) continue
        cells.push({ m, wi: w, value: null })
      }
    }
    if (cells.length === 0) return
    const edits = buildEdits(cells)
    onBulkSaveWeeks(edits)
    toast.show(`${edits.length}セルを空にしました（Ctrl+Z で元に戻せます）`, 'info', 3000)
  }, [
    selRect,
    editable,
    displayRows,
    isCellEditable,
    shownValue,
    buildEdits,
    onBulkSaveWeeks,
  ])

  /** Copy the selection as TSV so it pastes straight into Excel. */
  const handleCopy = useCallback(
    (e: React.ClipboardEvent) => {
      if (!selRect || editing) return
      const lines: string[] = []
      for (let r = selRect.r0; r <= selRect.r1; r++) {
        const m = displayRows[r]
        const cells: string[] = []
        for (let w = selRect.w0; w <= selRect.w1; w++) {
          const v = shownValue(m, w)
          cells.push(v == null ? '' : String(v))
        }
        lines.push(cells.join('\t'))
      }
      e.clipboardData.setData('text/plain', lines.join('\n'))
      e.preventDefault()
      toast.show(`${selCount}セルをコピーしました`, 'info', 2000)
    },
    [selRect, editing, displayRows, shownValue, selCount],
  )

  /** Paste TSV (from this grid or from Excel) starting at the selection's
   *  top-left. Cells that can't take a value — past weeks, parent roll-ups in
   *  month view — are skipped rather than silently dropping the whole paste. */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!selRect || editing || !editable) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      const matrix = text
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => line.split('\t'))

      const cells: Array<{ m: ScheduleRowModel; wi: number; value: number | null }> = []
      let skipped = 0
      for (let dr = 0; dr < matrix.length; dr++) {
        const r = selRect.r0 + dr
        if (r >= displayRows.length) break
        const m = displayRows[r]
        for (let dc = 0; dc < matrix[dr].length; dc++) {
          const w = selRect.w0 + dc
          if (w >= weeks.length) break
          if (!isCellEditable(m, w)) {
            skipped++
            continue
          }
          const raw = matrix[dr][dc].trim()
          if (raw === '') {
            cells.push({ m, wi: w, value: null })
            continue
          }
          const n = Number(raw)
          if (!Number.isFinite(n)) {
            skipped++
            continue
          }
          cells.push({ m, wi: w, value: n })
        }
      }
      const edits = buildEdits(cells)
      if (edits.length === 0) {
        toast.show('貼り付けできるセルがありませんでした（過去週は日報から入力します）', 'warn')
        return
      }
      onBulkSaveWeeks(edits)
      // Grow the selection to cover what was actually pasted.
      const lastRow = Math.min(displayRows.length - 1, selRect.r0 + matrix.length - 1)
      const widest = Math.max(...matrix.map((row) => row.length))
      const lastWeek = Math.min(weeks.length - 1, selRect.w0 + widest - 1)
      setSel({
        anchor: { rowId: String(displayRows[selRect.r0].row.id), wi: selRect.w0 },
        focus: { rowId: String(displayRows[lastRow].row.id), wi: lastWeek },
      })
      toast.show(
        skipped > 0
          ? `${edits.length}セルに貼り付けました（${skipped}セルは入力できないためスキップ）`
          : `${edits.length}セルに貼り付けました（Ctrl+Z で元に戻せます）`,
        skipped > 0 ? 'warn' : 'info',
        3500,
      )
    },
    [
      selRect,
      editing,
      editable,
      displayRows,
      weeks.length,
      isCellEditable,
      buildEdits,
      onBulkSaveWeeks,
    ],
  )

  /** Keyboard handling for the grid when no cell editor is open. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return
      // Let the page-level Ctrl+Z / Ctrl+Y and the browser's own copy/paste
      // shortcuts through — those arrive as copy/paste events instead.
      if (e.ctrlKey || e.metaKey) return
      if (!sel) return
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault()
          const dir =
            e.key === 'ArrowUp'
              ? 'up'
              : e.key === 'ArrowDown'
                ? 'down'
                : e.key === 'ArrowLeft'
                  ? 'left'
                  : 'right'
          moveSelection(dir, e.shiftKey)
          return
        }
        case 'Enter':
        case 'F2': {
          const idx = rowIndexById.get(String(sel.focus.rowId))
          if (idx == null) return
          const m = displayRows[idx]
          if (!isCellEditable(m, sel.focus.wi)) return
          e.preventDefault()
          setEditing({ rowId: m.row.id, wi: sel.focus.wi })
          return
        }
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          clearSelection()
          return
        case 'Escape':
          e.preventDefault()
          setSel(null)
          return
      }
      // Typing a number opens the editor seeded with that character, like Excel.
      if (e.key.length === 1 && /[0-9.]/.test(e.key)) {
        const idx = rowIndexById.get(String(sel.focus.rowId))
        if (idx == null) return
        const m = displayRows[idx]
        if (!isCellEditable(m, sel.focus.wi)) return
        e.preventDefault()
        setEditing({ rowId: m.row.id, wi: sel.focus.wi, seed: e.key })
      }
    },
    [
      editing,
      sel,
      moveSelection,
      rowIndexById,
      displayRows,
      isCellEditable,
      clearSelection,
    ],
  )

  // Mouse-down inside the week area starts either a click (open the editor on
  // mouse-up) or a drag-select. The window listener also catches a mouse-up
  // outside the grid so a drag can never get stuck on.
  const beginCellDrag = useCallback(
    (m: ScheduleRowModel, wi: number, shiftKey: boolean) => {
      const ref: CellRef = { rowId: String(m.row.id), wi }
      setSel((prev) =>
        shiftKey && prev ? { anchor: prev.anchor, focus: ref } : { anchor: ref, focus: ref },
      )
      dragRef.current = { start: ref, moved: false }
    },
    [],
  )

  useEffect(() => {
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [])

  // 週計 (Feature 2): per-week column totals + grand totals, over the rows
  // currently shown (= filter-aware, since `rows` is the filtered set). Parents
  // now carry a 合算 roll-up (own + children), so we count each parent's roll-up
  // and SKIP its shown subtasks (already inside that roll-up) to avoid double-
  // counting. Childless tasks and orphan subtasks (parent filtered out) are
  // counted directly. Uses `rows` (not the collapse-filtered display list) so
  // collapsed parents still contribute their subtasks via the roll-up.
  const footTotals = useMemo(() => {
    const planned = new Array(weeks.length).fill(0)
    const actual = new Array(weeks.length).fill(0)
    let plannedSum = 0
    let actualSum = 0
    const presentParentIds = new Set(
      rows.filter((m) => m.hasChildren).map((m) => String(m.row.id)),
    )
    for (const m of rows) {
      if (m.parentRowId && presentParentIds.has(m.parentRowId)) continue
      m.gantt.cells.forEach((c, wi) => {
        if (!c) return
        planned[wi] += c.planned
        actual[wi] += c.actual
      })
      plannedSum += m.gantt.plannedSum
      actualSum += m.gantt.actualSum
    }
    return { planned, actual, plannedSum, actualSum }
  }, [rows, weeks.length])

  // Dependency connector lines (predecessor finish → successor start). Y is
  // deterministic from the display index (fixed row height), so lines draw even
  // for virtualized rows. Red + backward = 逆ザヤ (its length shows the overlap).
  const depLines = useMemo(() => {
    if (!showDepLines) return []
    const idxById = new Map(displayRows.map((m, i) => [String(m.row.id), i]))
    const out: Array<{ x1: number; y1: number; x2: number; y2: number; violation: boolean }> = []
    for (const m of displayRows) {
      const sIdx = m.startIdx
      const succIndex = idxById.get(String(m.row.id))
      if (sIdx == null || succIndex == null) continue
      for (const pid of (m.row.depends_on ?? []) as Array<string | number>) {
        const pIndex = idxById.get(String(pid))
        if (pIndex == null) continue
        const pm = displayRows[pIndex]
        if (pm.finishIdx == null) continue
        out.push({
          x1: (pm.finishIdx + 1) * weekColWidth,
          y1: pIndex * ROW_H + ROW_H / 2,
          x2: sIdx * weekColWidth,
          y2: succIndex * ROW_H + ROW_H / 2,
          violation: sIdx < pm.finishIdx,
        })
      }
    }
    return out
  }, [showDepLines, displayRows, weekColWidth])

  const monthSpans = useMemo(() => {
    const spans: Array<{ startIdx: number; span: number; month: number }> = []
    let i = 0
    while (i < weeks.length) {
      let j = i + 1
      while (j < weeks.length && !monthStart[j]) j++
      spans.push({ startIdx: i, span: j - i, month: weeks[i].getMonth() + 1 })
      i = j
    }
    return spans
  }, [weeks, monthStart])

  // Year band (Feature 3): contiguous spans of weeks sharing a calendar year.
  const yearSpans = useMemo(() => {
    const spans: Array<{ startIdx: number; span: number; year: number }> = []
    let i = 0
    while (i < weeks.length) {
      const year = weeks[i].getFullYear()
      let j = i + 1
      while (j < weeks.length && weeks[j].getFullYear() === year) j++
      spans.push({ startIdx: i, span: j - i, year })
      i = j
    }
    return spans
  }, [weeks])

  const lineXInGrid = lineIndex * weekColWidth

  // On first load, restore the last horizontal scroll position (要望: 前回の表示位置
  // から開始) when one is saved; otherwise scroll so "today" is visible.
  //
  // Assigning scrollLeft only sticks once the scroll content is actually wide
  // enough; on a fresh mount the week area is still being laid out, so an early
  // assignment gets CLAMPED (often to 0). We therefore retry over a few frames
  // until the value takes, and — critically — refuse to persist anything until
  // the restore has finished, otherwise the clamped 0 overwrites the saved
  // position and the view is back at the far left on every return to the sheet.
  useLayoutEffect(() => {
    if (didScrollRef.current) return
    const el = scrollRef.current
    if (!el || displayRows.length === 0 || lineIndex < 0) return

    // A saved position of exactly 0 (scrolled all the way left) is a real,
    // valid position — `> 0` treated it as "nothing saved" and fell back to the
    // "today" default, which is exactly the revert the report described.
    const rawSaved = scrollStorageKey ? localStorage.getItem(scrollStorageKey) : null
    const saved = rawSaved == null ? NaN : Number(rawSaved)
    const target = Number.isFinite(saved) && saved >= 0 ? saved : Math.max(0, attrW + lineXInGrid - 200)

    let frames = 0
    let raf = 0
    const apply = () => {
      raf = 0
      // NOTE: checking "did scrollLeft land where I just set it" is a trap —
      // the browser ALWAYS clamps the assignment to the CURRENT [0, max], so a
      // too-early frame (layout not settled: column widths still mid-measurement,
      // 担当 members not loaded yet, etc.) reads back as a perfect match against
      // its own (too-small) max and looks "done" on the very first frame. The
      // only real signal that layout has caught up is the container actually
      // being WIDE ENOUGH to hold the target without clamping.
      const max = Math.max(0, el.scrollWidth - el.clientWidth)
      el.scrollLeft = target
      if (max >= target || frames > 20) {
        didScrollRef.current = true
        return
      }
      frames += 1
      raf = requestAnimationFrame(apply)
    }
    apply()
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [displayRows.length, attrW, lineIndex, lineXInGrid, scrollStorageKey])

  // Persist the horizontal scroll position (debounced) so it can be restored.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !scrollStorageKey) return
    let t: number | undefined
    const onScroll = () => {
      // Ignore the scroll events the restore itself produces.
      if (!didScrollRef.current) return
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        try {
          localStorage.setItem(scrollStorageKey, String(el.scrollLeft))
        } catch {
          /* storage unavailable — ignore */
        }
      }, 200)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.clearTimeout(t)
    }
  }, [scrollStorageKey])

  // Notification deep-link: scroll the focused task into view and flash it.
  useEffect(() => {
    if (!focusRowId) return
    // If the target is a subtask hidden under a collapsed parent, expand it first
    // (this effect re-runs once displayRows includes the child).
    const target = rows.find((r) => String(r.row.id) === String(focusRowId))
    if (target?.parentRowId && collapsed.has(target.parentRowId)) {
      setCollapsed((prev) => {
        const next = new Set(prev)
        next.delete(target.parentRowId!)
        return next
      })
      return
    }
    const idx = displayRows.findIndex((m) => String(m.row.id) === String(focusRowId))
    if (idx < 0) return
    rowVirt.scrollToIndex(idx, { align: 'center' })
    // Bring the task's bars into view horizontally too (its first planned week).
    const m = displayRows[idx]
    if (m.startIdx != null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, attrW + m.startIdx * weekColWidth - 200)
    }
    setHighlightId(String(focusRowId))
    const t = window.setTimeout(() => setHighlightId(null), 3500)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRowId, focusNonce, displayRows, collapsed, rows])

  const lineColor = live ? 'var(--today)' : 'var(--asof)'
  // Caption shares the line's color so the marker and label read as one unit.
  const capColor = lineColor
  const capLabel = live
    ? `今日 ${fmtMD(weeks[lineIndex] ?? new Date())}`
    : `基準 ${fmtMD(weeks[lineIndex] ?? new Date())}`

  const isMonth = viewMode === 'month'
  function tooltipFor(model: ScheduleRowModel, cell: WeekCell, wi: number): string {
    const planned = cell.planned ?? 0
    const actual = cell.actual ?? 0
    const diff = round1(planned - actual)
    const chg =
      cell.changed && live
        ? `<br><span style="color:#F2B8A0">● ${isMonth ? '前月' : '前週'}から変更</span>`
        : ''
    // Milestone segment label (no marker detail here — that goes on its own line).
    const phase = cell.phaseLabel ? ` ・ ${esc(cell.phaseLabel)}` : ''
    const when = isMonth
      ? `${weeks[wi].getFullYear()}/${weeks[wi].getMonth() + 1}月`
      : `週 ${fmtMD(weeks[wi])}`
    // Milestone planned-vs-actual line when this cell carries a diamond.
    const tip = milestoneTip(cell)
    const ms = tip
      ? `<br><span style="color:${cell.msDelayDays && cell.msDelayDays > 0 ? '#F2B8A0' : '#CFE0D7'}">◇ ${esc(tip)}</span>`
      : ''
    return `<b style="font-weight:600">${esc(model.keyValue)}</b>${phase}<br>${when}<br>予定 ${round1(planned)}h ／ 実績 ${round1(actual)}h ／ 差 ${diff > 0 ? '+' : ''}${diff}h${chg}${ms}`
  }

  return (
    <div className="relative flex-1 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)]">
      <div
        ref={scrollRef}
        // tabIndex makes the grid focusable so arrow keys, Delete and the
        // native copy/paste events reach it. outline-none because the selection
        // rectangle already shows where the keyboard is.
        tabIndex={0}
        role="grid"
        aria-label="週次工数グリッド"
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onPaste={handlePaste}
        className="h-full overflow-auto outline-none"
      >
        <div className="relative" style={{ width: totalW, height: HEAD_H + totalH + FOOT_H }}>
          {/* ---- Header (sticky top) ---- */}
          <div
            className="sticky top-0 z-30 flex bg-[#F4F1E8]"
            style={{ height: HEAD_H, width: totalW }}
          >
            {/* pinned header (menu: ID sort-only + frozen attribute columns) */}
            <div
              className="sticky left-0 z-40 flex flex-shrink-0 items-center border-r border-[var(--line)] bg-[#F4F1E8]"
              style={{ width: pinnedW, height: HEAD_H }}
            >
              <IdHead
                open={openMenu === SORT_ID}
                sortDir={dirFor(SORT_ID)}
                onToggleMenu={() => toggleMenu(SORT_ID)}
                onSort={(dir) => setSortDir(SORT_ID, dir)}
              />
              {pinnedCols.map((c) => (
                <AttrHead
                  key={c.id}
                  col={c}
                  width={cw(c)}
                  sortDir={dirFor(c.id)}
                  filter={colFilters[String(c.id)]}
                  options={filterOptions.get(String(c.id))}
                  open={openMenu === c.id}
                  onToggleMenu={() => toggleMenu(c.id)}
                  onSort={(dir) => setSortDir(c.id, dir)}
                  onFilter={(next) => onColFilterChange(String(c.id), next)}
                  onResizeStart={(e) => startResize(e, c.id, cw(c))}
                  onResizeReset={() => resetWidth(c.id)}
                />
              ))}
              <SummaryHeads
                cols={pinnedSummary}
                openMenu={openMenu}
                dirFor={dirFor}
                onToggleMenu={toggleMenu}
                onSort={setSortDir}
              />
            </div>
            {/* attr headers (scroll; menu = sort + filter) */}
            <div className="flex flex-shrink-0" style={{ width: attrW, height: HEAD_H }}>
              {scrollCols.map((c) => (
                <AttrHead
                  key={c.id}
                  col={c}
                  width={cw(c)}
                  sortDir={dirFor(c.id)}
                  filter={colFilters[String(c.id)]}
                  options={filterOptions.get(String(c.id))}
                  open={openMenu === c.id}
                  onToggleMenu={() => toggleMenu(c.id)}
                  onSort={(dir) => setSortDir(c.id, dir)}
                  onFilter={(next) => onColFilterChange(String(c.id), next)}
                  onResizeStart={(e) => startResize(e, c.id, cw(c))}
                  onResizeReset={() => resetWidth(c.id)}
                />
              ))}
              <SummaryHeads
                cols={scrollSummary}
                openMenu={openMenu}
                dirFor={dirFor}
                onToggleMenu={toggleMenu}
                onSort={setSortDir}
              />
            </div>
            {/* year band (top) + month spans (below) + today caption */}
            <div className="relative" style={{ width: gridW, height: HEAD_H }}>
              {/* year band */}
              <div className="flex" style={{ height: YEAR_H }}>
                {yearSpans.map((s) => (
                  <div
                    key={s.startIdx}
                    className={cn(
                      'flex h-full flex-shrink-0 items-center justify-center border-b border-[var(--line2)] text-[10.5px] font-semibold text-[var(--ink2)]',
                      s.startIdx > 0 && 'border-l border-[var(--line)]',
                    )}
                    style={{ width: s.span * weekColWidth }}
                  >
                    {s.year}
                  </div>
                ))}
              </div>
              {/* month band */}
              <div className="flex" style={{ height: MONTH_H }}>
                {monthSpans.map((s) => (
                  <div
                    key={s.startIdx}
                    className={cn(
                      'flex h-full flex-shrink-0 items-center justify-center text-[11px] text-[var(--ink3)]',
                      s.startIdx > 0 && 'border-l border-[var(--line)]',
                    )}
                    style={{ width: s.span * weekColWidth }}
                  >
                    {s.month}
                  </div>
                ))}
              </div>
              {lineIndex >= 0 && (
                // Pinned to the TOP of the header (year band) so it never spills
                // into the first data row. z-20 keeps it BELOW the frozen
                // header (z-40) so it can't overlap the pinned columns when the
                // today column scrolls near the freeze boundary.
                <div
                  className="pointer-events-none absolute top-0 z-20 -translate-x-1/2 whitespace-nowrap rounded-[5px] border border-[var(--line)] bg-[var(--surface)] px-1 text-[10px] font-medium leading-[15px]"
                  style={{ left: lineXInGrid, color: capColor }}
                >
                  {capLabel}
                </div>
              )}
            </div>
            <div className="absolute inset-x-0 bottom-0 border-b border-[var(--line)]" />
          </div>

          {/* ---- Body rows ---- */}
          {rowVirt.getVirtualItems().map((vRow) => {
            const model = displayRows[vRow.index]
            const odd = vRow.index % 2 === 1
            // Notification-focused task: tint the whole row + a green left accent.
            const isFocus = highlightId != null && String(model.row.id) === highlightId
            const rowBg = isFocus
              ? 'bg-[#FCEFD0]'
              : odd
                ? 'bg-[#FCFBF7]'
                : 'bg-[var(--surface)]'
            const isChild = model.depth === 1
            return (
              <div
                key={model.row.id}
                className={cn(
                  'group/row absolute left-0 flex border-b border-[var(--line2)] transition-colors duration-300',
                  isFocus ? 'bg-[#FCEFD0]' : odd && 'bg-[#FCFBF7]',
                )}
                style={{ top: HEAD_H + vRow.start, height: ROW_H, width: totalW }}
              >
                {/* pinned: ID + title */}
                <div
                  className={cn(
                    'sticky left-0 z-20 flex flex-shrink-0 items-center border-r border-[var(--line)] transition-colors duration-300',
                    rowBg,
                  )}
                  style={{
                    width: pinnedW,
                    height: ROW_H,
                    boxShadow: isFocus ? 'inset 3px 0 0 var(--green)' : undefined,
                  }}
                >
                  <div
                    className="flex items-center gap-0.5 overflow-hidden px-2 text-[12.5px] font-semibold"
                    style={{ width: ID_W, paddingLeft: isChild ? 16 : undefined }}
                  >
                    {/* tree toggle (parent) / indent (child / leaf top-level) */}
                    {!isChild && model.hasChildren ? (
                      <button
                        type="button"
                        title={
                          collapsed.has(String(model.row.id))
                            ? 'サブタスクを展開'
                            : 'サブタスクを折りたたむ'
                        }
                        onClick={() => toggleCollapse(String(model.row.id))}
                        className="flex h-5 w-4 flex-shrink-0 items-center justify-center rounded text-[9px] text-[var(--ink3)] hover:bg-[var(--line2)] hover:text-[var(--ink)]"
                      >
                        {collapsed.has(String(model.row.id)) ? '▶' : '▼'}
                      </button>
                    ) : (
                      <span className="w-4 flex-shrink-0" />
                    )}
                    <button
                      type="button"
                      title="フェーズ（マイルストン）を編集"
                      aria-label="フェーズ（マイルストン）を編集"
                      onClick={() => onEditMilestones(model.row)}
                      className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--green)] hover:bg-[var(--line2)] hover:text-[var(--green-d)]"
                    >
                      <DiamondIcon className="h-[12px] w-[12px]" />
                    </button>
                    <EditableKey
                      value={model.keyValue}
                      editable={editable}
                      onSave={(k) => onEditRowKey(model.row, k)}
                    />
                    {model.hasChildren && (
                      <span
                        className="flex-shrink-0 rounded bg-[var(--line2)] px-1 text-[9.5px] font-medium text-[var(--ink3)]"
                        title={`サブタスク ${model.childCount}件`}
                      >
                        {model.childCount}
                      </span>
                    )}
                    {(() => {
                      const depCount = model.row.depends_on?.length ?? 0
                      const viol = model.depViolations.length > 0
                      const show = depCount > 0 || viol
                      return (
                        <button
                          type="button"
                          onClick={() => onEditDeps(model.row)}
                          title={
                            viol
                              ? `逆ザヤ: ${model.depViolations
                                  .map((v) => `${v.predKey} の完了前に開始（${v.weeks}週）`)
                                  .join(' / ')}`
                              : depCount > 0
                                ? `先行タスク ${depCount}件（クリックで編集）`
                                : '先行タスク（依存）を設定'
                          }
                          className={cn(
                            'flex h-5 flex-shrink-0 items-center gap-0.5 rounded px-1 text-[10px]',
                            viol
                              ? 'bg-[#FAE6E0] font-semibold text-[#A8442B]'
                              : show
                                ? 'text-[var(--ink3)] hover:bg-[var(--line2)]'
                                : 'text-[var(--ink3)] opacity-0 hover:bg-[var(--line2)] group-hover/row:opacity-100',
                          )}
                        >
                          {viol ? (
                            <span className="leading-none">⚠{model.depViolations.length}</span>
                          ) : (
                            <>
                              <LinkGlyph />
                              {depCount > 0 && <span className="font-medium">{depCount}</span>}
                            </>
                          )}
                        </button>
                      )
                    })()}
                    {editable && !isChild && (
                      <button
                        type="button"
                        title="子タスク（サブタスク）を追加"
                        onClick={() => onAddChild(model.row)}
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--green)] opacity-0 transition-opacity hover:bg-[var(--line2)] hover:text-[var(--green-d)] group-hover/row:opacity-100"
                      >
                        <PlusIcon className="h-[12px] w-[12px]" />
                      </button>
                    )}
                    {editable && (
                      <button
                        type="button"
                        title="行を削除"
                        onClick={() => onDeleteRow(model.row)}
                        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--ink3)] opacity-0 transition-opacity hover:bg-[#FAE6E0] hover:text-[#A8442B] group-hover/row:opacity-100"
                      >
                        <TrashIcon className="h-[12px] w-[12px]" />
                      </button>
                    )}
                  </div>
                  {pinnedCols.map((c) => (
                    <div key={c.id} className="h-full overflow-hidden" style={{ width: cw(c) }}>
                      <AttrCell
                        row={model.row}
                        column={c}
                        members={members}
                        rows={plainRows}
                        lookupValue={lookupValue}
                        editable={editable}
                        autoStatusBadge={
                          c.id === autoStatusColId ? model.status : undefined
                        }
                        autoStatusDelayWeeks={
                          c.id === autoStatusColId ? model.statusDelayWeeks : undefined
                        }
                        viewedWeekIso={viewedWeekIso}
                        onSave={(v) => onEditRowCell(model.row, c.id, v)}
                      />
                    </div>
                  ))}
                  <RowSummaryCells
                    cols={pinnedSummary}
                    model={model}
                    editable={editable}
                    onEditProgress={onEditProgress}
                  />
                </div>

                {/* attr block (scrolls) */}
                <div
                  className={cn('flex flex-shrink-0 items-center border-r border-[var(--line2)]', rowBg)}
                  style={{ width: attrW, height: ROW_H }}
                >
                  {scrollCols.map((c) => (
                    <div key={c.id} className="h-full overflow-hidden" style={{ width: cw(c) }}>
                      <AttrCell
                        row={model.row}
                        column={c}
                        members={members}
                        rows={plainRows}
                        lookupValue={lookupValue}
                        editable={editable}
                        autoStatusBadge={
                          c.id === autoStatusColId ? model.status : undefined
                        }
                        autoStatusDelayWeeks={
                          c.id === autoStatusColId ? model.statusDelayWeeks : undefined
                        }
                        viewedWeekIso={viewedWeekIso}
                        onSave={(v) => onEditRowCell(model.row, c.id, v)}
                      />
                    </div>
                  ))}
                  <RowSummaryCells
                    cols={scrollSummary}
                    model={model}
                    editable={editable}
                    onEditProgress={onEditProgress}
                  />
                </div>

                {/* week cells (virtualized) */}
                <div
                  className={cn(
                    'relative flex-shrink-0 transition-colors duration-300',
                    isFocus && 'bg-[#FCEFD0]',
                  )}
                  style={{ width: gridW, height: ROW_H }}
                >
                  {visibleWeeks.map((wi) => {
                    const cell = model.gantt.cells[wi]
                    // Past weeks show ACTUAL, which is now derived from 日報
                    // (work logs) — so only planned (current/future) cells are
                    // hand-editable. Actuals are entered on the 日報 page. Parent
                    // cells ARE editable (week view only): the input is the
                    // combined (親＋子) total and editing adjusts the parent's OWN
                    // part (floored so the total never drops below the children's
                    // sum). Month view keeps parents read-only (子合計は週単位のため).
                    const cellEditable = isCellEditable(model, wi)
                    const isEditing =
                      editing?.rowId === model.row.id && editing.wi === wi
                    if (isEditing) {
                      const past = wi < lineIndex && live
                      const current = past ? cell?.actual ?? 0 : cell?.planned ?? 0
                      return (
                        <WeekCellInput
                          key={wi}
                          left={wi * weekColWidth}
                          width={weekColWidth}
                          initial={current}
                          seed={editing.seed}
                          onCommitMove={(value, dir) => {
                            onSaveWeek(buildEdit(model, wi, value))
                            // Tab/arrow/Enter move to the next cell; blur closes.
                            if (dir) moveEditing({ rowId: model.row.id, wi }, dir)
                            else setEditing(null)
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      )
                    }
                    const selected =
                      selRect != null &&
                      vRow.index >= selRect.r0 &&
                      vRow.index <= selRect.r1 &&
                      wi >= selRect.w0 &&
                      wi <= selRect.w1
                    return (
                      <WeekCellView
                        key={wi}
                        cell={cell}
                        monthStart={monthStart[wi]}
                        left={wi * weekColWidth}
                        width={weekColWidth}
                        live={live}
                        editable={cellEditable}
                        selected={selected}
                        onMouseDown={(e) => {
                          // Left button only; Shift extends the existing range.
                          if (e.button !== 0) return
                          beginCellDrag(model, wi, e.shiftKey)
                        }}
                        onMouseUp={() => {
                          // A press-and-release without movement is a plain
                          // click: keep the long-standing click-to-edit.
                          if (dragRef.current && !dragRef.current.moved && cellEditable) {
                            setEditing({ rowId: model.row.id, wi })
                          }
                        }}
                        onHover={(e) => {
                          const drag = dragRef.current
                          // Only a move that REACHES ANOTHER CELL counts as a
                          // drag; jitter inside the pressed cell stays a click.
                          if (
                            drag &&
                            (drag.start.wi !== wi ||
                              drag.start.rowId !== String(model.row.id))
                          ) {
                            drag.moved = true
                            setSel((prev) =>
                              prev
                                ? {
                                    anchor: prev.anchor,
                                    focus: { rowId: String(model.row.id), wi },
                                  }
                                : prev,
                            )
                          }
                          if (!cell || ((cell.planned ?? 0) <= 0 && (cell.actual ?? 0) <= 0)) {
                            hideTip()
                            return
                          }
                          showTip(e.clientX + 14, e.clientY + 14, tooltipFor(model, cell, wi))
                        }}
                        onLeave={hideTip}
                      />
                    )
                  })}
                  {/* progress / delay bar: thin line under the task span. green =
                      progress, red = behind (expected − progress). Shows 遅れ量. */}
                  {(() => {
                    const s = model.startIdx
                    const f = model.finishIdx
                    if (s == null || f == null || model.progress == null) return null
                    if (model.gantt.plannedSum <= 0) return null
                    const x0 = s * weekColWidth
                    const spanW = (f - s + 1) * weekColWidth
                    const pf = Math.max(0, Math.min(1, model.progress / 100))
                    const ef = Math.max(0, Math.min(1, model.expectedPct))
                    return (
                      <div
                        className="pointer-events-none absolute z-[2]"
                        style={{ left: x0, bottom: 2, width: spanW, height: 3 }}
                        title={`進捗 ${model.progress}%${
                          model.behind ? `／予定比 遅れ ${Math.round((ef - pf) * 100)}pt` : '（オントラック）'
                        }`}
                      >
                        <div
                          className="absolute inset-0 rounded-full"
                          style={{ background: 'rgba(51,50,44,.10)' }}
                        />
                        <div
                          className="absolute top-0 h-full rounded-full"
                          style={{
                            left: 0,
                            width: `${pf * 100}%`,
                            background: model.behind ? '#6FA98F' : '#266B53',
                          }}
                        />
                        {model.behind && ef > pf && (
                          <div
                            className="absolute top-0 h-full rounded-full"
                            style={{
                              left: `${pf * 100}%`,
                              width: `${(ef - pf) * 100}%`,
                              background: '#A8442B',
                            }}
                          />
                        )}
                      </div>
                    )
                  })()}
                </div>
              </div>
            )
          })}

          {/* ---- Dependency lines (toggle) — SVG overlay in the week area.
              Positioned after pinned+attr so it can't paint over the frozen
              columns (which are sticky z-20 and cover it on horizontal scroll). */}
          {showDepLines && depLines.length > 0 && (
            <svg
              className="pointer-events-none absolute z-[12]"
              style={{ left: pinnedW + attrW, top: HEAD_H, width: gridW, height: totalH }}
              width={gridW}
              height={totalH}
            >
              <defs>
                <marker id="dep-a" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="var(--ink3)" />
                </marker>
                <marker id="dep-av" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#A8442B" />
                </marker>
              </defs>
              {depLines.map((l, i) => (
                <path
                  key={i}
                  d={`M ${l.x1} ${l.y1} L ${l.x2} ${l.y2}`}
                  fill="none"
                  stroke={l.violation ? '#A8442B' : 'var(--ink3)'}
                  strokeWidth={l.violation ? 1.8 : 1.3}
                  strokeDasharray={l.violation ? undefined : '3 2'}
                  markerEnd={`url(#${l.violation ? 'dep-av' : 'dep-a'})`}
                  opacity={0.85}
                />
              ))}
            </svg>
          )}

          {/* ---- Selection outline (Excel-style range) ----
              One rectangle over the whole selection rather than a border per
              cell, so the range reads as a single block. z-[13] keeps it above
              the coloured cells but below the frozen columns (z-20), which is
              what makes it disappear behind them on horizontal scroll. */}
          {selRect && (
            <div
              className="pointer-events-none absolute z-[13] rounded-[2px]"
              style={{
                left: pinnedW + attrW + selRect.w0 * weekColWidth,
                top: HEAD_H + selRect.r0 * ROW_H,
                width: (selRect.w1 - selRect.w0 + 1) * weekColWidth,
                height: (selRect.r1 - selRect.r0 + 1) * ROW_H,
                border: '2px solid var(--green)',
                boxShadow: '0 0 0 1px rgba(255,255,255,.5) inset',
              }}
            />
          )}

          {/* ---- Vertical today / as-of line (in the week area) ----
              z-10: above the colored week cells but BELOW the frozen columns
              (z-20) so it never paints over the pinned region when the today
              column scrolls behind it. 2px wide, full body height. */}
          {lineIndex >= 0 && (
            <div
              className="pointer-events-none absolute z-10"
              style={{
                left: pinnedW + attrW + lineXInGrid - 1,
                top: HEAD_H,
                width: 2,
                height: totalH,
                background: lineColor,
              }}
            />
          )}

          {/* in-flow spacer so the sticky footer's natural position is the
              bottom (the body rows above are absolutely positioned). */}
          <div aria-hidden style={{ height: totalH }} />

          {/* ---- 週計 footer (sticky bottom): per-week + grand totals over the
              rows currently shown (filter-aware) ---- */}
          <div
            className="sticky bottom-0 z-[35] flex border-t border-[var(--line)] bg-[#F4F1E8]"
            style={{ width: totalW, height: FOOT_H }}
          >
            <div
              className="sticky left-0 z-[36] flex flex-shrink-0 items-center border-r border-[var(--line)] bg-[#F4F1E8]"
              style={{ width: pinnedW, height: FOOT_H }}
            >
              <div
                className="px-2 text-[11px] font-semibold text-[var(--ink2)]"
                style={{ width: ID_W }}
                title="表示中の行の週ごとの合計（絞り込み連動／子タスクは合算、親の二重計上なし）。今日より前=実績、今週以降=予定。"
              >
                週計
              </div>
              {pinnedCols.map((c) => (
                <div key={c.id} style={{ width: cw(c) }} />
              ))}
              <FooterSummaryCells cols={pinnedSummary} footTotals={footTotals} />
            </div>
            <div
              className="flex flex-shrink-0 items-center border-r border-[var(--line2)] bg-[#F4F1E8]"
              style={{ width: attrW, height: FOOT_H }}
            >
              {scrollCols.map((c) => (
                <div key={c.id} style={{ width: cw(c) }} />
              ))}
              <FooterSummaryCells cols={scrollSummary} footTotals={footTotals} />
            </div>
            <div className="relative flex-shrink-0" style={{ width: gridW, height: FOOT_H }}>
              {visibleWeeks.map((wi) => {
                // Single line: past weeks (今日より前) show 実績, this week onward
                // (今週以降) shows 予定. Rounded to a whole number.
                const past = wi < lineIndex
                const val = Math.round(past ? footTotals.actual[wi] : footTotals.planned[wi])
                if (val <= 0) return null
                return (
                  <div
                    key={wi}
                    className={cn(
                      'absolute top-0 flex h-full items-center justify-center leading-none',
                      monthStart[wi] && 'shadow-[inset_1px_0_0_var(--line2)]',
                    )}
                    style={{ left: wi * weekColWidth, width: weekColWidth }}
                  >
                    <span
                      className="text-[9.5px] font-semibold"
                      style={{ color: past ? '#33322c' : '#8a8778' }}
                    >
                      {val}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Always mounted, moved/filled imperatively by showTip/hideTip. */}
      <div
        ref={tipRef}
        className="pointer-events-none fixed left-0 top-0 z-50 whitespace-nowrap rounded-lg bg-[var(--ink)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-white"
        style={{ visibility: 'hidden' }}
      />
    </div>
  )
}

function HeadCell({
  children,
  className,
  style,
  sortDir,
  onClick,
  hasMenu,
  filterActive,
}: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  /** Current sort direction for this column, or null when inactive. */
  sortDir?: SortDir | null
  /** When provided, the header becomes a clickable trigger (menu or sort). */
  onClick?: () => void
  /** Show a ▾ caret hinting a click opens the sort/filter menu. */
  hasMenu?: boolean
  /** Show a filled funnel when this column has an active filter. */
  filterActive?: boolean
}) {
  const base =
    'flex h-full flex-shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[11px] font-medium text-[var(--ink3)]'
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={hasMenu ? 'クリックで並べ替え・絞り込み' : 'クリックで並べ替え'}
        className={cn(
          base,
          'cursor-pointer select-none hover:text-[var(--ink2)]',
          (sortDir || filterActive) && 'text-[var(--ink)]',
          className,
        )}
        style={style}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
        <SortArrow dir={sortDir ?? null} />
        {filterActive && (
          <span className="ml-0.5 text-[9px] leading-none text-[var(--green-d)]" title="絞り込み中">
            ⏷
          </span>
        )}
        {hasMenu && !filterActive && (
          <span className="ml-0.5 text-[8px] leading-none text-[var(--ink3)]">▾</span>
        )}
      </button>
    )
  }
  return (
    <div className={cn(base, className)} style={style}>
      {children}
    </div>
  )
}

/** ID column header — sort-only menu (no filter; key_value is the row key). */
function IdHead({
  open,
  sortDir,
  onToggleMenu,
  onSort,
}: {
  open: boolean
  sortDir: SortDir | null
  onToggleMenu: () => void
  onSort: (dir: SortDir | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="relative flex-shrink-0" style={{ width: ID_W }}>
      <HeadCell style={{ width: ID_W }} sortDir={sortDir} hasMenu onClick={onToggleMenu}>
        ID
      </HeadCell>
      {open && (
        <ColumnHeaderMenu
          colName="ID"
          kind="values"
          options={{ kind: 'values', values: [], hasBlank: false, numMin: null, numMax: null }}
          filter={undefined}
          sortDir={sortDir}
          filterable={false}
          anchorRef={ref}
          onSort={onSort}
          onFilter={() => {}}
          onClose={onToggleMenu}
        />
      )}
    </div>
  )
}

/** Attribute-column header: click opens the sort + filter menu; a drag handle on
 *  the right edge resizes (double-click restores auto/content width). */
function AttrHead({
  col,
  width,
  sortDir,
  filter,
  options,
  open,
  onToggleMenu,
  onSort,
  onFilter,
  onResizeStart,
  onResizeReset,
}: {
  col: Column
  width: number
  sortDir: SortDir | null
  filter: ColFilter | undefined
  options: ColFilterOptions | undefined
  open: boolean
  onToggleMenu: () => void
  onSort: (dir: SortDir | null) => void
  onFilter: (next: ColFilter | undefined) => void
  onResizeStart: (e: React.MouseEvent) => void
  onResizeReset: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const opts: ColFilterOptions = options ?? {
    kind: filterKindOf(col),
    values: [],
    hasBlank: false,
    numMin: null,
    numMax: null,
  }
  return (
    <div ref={ref} className="relative flex-shrink-0" style={{ width }}>
      <HeadCell
        style={{ width }}
        sortDir={sortDir}
        hasMenu
        filterActive={!!filter}
        onClick={onToggleMenu}
      >
        {col.name}
      </HeadCell>
      <div
        onMouseDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="ドラッグで列幅を変更（ダブルクリックで自動幅に戻す）"
        className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[var(--green-l)]/40"
      />
      {open && (
        <ColumnHeaderMenu
          colName={col.name}
          kind={filterKindOf(col)}
          options={opts}
          filter={filter}
          sortDir={sortDir}
          filterable
          anchorRef={ref}
          onSort={onSort}
          onFilter={onFilter}
          onClose={onToggleMenu}
        />
      )}
    </div>
  )
}

/** Inline-editable row ID (key_value). Click to edit; Enter/blur saves, Esc
 *  cancels. Read-only when the grid is in as-of mode. Duplicate IDs are allowed,
 *  so this is a free rename. */
function EditableKey({
  value,
  editable,
  onSave,
}: {
  value: string
  editable: boolean
  onSave: (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (editing) {
      ref.current?.focus()
      ref.current?.select()
      done.current = false
    }
  }, [editing])
  useEffect(() => {
    if (!editing) setVal(value)
  }, [value, editing])

  function commit() {
    if (done.current) return
    done.current = true
    const next = val.trim()
    setEditing(false)
    if (next && next !== value) onSave(next)
  }

  if (!editable) {
    return (
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap" title={value}>
        {value}
      </span>
    )
  }
  if (editing) {
    return (
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            done.current = true
            setEditing(false)
          }
        }}
        className="w-full min-w-0 flex-1 rounded border-[1.5px] border-[var(--green-l)] bg-[var(--surface)] px-1 text-[12.5px] font-semibold outline-none"
      />
    )
  }
  return (
    <button
      type="button"
      title={value ? `${value} — クリックでID編集` : 'IDを編集（クリック）'}
      onClick={() => setEditing(true)}
      className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left hover:text-[var(--green-d)] hover:underline"
    >
      {value}
    </button>
  )
}

/** One attribute cell. Lookup columns resolve read-only; status is editable
 *  (badge when idle, dropdown when clicked); others inline-edit when `editable`,
 *  else read-only. When `autoStatusBadge` is provided the status column is
 *  read-only and shows the computed badge (Feature 6). */
function AttrCell({
  row,
  column,
  members,
  rows,
  lookupValue,
  editable,
  autoStatusBadge,
  autoStatusDelayWeeks,
  viewedWeekIso,
  onSave,
}: {
  row: Row
  column: Column
  members: Member[]
  rows: Row[]
  lookupValue: (column: Column, row: Row) => string | null
  editable: boolean
  autoStatusBadge?: StatusBadge | null
  /** Weeks behind (何週遅延) for the auto-status column; shown next to the badge. */
  autoStatusDelayWeeks?: number | null
  /** Viewed week — weekly-reset columns blank their value outside this week. */
  viewedWeekIso?: string
  onSave: (v: CellValue) => void
}) {
  // Weekly-reset: outside the value's own week, show empty (still editable to set
  // this week's value). onSave still writes to the real row (via the parent).
  const stale =
    !!column.config?.weekly_reset &&
    !!viewedWeekIso &&
    row.data[`__wk_${column.id}`] !== viewedWeekIso
  const effRow = stale ? { ...row, data: { ...row.data, [column.id]: null } } : row
  // Auto-derived status (read-only computed badge).
  if (column.type === 'status' && autoStatusBadge !== undefined) {
    const delay = autoStatusDelayWeeks ?? null
    return (
      <div
        className="flex h-full items-center gap-1 px-2.5"
        title={
          delay
            ? `現在フェーズ：${autoStatusBadge?.label ?? '—'}（実績が予定に対して約${delay}週遅延）`
            : '現在フェーズから自動判定（読み取り専用）'
        }
      >
        {autoStatusBadge ? (
          <Badge color={autoStatusBadge.color} bg={autoStatusBadge.bg}>
            {autoStatusBadge.label}
          </Badge>
        ) : (
          <span className="text-[12px] text-[var(--ink3)]">—</span>
        )}
        {delay ? (
          <span
            className="flex-shrink-0 whitespace-nowrap rounded bg-[#FAE6E0] px-1 text-[10px] font-semibold leading-[16px] text-[#A8442B]"
          >
            {delay}週遅延
          </span>
        ) : null}
      </div>
    )
  }
  // Lookup is always read-only resolved; status is editable only in live mode
  // (as-of view shows the computed badge). Everything else edits when editable.
  if (column.type === 'lookup') {
    return (
      <InlineCell
        row={row}
        column={column}
        members={members}
        lookupValue={lookupValue}
        compact
        onSave={onSave}
      />
    )
  }
  if (editable || column.type === 'status') {
    return (
      <InlineCell
        row={effRow}
        column={column}
        members={members}
        rows={rows}
        lookupValue={lookupValue}
        compact
        editable={editable}
        onSave={onSave}
      />
    )
  }
  return <ReadonlyCell row={effRow} column={column} members={members} lookupValue={lookupValue} />
}

function ReadonlyCell({
  row,
  column,
  members,
  lookupValue,
}: {
  row: Row
  column: Column
  members: Member[]
  lookupValue: (column: Column, row: Row) => string | null
}) {
  // Read-only mode (as-of snapshot) must match the editable InlineCell's vertical
  // centering — otherwise text/avatars stick to the cell top ("上寄せ").
  if (column.type === 'member') {
    const id = row.data[column.id]
    const m = members.find((x) => String(x.id) === String(id ?? ''))
    return (
      <div
        className="flex h-full items-center gap-1.5 overflow-hidden px-2.5 text-[12px]"
        title={m?.name}
      >
        {m ? (
          <>
            <Avatar name={m.name} seed={String(m.id)} />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{m.name}</span>
          </>
        ) : (
          <span className="text-[var(--ink3)]">—</span>
        )}
      </div>
    )
  }
  if (column.type === 'lookup') {
    const lv = lookupValue(column, row) ?? ''
    return (
      <div
        className="flex h-full items-center overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[12.5px] text-[var(--ink3)]"
        title={lv || undefined}
      >
        {lv}
      </div>
    )
  }
  // Dropdown: keep the colored badge (read-only), matching the editable view.
  if (column.type === 'dropdown') {
    const dv = row.data[column.id]
    const opt = (column.config?.options ?? []).find((o) => o.value === String(dv ?? ''))
    return (
      <div className="flex h-full items-center px-2.5">
        {dv == null || dv === '' ? null : (
          <Badge bg={opt?.color ?? '#EFEDE4'} color="#3a382f">
            {String(dv)}
          </Badge>
        )}
      </div>
    )
  }
  const v = row.data[column.id]
  const vs = v == null || v === '' ? '' : String(v)
  return (
    <div
      className="flex h-full items-center overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[12.5px]"
      title={vs || undefined}
    >
      {vs}
    </div>
  )
}

interface WeekCellViewProps {
  cell: WeekCell | null
  monthStart: boolean
  left: number
  width: number
  live: boolean
  editable: boolean
  /** Inside the current range selection — tinted so partial ranges stay legible. */
  selected: boolean
  onMouseDown: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onHover: (e: React.MouseEvent) => void
  onLeave: () => void
}

function WeekCellView({
  cell,
  monthStart,
  left,
  width,
  live,
  editable,
  selected,
  onMouseDown,
  onMouseUp,
  onHover,
  onLeave,
}: WeekCellViewProps) {
  const planned = cell?.planned ?? 0
  const actual = cell?.actual ?? 0
  // Show the cell (phase fill + numbers) whenever it has any plan or actual.
  const colored = !!(cell && (planned > 0 || actual > 0) && cell.color)
  const plannedColor = cell?.changed && live ? 'var(--accent)' : '#8a8778'
  // Whole hours in the cell; the hover tooltip still shows the exact value.
  const fmt = fmtHours

  return (
    <div
      className={cn(
        'group/cell absolute top-0 flex h-full flex-col items-center justify-center leading-none',
        editable && 'cursor-pointer hover:shadow-[inset_0_0_0_1.5px_var(--green-l)]',
        monthStart && 'shadow-[inset_1px_0_0_var(--line2)]',
        editable && !colored && 'hover:bg-[var(--line2)]',
      )}
      style={{ left, width, background: colored ? cell!.color : undefined }}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
    >
      {selected && (
        <span
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{ background: 'rgba(38,107,83,.14)' }}
        />
      )}
      {(cell?.milestoneActual || cell?.milestoneMarker) && (
        <span
          title={cell ? milestoneTip(cell) : undefined}
          className="absolute left-0 top-1/2 z-[3] h-[9px] w-[9px] border-[1.5px] border-[var(--ink)]"
          style={{
            transform: 'translate(-50%,-50%) rotate(45deg)',
            background: cell?.milestoneActual ? 'var(--ink)' : 'white',
          }}
        />
      )}
      {colored && (
        <>
          {/* top = 予定 (planned) */}
          {planned > 0 && (
            <span
              className="text-[9px]"
              style={{ color: plannedColor, fontWeight: cell?.changed && live ? 700 : 500 }}
            >
              {fmt(planned)}
            </span>
          )}
          {/* divider: only when both rows show, to make the 上=予定 / 下=実績 split explicit */}
          {planned > 0 && actual > 0 && (
            <span className="my-[1px] h-px w-[62%]" style={{ background: 'rgba(51,50,44,.14)' }} />
          )}
          {/* bottom = 実績 (actual) */}
          {actual > 0 && (
            <span className="text-[9.5px] font-semibold" style={{ color: '#33322c' }}>
              {fmt(actual)}
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** In-place numeric editor for a single week cell. Commits the value and, when a
 *  direction is given (Tab/Shift+Tab/arrows/Enter), asks the grid to move to the
 *  next cell so values can be entered without reaching for the mouse (Feature 1).
 *  Blur commits without moving; Esc cancels. */
function WeekCellInput({
  left,
  width,
  initial,
  seed,
  onCommitMove,
  onCancel,
}: {
  left: number
  width: number
  initial: number
  /** Character typed to open the editor — replaces the value, as in Excel. */
  seed?: string
  onCommitMove: (value: number | null, dir: 'up' | 'down' | 'left' | 'right' | null) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [val, setVal] = useState(seed ?? (initial ? String(initial) : ''))
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    // Opened by a click or Enter: select all, so typing replaces the value.
    // Opened by typing: the seed is already the whole value, caret at the end.
    // (setSelectionRange is not allowed on type=number, hence the plain focus.)
    if (!seed) ref.current?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit(dir: 'up' | 'down' | 'left' | 'right' | null) {
    if (done.current) return
    done.current = true
    const trimmed = val.trim()
    if (trimmed === '') {
      onCommitMove(null, dir)
      return
    }
    const n = Number(trimmed)
    onCommitMove(Number.isFinite(n) ? n : null, dir)
  }

  // Caret-aware so ←/→ only jump cells at the value's edges (else move the caret).
  const atStart = () => {
    const el = ref.current
    return !!el && el.selectionStart === 0 && el.selectionEnd === 0
  }
  const atEnd = () => {
    const el = ref.current
    return !!el && el.selectionStart === val.length && el.selectionEnd === val.length
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="decimal"
      min={0}
      step="0.5"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => commit(null)}
      onKeyDown={(e) => {
        switch (e.key) {
          case 'Enter':
            e.preventDefault()
            commit('down')
            break
          case 'Tab':
            e.preventDefault()
            commit(e.shiftKey ? 'left' : 'right')
            break
          case 'ArrowDown':
            e.preventDefault()
            commit('down')
            break
          case 'ArrowUp':
            e.preventDefault()
            commit('up')
            break
          case 'ArrowRight':
            if (atEnd()) {
              e.preventDefault()
              commit('right')
            }
            break
          case 'ArrowLeft':
            if (atStart()) {
              e.preventDefault()
              commit('left')
            }
            break
          case 'Escape':
            e.preventDefault()
            done.current = true
            onCancel()
            break
        }
      }}
      className="absolute top-0 z-[5] h-full rounded-[3px] border-[1.5px] border-[var(--green-l)] bg-[var(--surface)] text-center text-[11px] outline-none"
      style={{ left, width: Math.max(width, 44) }}
    />
  )
}

/** Small chain/link glyph for the dependency (先行タスク) button. */
function LinkGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[11px] w-[11px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 12h6" />
      <path d="M10 8H8a4 4 0 1 0 0 8h2" />
      <path d="M14 8h2a4 4 0 1 1 0 8h-2" />
    </svg>
  )
}

/** 進捗 cell: manual % for leaf tasks (click to edit), read-only effort-weighted
 *  roll-up for parents. Colored red when behind the plan, green when on track. */
function ProgressCell({
  model,
  editable,
  onEdit,
}: {
  model: ScheduleRowModel
  editable: boolean
  onEdit: (value: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  const p = model.progress
  const hasPlan = model.gantt.plannedSum > 0
  const expected = Math.round(model.expectedPct * 100)
  const neutral = p == null || !hasPlan
  const color = neutral ? 'var(--ink3)' : model.behind ? '#A8442B' : '#266B53'
  const bg = neutral ? undefined : model.behind ? '#FAE6E0' : '#E6F0DB'
  const canEdit = editable && !model.progressRollup
  // Week-over-week change (前週からの差). Shown as a small delta next to the %.
  const prev = model.progressPrev
  const delta = p != null && prev != null ? p - prev : null

  useEffect(() => {
    if (editing) {
      setVal(p == null ? '' : String(p))
      ref.current?.focus()
      ref.current?.select()
      done.current = false
    }
  }, [editing, p])

  function commit() {
    if (done.current) return
    done.current = true
    setEditing(false)
    const t = val.trim()
    if (t === '') return onEdit(null)
    const n = Math.round(Number(t))
    if (!Number.isFinite(n)) return
    onEdit(Math.max(0, Math.min(100, n)))
  }

  if (editing) {
    return (
      <div className="flex items-center justify-end px-1.5" style={{ width: PROG_W }}>
        <input
          ref={ref}
          type="number"
          min={0}
          max={100}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              done.current = true
              setEditing(false)
            }
          }}
          className="w-[46px] rounded border-[1.5px] border-[var(--green-l)] bg-[var(--surface)] px-1 text-right text-[12px] outline-none"
        />
      </div>
    )
  }

  const title = hasPlan
    ? `進捗 ${p ?? '—'}% ／ 予定上は今日 ${expected}% 想定${model.behind ? '（ビハインド）' : ''}${
        model.progressRollup ? '（子タスクの集計）' : ''
      }${prev != null ? ` ／ 前週 ${prev}%` : ''}`
    : '進捗（予定がないため基準なし）'

  return (
    <button
      type="button"
      title={title}
      onClick={() => {
        if (canEdit) setEditing(true)
      }}
      className={cn(
        'flex h-full items-center justify-end px-2 text-[12px] font-semibold',
        canEdit ? 'cursor-pointer' : 'cursor-default',
      )}
      style={{ width: PROG_W, color }}
    >
      <span
        className="rounded px-1 py-0.5"
        style={{ background: bg }}
      >
        {p == null ? '—' : `${p}%`}
      </span>
      {delta != null && delta !== 0 && (
        <span
          className="ml-0.5 text-[9px] font-semibold leading-none"
          style={{ color: delta > 0 ? '#266B53' : '#A8442B' }}
        >
          {delta > 0 ? '+' : ''}
          {delta}
        </span>
      )}
    </button>
  )
}

/** Header cells for a subset of the summary columns (予定計/実績計/差/進捗/予実差).
 *  Each is sortable via a sort-only menu (要望: 設定外の集計列も並べ替え可能に). */
function SummaryHeads({
  cols,
  openMenu,
  dirFor,
  onToggleMenu,
  onSort,
}: {
  cols: ReadonlyArray<SummaryDescriptor>
  openMenu: SortKey | null
  dirFor: (key: SortKey) => SortDir | null
  onToggleMenu: (key: SortKey) => void
  onSort: (key: SortKey, dir: SortDir | null) => void
}) {
  return (
    <>
      {cols.map((col) => (
        <SummaryHead
          key={col.key}
          col={col}
          open={openMenu === col.key}
          sortDir={dirFor(col.key)}
          onToggleMenu={() => onToggleMenu(col.key)}
          onSort={(dir) => onSort(col.key, dir)}
        />
      ))}
    </>
  )
}

/** One summary-column header — sort-only menu (no filter; the values are derived). */
function SummaryHead({
  col,
  open,
  sortDir,
  onToggleMenu,
  onSort,
}: {
  col: SummaryDescriptor
  open: boolean
  sortDir: SortDir | null
  onToggleMenu: () => void
  onSort: (dir: SortDir | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="relative flex-shrink-0" style={{ width: col.w }}>
      <HeadCell
        style={{ width: col.w }}
        className="justify-end text-right"
        sortDir={sortDir}
        hasMenu
        onClick={onToggleMenu}
      >
        {col.label}
      </HeadCell>
      {open && (
        <ColumnHeaderMenu
          colName={col.label}
          kind="values"
          options={{ kind: 'values', values: [], hasBlank: false, numMin: null, numMax: null }}
          filter={undefined}
          sortDir={sortDir}
          filterable={false}
          anchorRef={ref}
          onSort={onSort}
          onFilter={() => {}}
          onClose={onToggleMenu}
        />
      )}
    </div>
  )
}

/** Small week-over-week delta chip (前週差分) for the 予定計/実績計 totals.
 *  Hidden when the delta is zero or unknown. */
function SummaryDelta({ delta }: { delta: number | null }) {
  if (delta == null || delta === 0) return null
  return (
    <span
      className="text-[9px] font-semibold leading-none"
      style={{ color: delta > 0 ? '#266B53' : '#A8442B' }}
    >
      {delta > 0 ? '+' : ''}
      {delta}
    </span>
  )
}

/** Per-row summary cells for a subset of the summary columns. */
function RowSummaryCells({
  cols,
  model,
  editable,
  onEditProgress,
}: {
  cols: ReadonlyArray<SummaryDescriptor>
  model: ScheduleRowModel
  editable: boolean
  onEditProgress: (row: Row, value: number | null) => void
}) {
  return (
    <>
      {cols.map((col) => {
        if (col.key === 'plan') {
          const delta =
            model.plannedPrev != null
              ? Math.round(model.gantt.plannedSum - model.plannedPrev)
              : null
          return (
            <div
              key="plan"
              className="flex items-center justify-end gap-0.5 px-2.5 text-right text-[12.5px] font-medium text-[var(--ink2)]"
              style={{ width: col.w }}
              title={
                `予定計 ${round1(model.gantt.plannedSum)}h` +
                (model.plannedPrev != null ? `（前週 ${round1(model.plannedPrev)}h）` : '')
              }
            >
              {fmtHours(model.gantt.plannedSum)}h
              <SummaryDelta delta={delta} />
            </div>
          )
        }
        if (col.key === 'actual') {
          const delta =
            model.actualPrev != null
              ? Math.round(model.gantt.actualSum - model.actualPrev)
              : null
          return (
            <div
              key="actual"
              className="flex items-center justify-end gap-0.5 px-2.5 text-right text-[12.5px] font-medium text-[var(--ink2)]"
              style={{ width: col.w }}
              title={
                `実績計 ${round1(model.gantt.actualSum)}h` +
                (model.actualPrev != null ? `（前週 ${round1(model.actualPrev)}h）` : '')
              }
            >
              {fmtHours(model.gantt.actualSum)}h
              <SummaryDelta delta={delta} />
            </div>
          )
        }
        if (col.key === 'diff') {
          const exact = round1(model.gantt.plannedSum - model.gantt.actualSum)
          const diff = Math.round(model.gantt.plannedSum - model.gantt.actualSum)
          return (
            <div
              key="diff"
              className="px-2.5 text-right text-[12.5px] font-medium"
              style={{ width: col.w, color: diff < 0 ? '#A8442B' : 'var(--ink3)' }}
              title={`予定計 − 実績計 ＝ ${exact}h（マイナス＝予定超過）`}
            >
              {diff > 0 ? '+' : ''}
              {diff}h
            </div>
          )
        }
        if (col.key === 'prog')
          return (
            <ProgressCell
              key="prog"
              model={model}
              editable={editable}
              onEdit={(v) => onEditProgress(model.row, v)}
            />
          )
        // 予実差: 進捗 − 予定上の想定（pt）。プラス=前倒し / マイナス=遅延。
        const hasPlan = model.gantt.plannedSum > 0
        const pace =
          model.progress != null && hasPlan
            ? Math.round(model.progress - model.expectedPct * 100)
            : null
        return (
          <div
            key="pace"
            className="px-2.5 text-right text-[12px] font-semibold"
            style={{
              width: col.w,
              color: pace == null ? 'var(--ink3)' : pace < 0 ? '#A8442B' : '#266B53',
            }}
            title={
              pace == null
                ? '進捗 − 予定上の想定（進捗・予定がないため算出不可）'
                : `進捗 ${model.progress}% − 予定上の想定 ${Math.round(
                    model.expectedPct * 100,
                  )}% ＝ ${pace > 0 ? `${pace}pt 前倒し` : pace < 0 ? `${-pace}pt 遅延` : '予定どおり'}`
            }
          >
            {pace == null ? '—' : `${pace > 0 ? '+' : ''}${pace}%`}
          </div>
        )
      })}
    </>
  )
}

/** Footer cells for a subset of the summary columns (進捗 left blank). */
function FooterSummaryCells({
  cols,
  footTotals,
}: {
  cols: ReadonlyArray<SummaryDescriptor>
  footTotals: { plannedSum: number; actualSum: number }
}) {
  return (
    <>
      {cols.map((col) => {
        if (col.key === 'plan')
          return (
            <div
              key="plan"
              className="px-2.5 text-right text-[12px] font-semibold text-[var(--ink)]"
              style={{ width: col.w }}
            >
              {Math.round(footTotals.plannedSum)}h
            </div>
          )
        if (col.key === 'actual')
          return (
            <div
              key="actual"
              className="px-2.5 text-right text-[12px] font-semibold text-[var(--ink)]"
              style={{ width: col.w }}
            >
              {Math.round(footTotals.actualSum)}h
            </div>
          )
        if (col.key === 'diff') {
          const diff = Math.round(footTotals.plannedSum - footTotals.actualSum)
          return (
            <div
              key="diff"
              className="px-2.5 text-right text-[12px] font-semibold"
              style={{ width: col.w, color: diff < 0 ? '#A8442B' : 'var(--ink3)' }}
            >
              {diff > 0 ? '+' : ''}
              {diff}h
            </div>
          )
        }
        // 進捗 / 予実差 have no meaningful column total.
        return <div key={col.key} style={{ width: col.w }} />
      })}
    </>
  )
}
