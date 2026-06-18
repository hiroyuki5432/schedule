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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import { InlineCell } from '@/components/schedule/InlineCell'
import { useLookupTargets } from '@/hooks/useLookupTargets'
import { Badge } from '@/components/ui/Badge'
import { DiamondIcon, TrashIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import { fmtISO, fmtMD } from '@/lib/dates'
import type { WeekCell } from '@/lib/gantt'
import type { StatusBadge } from '@/lib/status'
import type { CellValue, Column, Member, Row } from '@/types/api'

const ROW_H = 38
const YEAR_H = 18 // year band above the month numbers
const MONTH_H = 28 // month-number band
const HEAD_H = YEAR_H + MONTH_H
const ID_W = 136 // wide enough to show the full key_value (e.g. P26-001) + ◇
const TOTAL_W = 64 // 予定計 column

// ---- Client-side sorting (Feature 1) ----------------------------------------
type SortDir = 'asc' | 'desc'
// A column key is the column id, or the synthetic ID (key_value) key.
type SortKey = string
const SORT_ID: SortKey = '__id__'

interface SortState {
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

/** Next sort state when a header is clicked: asc → desc → none (null). */
function cycleSort(prev: SortState | null, key: SortKey): SortState | null {
  if (!prev || prev.key !== key) return { key, dir: 'asc' }
  if (prev.dir === 'asc') return { key, dir: 'desc' }
  return null
}

function SortArrow({ dir }: { dir: SortDir | null }) {
  if (!dir) return null
  return <span className="ml-0.5 text-[9px] leading-none">{dir === 'asc' ? '▲' : '▼'}</span>
}

/** Attribute-column width, by type. */
function colWidth(c: Column): number {
  switch (c.type) {
    case 'status':
      return 96
    case 'member':
      return 124
    case 'date':
      return 116
    case 'number':
      return 96
    case 'text':
      return 176
    case 'lookup':
      return 150
    default:
      return 128
  }
}

export interface WeekEdit {
  rowId: string
  weekStart: string
  field: 'planned_hours' | 'actual_hours'
  value: number | null
}

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
  onSaveWeek: (edit: WeekEdit) => void
  onEditRowCell: (row: Row, colId: string, value: CellValue) => void
  onEditRowKey: (row: Row, key: string) => void
  onEditMilestones: (row: Row) => void
  onDeleteRow: (row: Row) => void
}

interface Tip {
  x: number
  y: number
  html: string
}

interface EditingCell {
  rowId: string
  wi: number
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
  onSaveWeek,
  onEditRowCell,
  onEditRowKey,
  onEditMilestones,
  onDeleteRow,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const didScrollRef = useRef(false)
  const [tip, setTip] = useState<Tip | null>(null)
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)

  const ordered = useMemo(
    () => [...columns].sort((a, b) => a.order - b.order),
    [columns],
  )
  const { lookupValue } = useLookupTargets(columns, members)

  // Apply client-side sort to the displayed rows (Feature 1).
  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const column = columns.find((c) => c.id === sort.key)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sortValueFor(a, sort.key, column, members, lookupValue)
      const bv = sortValueFor(b, sort.key, column, members, lookupValue)
      const cmp = compareValues(av, bv)
      // Empty always sinks to the bottom; otherwise honor direction.
      if (cmp === 0) return 0
      const aEmpty = av === '' || av == null
      const bEmpty = bv === '' || bv == null
      if (aEmpty || bEmpty) return cmp
      return cmp * dir
    })
  }, [rows, sort, columns, members, lookupValue])

  function onSortClick(key: SortKey) {
    setSort((prev) => cycleSort(prev, key))
  }
  const dirFor = (key: SortKey): SortDir | null =>
    sort?.key === key ? sort.dir : null

  // Plain rows (for status option lists) + lookup resolver for lookup columns.
  const plainRows = useMemo(() => sortedRows.map((r) => r.row), [sortedRows])
  // Column order is fully user-controlled. The first `pinnedCount` attribute
  // columns stay frozen next to the ID (Feature 1); the rest scroll. The ID
  // (key_value) is always the leftmost frozen column.
  const pinCount = Math.max(0, Math.min(pinnedCount, ordered.length))
  const pinnedCols = useMemo(() => ordered.slice(0, pinCount), [ordered, pinCount])
  const scrollCols = useMemo(() => ordered.slice(pinCount), [ordered, pinCount])
  // The status column auto-derives its badge from milestones (Feature 6) when
  // its config opts in; then the gantt shows the computed badge read-only.
  const autoStatusColId = useMemo(
    () =>
      ordered.find((c) => c.type === 'status' && c.config?.auto_from_milestones)
        ?.id ?? null,
    [ordered],
  )

  const pinnedW = useMemo(
    () => ID_W + pinnedCols.reduce((s, c) => s + colWidth(c), 0),
    [pinnedCols],
  )
  const attrW = useMemo(
    () => scrollCols.reduce((s, c) => s + colWidth(c), 0) + TOTAL_W,
    [scrollCols],
  )

  const rowVirt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  })
  const gridW = weeks.length * weekColWidth
  const totalW = pinnedW + attrW + gridW
  const totalH = rows.length * ROW_H

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

  // On first load, scroll the week area so "today" is visible (attribute columns
  // scroll off behind the pinned ID/件名; the gantt is the focus).
  useEffect(() => {
    if (didScrollRef.current) return
    const el = scrollRef.current
    if (el && rows.length > 0 && lineIndex >= 0) {
      el.scrollLeft = Math.max(0, attrW + lineXInGrid - 200)
      didScrollRef.current = true
    }
  }, [rows.length, attrW, lineIndex, lineXInGrid])

  const lineColor = live ? 'var(--today)' : 'var(--asof)'
  // Caption shares the line's color so the marker and label read as one unit.
  const capColor = lineColor
  const capLabel = live
    ? `今日 ${fmtMD(weeks[lineIndex] ?? new Date())}`
    : `基準 ${fmtMD(weeks[lineIndex] ?? new Date())}`

  const isMonth = viewMode === 'month'
  function tooltipFor(model: ScheduleRowModel, cell: WeekCell, wi: number): string {
    const past = wi < lineIndex && live
    const kind = past ? '実績' : '予定'
    const chg =
      cell.changed && live
        ? `<br><span style="color:#F2B8A0">● ${isMonth ? '前月' : '前週'}から変更</span>`
        : ''
    // Milestone name for the segment; mark done state when this is a boundary.
    const phase = cell.phaseLabel
      ? ` ・ ${cell.phaseLabel}${
          cell.milestoneMarker ? (cell.milestoneDone ? '（達成）' : '（未達成）') : ''
        }`
      : ''
    const when = isMonth
      ? `${weeks[wi].getFullYear()}/${weeks[wi].getMonth() + 1}月`
      : `週 ${fmtMD(weeks[wi])}`
    return `<b style="font-weight:600">${model.keyValue}</b>${phase}<br>${when} ・ ${kind} ${cell.hours}h${chg}`
  }

  return (
    <div className="relative flex-1 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)]">
      <div ref={scrollRef} className="h-full overflow-auto">
        <div className="relative" style={{ width: totalW, height: HEAD_H + totalH }}>
          {/* ---- Header (sticky top) ---- */}
          <div
            className="sticky top-0 z-30 flex bg-[#F4F1E8]"
            style={{ height: HEAD_H, width: totalW }}
          >
            {/* pinned header (sortable: ID + frozen attribute columns) */}
            <div
              className="sticky left-0 z-40 flex flex-shrink-0 items-center border-r border-[var(--line)] bg-[#F4F1E8]"
              style={{ width: pinnedW, height: HEAD_H }}
            >
              <HeadCell
                style={{ width: ID_W }}
                sortDir={dirFor(SORT_ID)}
                onClick={() => onSortClick(SORT_ID)}
              >
                ID
              </HeadCell>
              {pinnedCols.map((c) => (
                <HeadCell
                  key={c.id}
                  style={{ width: colWidth(c) }}
                  sortDir={dirFor(c.id)}
                  onClick={() => onSortClick(c.id)}
                >
                  {c.name}
                </HeadCell>
              ))}
            </div>
            {/* attr headers (scroll, sortable) */}
            <div className="flex flex-shrink-0" style={{ width: attrW, height: HEAD_H }}>
              {scrollCols.map((c) => (
                <HeadCell
                  key={c.id}
                  style={{ width: colWidth(c) }}
                  sortDir={dirFor(c.id)}
                  onClick={() => onSortClick(c.id)}
                >
                  {c.name}
                </HeadCell>
              ))}
              <HeadCell style={{ width: TOTAL_W }} className="justify-end text-right">
                予定計
              </HeadCell>
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
            const model = sortedRows[vRow.index]
            const odd = vRow.index % 2 === 1
            const rowBg = odd ? 'bg-[#FCFBF7]' : 'bg-[var(--surface)]'
            return (
              <div
                key={model.row.id}
                className={cn(
                  'group/row absolute left-0 flex border-b border-[var(--line2)]',
                  odd && 'bg-[#FCFBF7]',
                )}
                style={{ top: HEAD_H + vRow.start, height: ROW_H, width: totalW }}
              >
                {/* pinned: ID + title */}
                <div
                  className={cn(
                    'sticky left-0 z-20 flex flex-shrink-0 items-center border-r border-[var(--line)]',
                    rowBg,
                  )}
                  style={{ width: pinnedW, height: ROW_H }}
                >
                  <div
                    className="flex items-center gap-1 overflow-hidden px-2 text-[12.5px] font-semibold"
                    style={{ width: ID_W }}
                  >
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
                    <div key={c.id} className="h-full overflow-hidden" style={{ width: colWidth(c) }}>
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
                        onSave={(v) => onEditRowCell(model.row, c.id, v)}
                      />
                    </div>
                  ))}
                </div>

                {/* attr block (scrolls) */}
                <div
                  className={cn('flex flex-shrink-0 items-center border-r border-[var(--line2)]', rowBg)}
                  style={{ width: attrW, height: ROW_H }}
                >
                  {scrollCols.map((c) => (
                    <div key={c.id} className="h-full overflow-hidden" style={{ width: colWidth(c) }}>
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
                        onSave={(v) => onEditRowCell(model.row, c.id, v)}
                      />
                    </div>
                  ))}
                  <div
                    className="px-2.5 text-right text-[12.5px] font-medium text-[var(--ink2)]"
                    style={{ width: TOTAL_W }}
                  >
                    {model.gantt.plannedSum}h
                  </div>
                </div>

                {/* week cells (virtualized) */}
                <div className="relative flex-shrink-0" style={{ width: gridW, height: ROW_H }}>
                  {weeks.map((_w, wi) => {
                    const cell = model.gantt.cells[wi]
                    const isEditing =
                      editing?.rowId === model.row.id && editing.wi === wi
                    if (isEditing) {
                      const past = wi < lineIndex && live
                      const field = past ? 'actual_hours' : 'planned_hours'
                      const current = past ? cell?.actual ?? 0 : cell?.planned ?? 0
                      return (
                        <WeekCellInput
                          key={wi}
                          left={wi * weekColWidth}
                          width={weekColWidth}
                          initial={current}
                          onCommit={(value) => {
                            onSaveWeek({
                              rowId: model.row.id,
                              weekStart: fmtISO(weeks[wi]),
                              field,
                              value,
                            })
                            setEditing(null)
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      )
                    }
                    return (
                      <WeekCellView
                        key={wi}
                        cell={cell}
                        monthStart={monthStart[wi]}
                        left={wi * weekColWidth}
                        width={weekColWidth}
                        live={live}
                        lineIndex={lineIndex}
                        wi={wi}
                        editable={editable}
                        onClick={() => {
                          if (!editable) return
                          setEditing({ rowId: model.row.id, wi })
                        }}
                        onHover={(e) => {
                          if (!cell || cell.hours <= 0) {
                            setTip(null)
                            return
                          }
                          setTip({
                            x: e.clientX + 14,
                            y: e.clientY + 14,
                            html: tooltipFor(model, cell, wi),
                          })
                        }}
                        onLeave={() => setTip(null)}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}

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
        </div>
      </div>

      {tip && (
        <div
          className="pointer-events-none fixed z-50 whitespace-nowrap rounded-lg bg-[var(--ink)] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-white"
          style={{ left: tip.x, top: tip.y }}
          dangerouslySetInnerHTML={{ __html: tip.html }}
        />
      )}
    </div>
  )
}

function HeadCell({
  children,
  className,
  style,
  sortDir,
  onClick,
}: {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  /** Current sort direction for this column, or null when inactive. */
  sortDir?: SortDir | null
  /** When provided, the header becomes a sort toggle button. */
  onClick?: () => void
}) {
  const base =
    'flex h-full flex-shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[11px] font-medium text-[var(--ink3)]'
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="クリックで並べ替え（昇順→降順→解除）"
        className={cn(
          base,
          'cursor-pointer select-none hover:text-[var(--ink2)]',
          sortDir && 'text-[var(--ink)]',
          className,
        )}
        style={style}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{children}</span>
        <SortArrow dir={sortDir ?? null} />
      </button>
    )
  }
  return (
    <div className={cn(base, className)} style={style}>
      {children}
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
      <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{value}</span>
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
      title="IDを編集（クリック）"
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
  onSave,
}: {
  row: Row
  column: Column
  members: Member[]
  rows: Row[]
  lookupValue: (column: Column, row: Row) => string | null
  editable: boolean
  autoStatusBadge?: StatusBadge | null
  onSave: (v: CellValue) => void
}) {
  // Auto-derived status (read-only computed badge).
  if (column.type === 'status' && autoStatusBadge !== undefined) {
    return (
      <div
        className="flex h-full items-center px-2.5"
        title="達成状況から自動判定（読み取り専用）"
      >
        {autoStatusBadge ? (
          <Badge color={autoStatusBadge.color} bg={autoStatusBadge.bg}>
            {autoStatusBadge.label}
          </Badge>
        ) : (
          <span className="text-[12px] text-[var(--ink3)]">—</span>
        )}
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
        row={row}
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
  return <ReadonlyCell row={row} column={column} members={members} lookupValue={lookupValue} />
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
  if (column.type === 'member') {
    const id = row.data[column.id]
    const m = members.find((x) => String(x.id) === String(id ?? ''))
    return (
      <div className="overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[12px]">
        {m?.name ?? ''}
      </div>
    )
  }
  if (column.type === 'lookup') {
    return (
      <div className="overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[12.5px] text-[var(--ink3)]">
        {lookupValue(column, row) ?? ''}
      </div>
    )
  }
  const v = row.data[column.id]
  return (
    <div className="overflow-hidden text-ellipsis whitespace-nowrap px-2.5 text-[12.5px]">
      {v == null || v === '' ? '' : String(v)}
    </div>
  )
}

interface WeekCellViewProps {
  cell: WeekCell | null
  monthStart: boolean
  left: number
  width: number
  live: boolean
  lineIndex: number
  wi: number
  editable: boolean
  onClick: () => void
  onHover: (e: React.MouseEvent) => void
  onLeave: () => void
}

function WeekCellView({
  cell,
  monthStart,
  left,
  width,
  live,
  lineIndex,
  wi,
  editable,
  onClick,
  onHover,
  onLeave,
}: WeekCellViewProps) {
  const past = wi < lineIndex
  const colored = !!(cell && cell.hours > 0 && cell.color)
  const numColor =
    cell?.changed && live
      ? 'var(--accent)'
      : past
        ? '#33322c'
        : 'rgba(51,50,44,.5)'
  const numWeight = cell?.changed && live ? 700 : 500

  return (
    <div
      className={cn(
        'group/cell absolute top-0 flex h-full items-center justify-center text-[11px]',
        editable && 'cursor-pointer hover:shadow-[inset_0_0_0_1.5px_var(--green-l)]',
        monthStart && 'shadow-[inset_1px_0_0_var(--line2)]',
        editable && !colored && 'hover:bg-[var(--line2)]',
      )}
      style={{ left, width, background: colored ? cell!.color : undefined }}
      onClick={onClick}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
    >
      {cell?.milestoneMarker && (
        <span
          title={
            cell.phaseLabel
              ? `${cell.phaseLabel}${cell.milestoneDone ? '（達成）' : '（未達成）'}`
              : undefined
          }
          className="absolute left-0 top-1/2 z-[3] h-[9px] w-[9px] border-[1.5px] border-[var(--ink)]"
          style={{
            transform: 'translate(-50%,-50%) rotate(45deg)',
            // Filled diamond when the milestone is done, hollow (white) when not.
            background: cell.milestoneDone ? 'var(--ink)' : 'white',
          }}
        />
      )}
      {colored && (
        <span style={{ color: numColor, fontWeight: numWeight }}>{cell!.hours}</span>
      )}
    </div>
  )
}

/** In-place numeric editor for a single week cell. Enter/blur saves, Esc cancels. */
function WeekCellInput({
  left,
  width,
  initial,
  onCommit,
  onCancel,
}: {
  left: number
  width: number
  initial: number
  onCommit: (value: number | null) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [val, setVal] = useState(initial ? String(initial) : '')
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  function commit() {
    if (done.current) return
    done.current = true
    const trimmed = val.trim()
    if (trimmed === '') {
      onCommit(null)
      return
    }
    const n = Number(trimmed)
    onCommit(Number.isFinite(n) ? n : null)
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
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          onCancel()
        }
      }}
      className="absolute top-0 z-[5] h-full rounded-[3px] border-[1.5px] border-[var(--green-l)] bg-[var(--surface)] text-center text-[11px] outline-none"
      style={{ left, width: Math.max(width, 44) }}
    />
  )
}
