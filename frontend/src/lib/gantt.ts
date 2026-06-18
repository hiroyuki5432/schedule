// Builds the per-row gantt model from effort entries + milestones.
//
// Domain rules (SPEC.md 4.1 / 4.1b):
//  - Only weeks with hours > 0 are colored (zero/empty = no color).
//  - A week's bar color comes DIRECTLY from the milestone segment it falls into
//    (the milestone's own `color`); its label is the milestone's `name`.
//    There is no hardcoded phase taxonomy.
//  - Past weeks show actual hours; current/future weeks show planned.
//  - Overdue (today past a not-done boundary) recolors with the late color.
//  - A change-point week renders its number in the accent color.

import { parseDate, weekIndex } from './dates'
import type { Effort, Milestone } from '@/types/api'

/** Color used for weeks that overshoot a not-done milestone boundary. */
export const LATE_FILL = 'var(--p-late)'
/** Label shown for late/overdue segments. */
export const LATE_LABEL = '超過'

/** Fill for a week that has hours but is not inside any milestone segment. */
export const NEUTRAL_FILL = 'var(--p-neutral)'

export interface WeekCell {
  /** Hours to show on this cell (actual if past, else planned). */
  hours: number
  /** CSS color (fill) for the cell — the milestone segment's own color. */
  color: string
  /** True at the first week of a milestone segment (draws a diamond). */
  milestoneMarker: boolean
  /** Whether the milestone at this marker is done (filled vs hollow diamond). */
  milestoneDone: boolean
  /** Milestone name for this segment (tooltip / hover label). */
  phaseLabel: string
  /** This week's value changed vs the previous week. */
  changed: boolean
  /** True when this cell is in the overdue (late) overshoot. */
  late: boolean
  planned: number
  actual: number
}

export interface RowGantt {
  cells: Array<WeekCell | null>
  /** Sum of planned hours across all weeks (予定計). */
  plannedSum: number
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
  markerStart: boolean
  markerDone: boolean
  late: boolean
}

/**
 * Determine the segment (color + label) for each week index from milestone
 * boundaries. A milestone's boundary_date marks the START of its segment; the
 * segment runs until the next milestone (or the end of the window). Color and
 * label come straight from the milestone itself — no name-based taxonomy.
 */
function buildSegments(
  weeks: Date[],
  milestones: Milestone[],
  currentWeekIdx: number,
): Segment[] {
  const out: Segment[] = weeks.map(() => ({
    color: '',
    label: '',
    markerStart: false,
    markerDone: false,
    late: false,
  }))
  if (milestones.length === 0) return out

  const sorted = [...milestones].sort(
    (a, b) =>
      a.order - b.order ||
      parseDate(a.boundary_date).getTime() - parseDate(b.boundary_date).getTime(),
  )

  for (let s = 0; s < sorted.length; s++) {
    const m = sorted[s]
    const startIdx = Math.max(0, weekIndex(weeks, parseDate(m.boundary_date)))
    const nextIdx =
      s + 1 < sorted.length
        ? weekIndex(weeks, parseDate(sorted[s + 1].boundary_date))
        : weeks.length
    const color = m.color || NEUTRAL_FILL

    for (let i = startIdx; i < nextIdx && i < weeks.length; i++) {
      out[i] = {
        color,
        label: m.name,
        markerStart: i === startIdx,
        markerDone: i === startIdx ? !!m.done : false,
        late: false,
      }
    }
  }

  // Overdue: if today is past the last boundary and that milestone is not done,
  // recolor the overshoot weeks with the late color (SPEC 4.1b).
  const last = sorted[sorted.length - 1]
  if (!last.done) {
    const lastIdx = Math.max(0, weekIndex(weeks, parseDate(last.boundary_date)))
    for (let i = lastIdx; i <= currentWeekIdx && i < weeks.length; i++) {
      out[i] = { ...out[i], color: LATE_FILL, label: LATE_LABEL, late: true }
    }
  }

  return out
}

export function buildRowGantt({
  weeks,
  effortByWeek,
  milestones,
  currentWeekIdx,
  changedWeekIdx,
}: BuildArgs): RowGantt {
  const segs = buildSegments(weeks, milestones, currentWeekIdx)
  const cells: Array<WeekCell | null> = weeks.map(() => null)
  let plannedSum = 0

  weeks.forEach((w, i) => {
    const key = isoKey(w)
    const e = effortByWeek.get(key)
    const planned = num(e?.planned_hours)
    const actual = num(e?.actual_hours)
    plannedSum += planned

    const seg = segs[i]
    const past = i < currentWeekIdx
    // Past weeks show actual; current/future show planned. To avoid a
    // mysteriously blank boundary week, fall back to the other value when the
    // primary one is zero (e.g. current week with actual but no planned yet).
    const hours = past ? actual || planned : planned || actual

    // Any week with hours > 0 is shown: milestone color when inside a segment,
    // otherwise a neutral warm-gray fill (zero/empty stays uncolored).
    if (hours > 0) {
      cells[i] = {
        hours,
        color: seg.color || NEUTRAL_FILL,
        milestoneMarker: seg.markerStart,
        milestoneDone: seg.markerDone,
        phaseLabel: seg.label,
        changed: changedWeekIdx?.has(i) ?? false,
        late: seg.late,
        planned,
        actual,
      }
    } else if (seg.markerStart) {
      // Boundary with no hours: still render the diamond on an empty cell.
      cells[i] = {
        hours: 0,
        color: '',
        milestoneMarker: true,
        milestoneDone: seg.markerDone,
        phaseLabel: seg.label,
        changed: false,
        late: seg.late,
        planned,
        actual,
      }
    }
  })

  return { cells, plannedSum }
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
