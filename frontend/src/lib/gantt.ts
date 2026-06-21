// Builds the per-row gantt model from effort entries + milestones.
//
// Domain rules (SPEC.md 4.1 / 4.1b):
//  - Only weeks with hours > 0 are colored (zero/empty = no color).
//  - A week's bar color comes DIRECTLY from the milestone segment it falls into
//    (the milestone's own `color`); its label is the milestone's `name`.
//  - Past weeks show actual hours; current/future weeks show planned.
//  - Overdue (today past a not-done boundary) recolors with the late color.
//  - A change-point week renders its number in the accent color.
//  - Milestones show a HOLLOW diamond at the planned boundary and a FILLED
//    diamond at the actual completion week (実績完了日); the gap = 遅延.

import { parseDate, weekIndex } from './dates'
import type { Effort, Milestone } from '@/types/api'

/** Color used for weeks that overshoot a not-done milestone boundary. */
export const LATE_FILL = 'var(--p-late)'
/** Label shown for late/overdue segments. */
export const LATE_LABEL = '超過'

/** Fill for a week that has hours but is not inside any milestone segment. */
export const NEUTRAL_FILL = 'var(--p-neutral)'

const DAY_MS = 24 * 60 * 60 * 1000

export interface WeekCell {
  /** Hours to show on this cell (actual if past, else planned). */
  hours: number
  /** CSS color (fill) for the cell — the milestone segment's own color. */
  color: string
  /** Planned milestone boundary here → draw a HOLLOW diamond (予定). */
  milestoneMarker: boolean
  /** Actual milestone completion here → draw a FILLED diamond (実績). */
  milestoneActual: boolean
  /** Whether the milestone is done (for tooltip text). */
  milestoneDone: boolean
  /** Milestone name for this segment (tooltip / hover label). */
  phaseLabel: string
  /** This week's value changed vs the previous week. */
  changed: boolean
  /** True when this cell is in the overdue (late) overshoot. */
  late: boolean
  planned: number
  actual: number
  /** Milestone tooltip data (when a marker is present). */
  msPlannedDate: string | null
  msActualDate: string | null
  /** Actual − planned, in days (+ = late). Null until completed. */
  msDelayDays: number | null
}

export interface RowGantt {
  cells: Array<WeekCell | null>
  /** Sum of planned hours across all weeks (予定計). */
  plannedSum: number
  /** Sum of actual hours across all weeks (実績計). */
  actualSum: number
}

interface BuildArgs {
  weeks: Date[]
  /** week_start (YYYY-MM-DD) -> effort for this row. */
  effortByWeek: Map<string, Effort>
  milestones: Milestone[]
  /** Index of the current week (today). */
  currentWeekIdx: number
  /** Week indices that changed vs the previous week (change points). */
  changedWeekIdx?: Set<number>
}

interface Segment {
  color: string
  label: string
  late: boolean
}

interface MarkerInfo {
  label: string
  planned: string | null
  actual: string | null
  delay: number | null
  done: boolean
}

/** Per-week color + label from milestone segments (boundary → next boundary). */
function buildSegments(
  weeks: Date[],
  sorted: Milestone[],
  currentWeekIdx: number,
): Segment[] {
  const out: Segment[] = weeks.map(() => ({ color: '', label: '', late: false }))
  if (sorted.length === 0) return out

  for (let s = 0; s < sorted.length; s++) {
    const m = sorted[s]
    const startIdx = Math.max(0, weekIndex(weeks, parseDate(m.boundary_date)))
    const nextIdx =
      s + 1 < sorted.length
        ? weekIndex(weeks, parseDate(sorted[s + 1].boundary_date))
        : weeks.length
    const color = m.color || NEUTRAL_FILL
    for (let i = startIdx; i < nextIdx && i < weeks.length; i++) {
      out[i] = { color, label: m.name, late: false }
    }
  }

  // Overdue: if today is past the last boundary and that milestone is not done,
  // recolor the overshoot weeks with the late color (SPEC 4.1b).
  const last = sorted[sorted.length - 1]
  if (!last.done) {
    const lastIdx = Math.max(0, weekIndex(weeks, parseDate(last.boundary_date)))
    for (let i = lastIdx; i <= currentWeekIdx && i < weeks.length; i++) {
      out[i] = { color: LATE_FILL, label: LATE_LABEL, late: true }
    }
  }
  return out
}

