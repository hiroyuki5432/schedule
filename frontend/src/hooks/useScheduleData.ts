// Loads everything the Schedule page needs for one sheet and assembles the
// per-row gantt model. Effort + milestones are fetched in batch and memoized.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import {
  addWeeks,
  buildWeeks,
  fmtISO,
  monthStarts,
  startOfWeek,
  weekIndex,
} from '@/lib/dates'
import { buildRowGantt } from '@/lib/gantt'
import type { MilestoneDisplay, RowGantt } from '@/lib/gantt'
import { periodForDate } from '@/lib/period'
import type { ClosingSettings } from '@/lib/period'
import { useOrg } from '@/hooks/useSheets'
import {
  deriveStatus,
  literalStatusBadge,
  statusFromPhases,
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
  /** Progress one week ago. 0 when last week was unset (so the week-over-week
   *  delta is visible); null only when there is no baseline at all. Leaf only. */
  progressPrev: number | null
  /** Planned/actual totals one week ago (前週), for the 予定計/実績計 delta.
   *  null when no baseline (as-of view or no previous snapshot). */
  plannedPrev: number | null
  actualPrev: number | null
  /** True when progress is a read-only roll-up (parent with children). */
  progressRollup: boolean
  /** For parents: sum of children's planned hours per week_start (合算の下限). */
  childPlannedByWeek?: Map<string, number>
  /** Fraction the plan expects done by today (planned-to-date / planned-total). */
  expectedPct: number
  /** Behind schedule: progress below the expected fraction. */
  behind: boolean
  /** Weeks behind schedule (何週遅延) when `behind`; null otherwise. Shown next to
   *  the auto-derived phase status. */
  statusDelayWeeks: number | null
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
  /** As-of view: true when the requested past week has an exact recorded
   *  snapshot. False when the data shown is the oldest available record because
   *  the requested week predates all snapshots. Undefined in live view. */
  asOfExact?: boolean
  /** As-of view: ISO week the displayed data actually represents (may be newer
   *  than the requested week when records don't go back that far). */
  asOfActualWeek?: string | null
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

/** Group Monday-anchored weeks into month columns. By default a week belongs to
 *  its start month; with a close-period (締め日) configured, it belongs to the
 *  period containing its week_start (要望: 月の集計をいつからいつまで). */
function buildMonthCols(weeks: Date[], closing?: ClosingSettings): MonthCol[] {
  const cols: MonthCol[] = []
  let i = 0
  const labelOf = (d: Date): { key: string; y: number; m0: number } => {
    if (closing && (closing.offset_business_days ?? 0) > 0) {
      const p = periodForDate(fmtISO(d), closing)
      return { key: p.label, y: p.year, m0: p.month - 1 }
    }
    return { key: `${d.getFullYear()}-${d.getMonth()}`, y: d.getFullYear(), m0: d.getMonth() }
  }
  while (i < weeks.length) {
    const head = labelOf(weeks[i])
    const weekIdxs: number[] = []
    let j = i
    while (j < weeks.length && labelOf(weeks[j]).key === head.key) {
      weekIdxs.push(j)
      j++
    }
    cols.push({ date: new Date(head.y, head.m0, 1), weekIdxs })
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

/** How many weeks behind schedule: the gap between today and the week the plan
 *  expected the current progress level to be reached (累積予定がprogress分に達する週).
 *  Null when not measurable. */
function weeksLate(
  g: RowGantt,
  currentWeekIdx: number,
  progress: number | null,
): number | null {
  if (progress == null || g.plannedSum <= 0) return null
  const target = (progress / 100) * g.plannedSum
  let cum = 0
  for (let i = 0; i < g.cells.length; i++) {
    const p = g.cells[i]?.planned ?? 0
    if (p <= 0) continue
    cum += p
    if (target <= 0 || cum >= target) return Math.max(0, currentWeekIdx - i)
  }
  return null
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

/** Roll a parent task's weekly effort up: per week, the parent's OWN effort PLUS
 *  the sum of all children's planned/actual (合算 = 親の分＋子の分). Including the
 *  parent's own entries means effort entered directly on a task is never hidden
 *  when subtasks are added — it stays in the total (past weeks included). */
function aggregateChildEffort(
  childRows: Row[],
  effortByRow: Map<string, Map<string, Effort>>,
  ownEffort?: Map<string, Effort>,
): Map<string, Effort> {
  const acc = new Map<string, { planned: number; actual: number }>()
  const addFrom = (m: Map<string, Effort> | undefined) => {
    if (!m) return
    for (const [wk, e] of m) {
      const cur = acc.get(wk) ?? { planned: 0, actual: 0 }
      cur.planned += numOf(e.planned_hours)
      cur.actual += numOf(e.actual_hours)
      acc.set(wk, cur)
    }
  }
  addFrom(ownEffort)
  for (const c of childRows) addFrom(effortByRow.get(c.id))
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

/** Sum of children's PLANNED hours per week_start — the floor a parent's combined
 *  value can't drop below (editing the parent only changes the parent's own part). */
function sumChildPlannedByWeek(
  childRows: Row[],
  effortByRow: Map<string, Map<string, Effort>>,
): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of childRows) {
    const em = effortByRow.get(c.id)
    if (!em) continue
    for (const [wk, e] of em) m.set(wk, (m.get(wk) ?? 0) + plannedOf(e))
  }
  return m
}

/**
 * Change points: a week whose current PLANNED hours differ from the PREVIOUS
 * week's snapshot baseline (the cross-section auto-captured at the start of last
 * week). So red = "changed since last week" (前週からの変更) — editing a week
 * flags only that week (each week is compared to its own value a week ago, not
 * to its neighbors). When no baseline is available, nothing is flagged.
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
  const orgQ = useOrg()
  const closing = orgQ.data?.settings?.closing

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

  // All milestones for the sheet in ONE request (was an N+1 per-row fetch, the
  // main cause of the slow schedule load).
  const milestonesQ = useQuery({
    queryKey: ['sheet-milestones', sheetId],
    queryFn: () => api.getSheetMilestones(sheetId!),
    enabled: !!sheetId,
  })
  const milestonesByRow = useMemo(() => {
    const m = new Map<string, Milestone[]>()
    for (const ms of milestonesQ.data ?? []) {
      const arr = m.get(String(ms.row_id))
      if (arr) arr.push(ms)
      else m.set(String(ms.row_id), [ms])
    }
    return m
  }, [milestonesQ.data])

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
  // Previous week's start — baseline for week-over-week change points (前週からの変更).
  const prevWeekIso = addWeeks(currentWeekIso, -1)

  // Change-point baseline: the weekly snapshot from the PREVIOUS week (前週). Each
  // week's snapshot is auto-captured on first access that week (lazily — no cron),
  // so comparing the live plan against last week's snapshot highlights exactly
  // what changed week-over-week. Using last week's (already-committed) snapshot
  // also makes this deterministic — it doesn't depend on this week's snapshot,
  // which is created by the sheet GET in a separate request. Live mode only.
  const baselineQ = useQuery({
    queryKey: ['snapshot', sheetId, prevWeekIso],
    queryFn: () => api.getSnapshot(sheetId!, prevWeekIso),
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

  const milestonesAllLoaded = !milestonesQ.isLoading

  const model: ScheduleData = useMemo(() => {
    const columns = detailQ.data?.columns ?? []
    const sheetRows = detailQ.data?.rows ?? []

    const memberCol = pickColumn(columns, 'member')
    const statusCol = pickColumn(columns, 'status')
    const ttlCol = titleColumn(columns)
    // 開始日/完了日 are real date columns (config.sched_role); legacy rows fall back
    // to the reserved __sched_start/__sched_end keys until edited.
    const startCol = columns.find((c) => c.config?.sched_role === 'start')
    const endCol = columns.find((c) => c.config?.sched_role === 'end')
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
    // Phase color by name — PHASE presets only. (A milestone preset can share a
    // name with a phase, e.g. 「リリース」; including milestones here would let the
    // milestone's neutral color clobber the phase color.)
    const defaultColorByName = new Map<string, string>(
      (detailQ.data?.sheet?.settings?.default_milestones ?? [])
        .filter((d) => d.kind !== 'milestone')
        .map((d) => [d.name, d.color]),
    )

    // Baseline planned hours per row -> (week_start -> planned) from last week's
    // snapshot. Live mode only; as-of view never highlights change points.
    const baselineByRow = new Map<string, Map<string, number>>()
    // Full baseline effort per row (planned + actual) for the 予定計/実績計 前週差分.
    const baselineEffortByRow = new Map<string, Map<string, Effort>>()
    // Last week's manual progress per row (for the 進捗 week-over-week diff).
    const prevProgressByRow = new Map<string, number>()
    // Whether last week's snapshot exists at all (else prev totals are unknown).
    const baselineAvailable = !asOfWeek && !!baselineQ.data
    if (!asOfWeek) {
      for (const e of baselineQ.data?.effort ?? []) {
        let m = baselineByRow.get(e.row_id)
        if (!m) {
          m = new Map()
          baselineByRow.set(e.row_id, m)
        }
        m.set(e.week_start, plannedOf(e))
        let me = baselineEffortByRow.get(e.row_id)
        if (!me) {
          me = new Map()
          baselineEffortByRow.set(e.row_id, me)
        }
        me.set(e.week_start, e)
      }
      for (const r of baselineQ.data?.rows ?? []) {
        if (typeof r.progress === 'number') prevProgressByRow.set(String(r.id), r.progress)
      }
    }

    // Auto-status (Feature 6) only when the status column opts in.
    const autoStatus = statusCol?.config?.auto_from_milestones === true

    // Weekly-reset of the manual progress: show it only for the viewed week
    // (live current week, or the as-of week when stepping back).
    const progressWeeklyReset = detailQ.data?.sheet?.settings?.progress_weekly_reset === true
    // Milestone diamond visibility is a sheet-wide setting (シート設定で表示制御).
    const milestoneDisplay: MilestoneDisplay =
      detailQ.data?.sheet?.settings?.milestone_display ?? 'all'
    const viewedWeekIso = asOfWeek ?? currentWeekIso

    const built: ScheduleRowModel[] = sheetRows.map((row) => {
      // Milestone colors come from the sheet's default phase of the same name.
      const ms: Milestone[] = (milestonesByRow.get(String(row.id)) ?? []).map((m) => ({
        ...m,
        color: defaultColorByName.get(m.name) ?? m.color,
      }))

      // A parent task's effort is the roll-up of its subtasks (read-only); a
      // leaf task (childless, incl. subtasks) uses its own weekly effort.
      const childRows = childrenByParent.get(String(row.id)) ?? []
      const hasChildren = childRows.length > 0
      const effortByWeek = hasChildren
        ? aggregateChildEffort(childRows, effortByRow, effortByRow.get(row.id))
        : effortByRow.get(row.id) ?? new Map<string, Effort>()

      // Change points: a week whose planned hours differ from last week's
      // snapshot baseline (= changed since last week / 前週からの変更). Roll-up
      // parents don't highlight change points (the breakdown lives on children).
      const changedWeekIdx =
        asOfWeek || hasChildren
          ? new Set<number>()
          : changedVsBaseline(weeks, effortByWeek, baselineByRow.get(row.id))

      // Task span (開始日/完了日) from the role date columns — bounds the gantt
      // coloring (範囲外は無色). Falls back to legacy reserved keys, then unbounded.
      const schedStart =
        (startCol ? (row.data[startCol.id] as string | null) : null) ??
        (row.data.__sched_start as string | null) ??
        null
      const schedEnd =
        (endCol ? (row.data[endCol.id] as string | null) : null) ??
        (row.data.__sched_end as string | null) ??
        null

      const gantt = buildRowGantt({
        weeks,
        effortByWeek,
        milestones: ms,
        currentWeekIdx,
        changedWeekIdx,
        startDate: schedStart,
        endDate: schedEnd,
        milestoneDisplay,
      })

      const assigneeId = memberCol
        ? (row.data[memberCol.id] as string | null) ?? null
        : null
      const assignee = assigneeId ? memberById.get(assigneeId) ?? null : null

      let status: StatusBadge | null
      if (autoStatus) {
        status = statusFromPhases(ms, { actualSum: gantt.actualSum })
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

      // 前週（last week's snapshot）の予定計/実績計 — parents aggregate their
      // children's baseline just like the live roll-up.
      let plannedPrev: number | null = null
      let actualPrev: number | null = null
      if (baselineAvailable) {
        const prevEffort = hasChildren
          ? aggregateChildEffort(
              childRows,
              baselineEffortByRow,
              baselineEffortByRow.get(row.id),
            )
          : baselineEffortByRow.get(row.id) ?? new Map<string, Effort>()
        let ps = 0
        let as_ = 0
        for (const e of prevEffort.values()) {
          ps += numOf(e.planned_hours)
          as_ += numOf(e.actual_hours)
        }
        plannedPrev = ps
        actualPrev = as_
      }

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
        // Week-over-week 進捗 diff (leaf only; parents are a roll-up). When last
        // week was unset, baseline = 0 so this week's value shows as +N. null
        // only when there's no baseline snapshot at all.
        progressPrev: hasChildren
          ? null
          : prevProgressByRow.get(String(row.id)) ?? (baselineAvailable ? 0 : null),
        plannedPrev,
        actualPrev,
        progressRollup: hasChildren,
        childPlannedByWeek: hasChildren
          ? sumChildPlannedByWeek(childRows, effortByRow)
          : undefined,
        expectedPct,
        behind: false, // filled in the cross-row pass below
        statusDelayWeeks: null, // filled in the cross-row pass below
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
      m.statusDelayWeeks = m.behind
        ? weeksLate(m.gantt, currentWeekIdx, m.progress)
        : null
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
      const cols = buildMonthCols(weeks, closing)
      const monthWeeks = new Map<string, string[]>()
      // Week index → its month-column index. startIdx/finishIdx were computed in
      // WEEK units (against the weekly grid); the month grid has far fewer, wider
      // columns, so the span/progress bar and dependency lines must be re-expressed
      // in month-column units or they render shifted right (バグ: 線がずれる).
      const weekToMonth = new Array(weeks.length).fill(0)
      cols.forEach((c, ci) => {
        for (const k of c.weekIdxs) weekToMonth[k] = ci
      })
      for (const c of cols) {
        monthWeeks.set(
          isoKey(c.date),
          c.weekIdxs.map((k) => isoKey(weeks[k])),
        )
      }
      const monthIdx = cols.findIndex((c) => c.weekIdxs.includes(currentWeekIdx))
      const toMonth = (i: number | null) => (i == null ? null : weekToMonth[i] ?? null)
      return {
        loading,
        detail: detailQ.data,
        columns,
        weeks: cols.map((c) => c.date),
        monthStart: cols.map(() => true),
        currentWeekIdx: monthIdx < 0 ? 0 : monthIdx,
        rows: built.map((r) => ({
          ...r,
          gantt: aggregateRowToMonths(r.gantt, cols),
          startIdx: toMonth(r.startIdx),
          finishIdx: toMonth(r.finishIdx),
        })),
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
    milestonesByRow,
    closing,
  ])

  // Surface how faithful the as-of view is, so the page can warn when a requested
  // past week has no record and the oldest available snapshot is shown instead.
  const asOfExact = asOfWeek ? snapshotQ.data?.exact ?? false : undefined
  const asOfActualWeek = asOfWeek ? snapshotQ.data?.as_of_week ?? null : undefined
  return { ...model, asOfExact, asOfActualWeek }
}
