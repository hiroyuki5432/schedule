// Loads everything the Schedule page needs for one sheet and assembles the
// per-row gantt model. Effort + milestones are fetched in batch and memoized.

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import {
  buildWeeks,
  monthStarts,
  startOfWeek,
  weekIndex,
} from '@/lib/dates'
import { buildRowGantt } from '@/lib/gantt'
import type { RowGantt } from '@/lib/gantt'
import {
  deriveStatus,
  literalStatusBadge,
  statusFromMilestones,
} from '@/lib/status'
import type { StatusBadge } from '@/lib/status'
import type {
  Column,
  Effort,
  Member,
  Milestone,
  Row,
  SheetDetail,
} from '@/types/api'

// ≈ 3 years of weekly columns (long-term schedule range). Rendering ~156
// columns × rows without column virtualization is acceptable.
export const WEEK_COUNT = 156
/** How many weeks before the current week the window starts. */
export const WEEKS_BEFORE = 26

export interface ScheduleRowModel {
  row: Row
  keyValue: string
  title: string
  assigneeName: string | null
  assigneeId: string | null
  status: StatusBadge | null
  milestones: Milestone[]
  gantt: RowGantt
  /** Parent task id (子タスクのとき); null for top-level tasks. */
  parentRowId: string | null
  /** True when this top-level task has subtasks — its gantt is their roll-up. */
  hasChildren: boolean
  /** Number of direct subtasks. */
  childCount: number
  /** 0 = top-level task, 1 = subtask (one level of nesting). */
  depth: number
  /** Effective progress 0-100 (手入力; parents = effort-weighted roll-up). null=unset. */
  progress: number | null
  /** True when progress is a read-only roll-up (parent with children). */
  progressRollup: boolean
  /** Fraction the plan expects done by today (planned-to-date / planned-total). */
  expectedPct: number
  /** Behind schedule: progress below the expected fraction. */
  behind: boolean
  /** Week index of first / last planned-effort week (task span); null if none. */
  startIdx: number | null
  finishIdx: number | null
  /** 逆ザヤ: predecessors whose finish is after this task's start. */
  depViolations: Array<{ predKey: string; weeks: number }>
}

export interface ScheduleData {
  loading: boolean
  detail: SheetDetail | undefined
  columns: Column[]
  weeks: Date[]
  monthStart: boolean[]
  currentWeekIdx: number
  rows: ScheduleRowModel[]
  /** Month view only: column-start ISO → the ISO week_starts that month covers
   *  (used to distribute a month-cell edit back across its weeks). */
  monthWeeks?: Map<string, string[]>
}

export type ViewMode = 'week' | 'month'

interface Args {
  sheetId: string | undefined
  weekStartWeekday: number
  members: Member[]
  /** as-of week index; when set (< current) overlay snapshot effort/rows. */
  asOfWeek?: string | null
  /** Extra weeks to render before the default window start (range controls). */
  extraBefore?: number
  /** Extra weeks to render after the default window end (range controls). */
  extraAfter?: number
  /** 'week' (default) shows weekly columns; 'month' aggregates into calendar
   *  months (sum of the month's weeks; input distributes evenly back to weeks). */
  viewMode?: ViewMode
}

interface MonthCol {
  /** First-of-month date used as the column's display date + edit key. */
  date: Date
  /** Indices into the weekly `weeks[]` that fall in this calendar month. */
  weekIdxs: number[]
}

/** Group Monday-anchored weeks into calendar-month columns (by each week's
 *  start month). */
function buildMonthCols(weeks: Date[]): MonthCol[] {
  const cols: MonthCol[] = []
  let i = 0
  while (i < weeks.length) {
    const y = weeks[i].getFullYear()
    const m = weeks[i].getMonth()
    const weekIdxs: number[] = []
    let j = i
    while (j < weeks.length && weeks[j].getFullYear() === y && weeks[j].getMonth() === m) {
      weekIdxs.push(j)
      j++
    }
    cols.push({ date: new Date(y, m, 1), weekIdxs })
    i = j
  }
  return cols
}