/** Planned (boundary) + actual (completion) diamond positions by week index. */
function buildMarkers(weeks: Date[], sorted: Milestone[]) {
  const planned = new Map<number, MarkerInfo>()
  const actual = new Map<number, MarkerInfo>()
  const inRange = (i: number) => i >= 0 && i < weeks.length
  for (const m of sorted) {
    const pIdx = weekIndex(weeks, parseDate(m.boundary_date))
    const actualDate = m.actual_date ?? null
    // Actual diamond: at the actual_date week; fall back to the boundary when
    // the milestone is done but no explicit date was recorded (legacy data).
    const aIdx = actualDate
      ? weekIndex(weeks, parseDate(actualDate))
      : m.done
        ? pIdx
        : null
    const delay = actualDate
      ? Math.round(
          (parseDate(actualDate).getTime() - parseDate(m.boundary_date).getTime()) / DAY_MS,
        )
      : null
    const info: MarkerInfo = {
      label: m.name,
      planned: m.boundary_date,
      actual: actualDate,
      delay,
      done: !!m.done,
    }
    if (inRange(pIdx)) planned.set(pIdx, info)
    if (aIdx != null && inRange(aIdx)) actual.set(aIdx, info)
  }
  return { planned, actual }
}

export function buildRowGantt({
  weeks,
  effortByWeek,
  milestones,
  currentWeekIdx,
  changedWeekIdx,
}: BuildArgs): RowGantt {
  const sorted = [...milestones].sort(
    (a, b) =>
      a.order - b.order ||
      parseDate(a.boundary_date).getTime() - parseDate(b.boundary_date).getTime(),
  )
  const segs = buildSegments(weeks, sorted, currentWeekIdx)
  const { planned: plannedM, actual: actualM } = buildMarkers(weeks, sorted)
  const cells: Array<WeekCell | null> = weeks.map(() => null)
  let plannedSum = 0
  let actualSum = 0

  weeks.forEach((w, i) => {
    const key = isoKey(w)
    const e = effortByWeek.get(key)
    const planned = num(e?.planned_hours)
    const actual = num(e?.actual_hours)
    plannedSum += planned
    actualSum += actual

    const seg = segs[i]
    const past = i < currentWeekIdx
    const hours = past ? actual || planned : planned || actual

    const info = actualM.get(i) ?? plannedM.get(i) ?? null
    const marker = {
      milestoneMarker: plannedM.has(i),
      milestoneActual: actualM.has(i),
      milestoneDone: info?.done ?? false,
      msPlannedDate: info?.planned ?? null,
      msActualDate: info?.actual ?? null,
      msDelayDays: info?.delay ?? null,
    }
    const hasMarker = marker.milestoneMarker || marker.milestoneActual

    if (hours > 0) {
      cells[i] = {
        hours,
        color: seg.color || NEUTRAL_FILL,
        phaseLabel: seg.label,
        changed: changedWeekIdx?.has(i) ?? false,
        late: seg.late,
        planned,
        actual,
        ...marker,
      }
    } else if (hasMarker) {
      // Boundary / completion with no hours: still render the diamond.
      cells[i] = {
        hours: 0,
        color: '',
        phaseLabel: info?.label ?? seg.label,
        changed: false,
        late: seg.late,
        planned,
        actual,
        ...marker,
      }
    }
  })

  return { cells, plannedSum, actualSum }
}

// Defensive numeric coercion: backend may return hours as a JSON number, but
// older payloads (or other callers) can hand us a numeric string. Accept both.
function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function isoKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