/** Aggregate a row's weekly gantt cells into one cell per calendar month. A
 *  month is "changed" if any of its weeks changed vs the snapshot baseline. */
function aggregateRowToMonths(g: RowGantt, cols: MonthCol[]): RowGantt {
  const cells = cols.map((col) => {
    let hours = 0
    let planned = 0
    let actual = 0
    let color = ''
    let label = ''
    let marker = false
    let markerActual = false
    let markerDone = false
    let late = false
    let changed = false
    let msPlannedDate: string | null = null
    let msActualDate: string | null = null
    let msDelayDays: number | null = null
    for (const k of col.weekIdxs) {
      const c = g.cells[k]
      if (!c) continue
      hours += c.hours
      planned += c.planned
      actual += c.actual
      if (c.hours > 0 && !color) {
        color = c.color
        label = c.phaseLabel
      }
      if ((c.milestoneMarker || c.milestoneActual) && msPlannedDate === null && msActualDate === null) {
        markerDone = c.milestoneDone
        msPlannedDate = c.msPlannedDate
        msActualDate = c.msActualDate
        msDelayDays = c.msDelayDays
        if (!label) label = c.phaseLabel
      }
      if (c.milestoneMarker) marker = true
      if (c.milestoneActual) markerActual = true
      if (c.late) late = true
      if (c.changed) changed = true
    }
    if (hours <= 0 && !marker && !markerActual) return null
    return {
      hours,
      color,
      milestoneMarker: marker,
      milestoneActual: markerActual,
      milestoneDone: markerDone,
      phaseLabel: label,
      changed,
      late,
      planned,
      actual,
      msPlannedDate,
      msActualDate,
      msDelayDays,
    }
  })
  return { cells, plannedSum: g.plannedSum, actualSum: g.actualSum }
}

function pickColumn(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type)
}

function titleColumn(columns: Column[]): Column | undefined {
  // Prefer a text column that isn't the key; fall back to first text column.
  const texts = columns.filter((c) => c.type === 'text' && !c.is_key)
  return texts[0] ?? columns.find((c) => c.type === 'text')
}

function isoKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function plannedOf(e: Effort | undefined): number {
  const v = e?.planned_hours
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function numOf(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Task span (first/last planned-effort week) + planned hours up to today. */
function spanAndToDate(g: RowGantt, currentWeekIdx: number) {
  let startIdx: number | null = null
  let finishIdx: number | null = null
  let plannedToDate = 0
  g.cells.forEach((c, i) => {
    if (!c) return
    if (c.planned > 0) {
      if (startIdx === null) startIdx = i
      finishIdx = i
    }
    if (i <= currentWeekIdx) plannedToDate += c.planned
  })
  return { startIdx, finishIdx, plannedToDate }
}

/** Roll a parent task's weekly effort up from its subtasks: per week, the sum of
 *  all children's planned/actual. The parent itself holds no own effort, so this
 *  is the "上位ではまとめた工数" view (子の合算). */
function aggregateChildEffort(
  childRows: Row[],
  effortByRow: Map<string, Map<string, Effort>>,
): Map<string, Effort> {
  const acc = new Map<string, { planned: number; actual: number }>()
  for (const c of childRows) {
    const m = effortByRow.get(c.id)
    if (!m) continue
    for (const [wk, e] of m) {
      const cur = acc.get(wk) ?? { planned: 0, actual: 0 }
      cur.planned += numOf(e.planned_hours)
      cur.actual += numOf(e.actual_hours)
      acc.set(wk, cur)
    }
  }
  const out = new Map<string, Effort>()
  for (const [wk, v] of acc) {
    out.set(wk, {
      row_id: '',
      week_start: wk,
      planned_hours: v.planned || null,
      actual_hours: v.actual || null,
    })
  }
  return out
}

/**
 * Change points: a week whose current PLANNED hours differ from the weekly
 * snapshot baseline (the cross-section auto-captured at the start of this week).
 * So red = "changed since this week's snapshot" — editing a week flags only that
 * week (its neighbors are compared to their own baseline, not to it). When no
 * baseline is available, nothing is flagged.
 */
function changedVsBaseline(
  weeks: Date[],
  effortByWeek: Map<string, Effort>,
  baselineByWeek: Map<string, number> | undefined,
): Set<number> {
  const changed = new Set<number>()
  if (!baselineByWeek) return changed
  weeks.forEach((w, i) => {
    const cur = plannedOf(effortByWeek.get(isoKey(w)))
    const base = baselineByWeek.get(isoKey(w)) ?? 0
    if (cur !== base) changed.add(i)
  })
  return changed
}

export function useScheduleData({
  sheetId,
  weekStartWeekday,
  members,
  asOfWeek,
  extraBefore = 0,
  extraAfter = 0,
  viewMode = 'week',
}: Args): ScheduleData {
  const detailQ = useQuery({
    queryKey: ['sheet', sheetId],
    queryFn: () => api.getSheet(sheetId!),
    enabled: !!sheetId,
  })

  const effortQ = useQuery({
    queryKey: ['effort', sheetId],
    queryFn: () => api.getEffort(sheetId!),
    enabled: !!sheetId,
  })

  const rows = detailQ.data?.rows ?? []

  // Batch milestones for every row (Promise.all under the hood via useQueries).
  const milestoneQs = useQueries({
    queries: rows.map((r) => ({
      queryKey: ['milestones', r.id],
      queryFn: () => api.getMilestones(r.id),
      enabled: !!sheetId,
    })),
  })

  // As-of snapshot (only when a past week is selected).
  const snapshotQ = useQuery({
    queryKey: ['snapshot', sheetId, asOfWeek],
    queryFn: () => api.getSnapshot(sheetId!, asOfWeek!),
    enabled: !!sheetId && !!asOfWeek,
  })

  // Change points for the current week (numbers shown in accent color).
  const today = useMemo(() => new Date(), [])
  const currentWeekStart = useMemo(
    () => startOfWeek(today, weekStartWeekday),
    [today, weekStartWeekday],
  )
  const currentWeekIso = isoKey(currentWeekStart)

  // Change-point baseline: the weekly snapshot auto-captured at the start of
  // this week (lazily on first access — no cron). Comparing the live plan to it
  // highlights what changed since the start of the week. Live mode only.
  const baselineQ = useQuery({
    queryKey: ['snapshot', sheetId, currentWeekIso],
    queryFn: () => api.getSnapshot(sheetId!, currentWeekIso),
    enabled: !!sheetId && !asOfWeek,
  })

  const weeks = useMemo(() => {
    // Start ~WEEKS_BEFORE weeks before the current week so the window spans a
    // long-term range (≈3 years) with today comfortably near the left. Range
    // controls can extend the window further on either side.
    const before = WEEKS_BEFORE + Math.max(0, extraBefore)
    const start = new Date(currentWeekStart.getTime())
    start.setDate(start.getDate() - before * 7)
    const count = WEEK_COUNT + Math.max(0, extraBefore) + Math.max(0, extraAfter)
    return buildWeeks(startOfWeek(start, weekStartWeekday), count)
  }, [currentWeekStart, weekStartWeekday, extraBefore, extraAfter])

  const monthStart = useMemo(() => monthStarts(weeks), [weeks])
  const currentWeekIdx = useMemo(
    () => weekIndex(weeks, currentWeekStart),
    [weeks, currentWeekStart],
  )

  const milestonesAllLoaded = milestoneQs.every((q) => !q.isLoading)

  const model: ScheduleData = useMemo(() => {
    const columns = detailQ.data?.columns ?? []
    const sheetRows = detailQ.data?.rows ?? []

    const memberCol = pickColumn(columns, 'member')
    const statusCol = pickColumn(columns, 'status')
    const ttlCol = titleColumn(columns)
    const memberById = new Map(members.map((m) => [m.id, m]))

    // effort source: snapshot (as-of) overrides live effort when present.
    const liveEffort: Effort[] = effortQ.data ?? []
    const snapEffort: Effort[] | undefined = snapshotQ.data?.effort
    const effortSource = asOfWeek && snapEffort ? snapEffort : liveEffort

    // index effort by row -> (week_start -> effort)
    const effortByRow = new Map<string, Map<string, Effort>>()
    for (const e of effortSource) {
      let m = effortByRow.get(e.row_id)
      if (!m) {
        m = new Map()
        effortByRow.set(e.row_id, m)
      }
      m.set(e.week_start, e)
    }

    // Subtask tree: group children under their parent (one level of nesting).
    const childrenByParent = new Map<string, Row[]>()
    for (const r of sheetRows) {
      if (r.parent_row_id != null) {
        const pid = String(r.parent_row_id)
        const arr = childrenByParent.get(pid) ?? []
        arr.push(r)
        childrenByParent.set(pid, arr)
      }
    }

    // Default milestone colors by phase name (per sheet). The gantt bar color is
    // derived from the matching default — per-row colors are no longer set.
    const defaultColorByName = new Map<string, string>(
      (detailQ.data?.sheet?.settings?.default_milestones ?? []).map((d) => [d.name, d.color]),
    )

    // Baseline planned hours per row -> (week_start -> planned) from this week's
    // snapshot. Live mode only; as-of view never highlights change points.
    const baselineByRow = new Map<string, Map<string, number>>()
    if (!asOfWeek) {
      for (const e of baselineQ.data?.effort ?? []) {
        let m = baselineByRow.get(e.row_id)
        if (!m) {
          m = new Map()
          baselineByRow.set(e.row_id, m)
        }
        m.set(e.week_start, plannedOf(e))
      }
    }

    // Auto-status (Feature 6) only when the status column opts in.
    const autoStatus = statusCol?.config?.auto_from_milestones === true

    // Weekly-reset of the manual progress: show it only for the viewed week
    // (live current week, or the as-of week when stepping back).
    const progressWeeklyReset = detailQ.data?.sheet?.settings?.progress_weekly_reset === true
    const viewedWeekIso = asOfWeek ?? currentWeekIso

    const built: ScheduleRowModel[] = sheetRows.map((row, idx) => {
      // Milestone colors come from the sheet's default phase of the same name.
      const ms: Milestone[] = (milestoneQs[idx]?.data ?? []).map((m) => ({
        ...m,
        color: defaultColorByName.get(m.name) ?? m.color,
      }))

      // A parent task's effort is the roll-up of its subtasks (read-only); a
      // leaf task (childless, incl. subtasks) uses its own weekly effort.
      const childRows = childrenByParent.get(String(row.id)) ?? []
      const hasChildren = childRows.length > 0
      const effortByWeek = hasChildren
        ? aggregateChildEffort(childRows, effortByRow)
        : effortByRow.get(row.id) ?? new Map<string, Effort>()

      // Change points: a week whose planned hours differ from this week's
      // snapshot baseline (= changed since the start of this week). Roll-up
      // parents don't highlight change points (the breakdown lives on children).
      const changedWeekIdx =
        asOfWeek || hasChildren
          ? new Set<number>()
          : changedVsBaseline(weeks, effortByWeek, baselineByRow.get(row.id))

      const gantt = buildRowGantt({
        weeks,
        effortByWeek,
        milestones: ms,
        currentWeekIdx,
        changedWeekIdx,
      })

      const assigneeId = memberCol
        ? (row.data[memberCol.id] as string | null) ?? null
        : null
      const assignee = assigneeId ? memberById.get(assigneeId) ?? null : null

      let status: StatusBadge | null
      if (autoStatus) {
        status = statusFromMilestones(ms, today)
      } else {
        status = deriveStatus(row, statusCol)
        if (!status && statusCol) {
          const rawStatus = row.data[statusCol.id]
          if (rawStatus != null) status = literalStatusBadge(String(rawStatus))
        }
      }

      const title = ttlCol ? String(row.data[ttlCol.id] ?? '') : ''

      const { startIdx, finishIdx, plannedToDate } = spanAndToDate(gantt, currentWeekIdx)
      const expectedPct = gantt.plannedSum > 0 ? plannedToDate / gantt.plannedSum : 0
      // Leaf tasks use the manual %, parents get an effort-weighted roll-up below.
      let leafProgress =
        hasChildren || typeof row.progress !== 'number' ? null : row.progress
      // Weekly reset: progress shows only for the week it was entered — it clears
      // at the start of a new week, but reappears when stepping back to that week.
      if (
        leafProgress != null &&
        progressWeeklyReset &&
        row.progress_week !== viewedWeekIso
      )
        leafProgress = null

      return {
        row,
        keyValue: row.key_value,
        title,
        assigneeName: assignee?.name ?? null,
        assigneeId,
        status,
        milestones: ms,
        gantt,
        parentRowId: row.parent_row_id != null ? String(row.parent_row_id) : null,
        hasChildren,
        childCount: childRows.length,
        depth: row.parent_row_id != null ? 1 : 0,
        progress: leafProgress,
        progressRollup: hasChildren,
        expectedPct,
        behind: false, // filled in the cross-row pass below
        startIdx,
        finishIdx,
        depViolations: [], // filled in the cross-row pass below
      }
    })

    // Cross-row pass: parent progress roll-up, behind flag, and 逆ザヤ detection.
    const byId = new Map(built.map((m) => [String(m.row.id), m]))
    for (const m of built) {
      if (m.progressRollup) {
        // Effort-weighted average of children's manual progress (read-only).
        let wsum = 0
        let psum = 0
        let cnt = 0
        let psimple = 0
        for (const k of childrenByParent.get(String(m.row.id)) ?? []) {
          const km = byId.get(String(k.id))
          if (!km || km.progress == null) continue
          const w = km.gantt.plannedSum || 0
          wsum += w
          psum += km.progress * w
          cnt += 1
          psimple += km.progress
        }
        m.progress =
          cnt === 0 ? null : wsum > 0 ? Math.round(psum / wsum) : Math.round(psimple / cnt)
      }
    }
    for (const m of built) {
      m.behind =
        m.progress != null && m.gantt.plannedSum > 0 && m.progress / 100 < m.expectedPct - 0.01
      const deps = (m.row.depends_on ?? []) as Array<string | number>
      const sIdx = m.startIdx
      if (deps.length && sIdx != null) {
        const v: Array<{ predKey: string; weeks: number }> = []
        for (const pid of deps) {
          const pm = byId.get(String(pid))
          const fIdx = pm?.finishIdx
          if (!pm || fIdx == null) continue
          if (sIdx < fIdx) v.push({ predKey: pm.keyValue, weeks: fIdx - sIdx })
        }
        m.depViolations = v
      }
    }

    const loading = detailQ.isLoading || effortQ.isLoading || !milestonesAllLoaded

    if (viewMode === 'month') {
      // Aggregate the weekly model into calendar-month columns. The grid renders
      // these like weekly columns (one per month); edits distribute back to weeks.
      const cols = buildMonthCols(weeks)
      const monthWeeks = new Map<string, string[]>()
      for (const c of cols) {
        monthWeeks.set(
          isoKey(c.date),
          c.weekIdxs.map((k) => isoKey(weeks[k])),
        )
      }
      const monthIdx = cols.findIndex((c) => c.weekIdxs.includes(currentWeekIdx))
      return {
        loading,
        detail: detailQ.data,
        columns,
        weeks: cols.map((c) => c.date),
        monthStart: cols.map(() => true),
        currentWeekIdx: monthIdx < 0 ? 0 : monthIdx,
        rows: built.map((r) => ({ ...r, gantt: aggregateRowToMonths(r.gantt, cols) })),
        monthWeeks,
      }
    }

    return {
      loading,
      detail: detailQ.data,
      columns,
      weeks,
      monthStart,
      currentWeekIdx,
      rows: built,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    detailQ.data,
    detailQ.isLoading,
    effortQ.data,
    effortQ.isLoading,
    snapshotQ.data,
    baselineQ.data,
    asOfWeek,
    viewMode,
    today,
    members,
    weeks,
    monthStart,
    currentWeekIdx,
    currentWeekStart,
    milestonesAllLoaded,
    // milestoneQs identity changes each render; depend on loaded flag + data length
    milestoneQs.map((q) => q.dataUpdatedAt).join(','),
  ])

  return model
}
