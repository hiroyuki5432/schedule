// Phase/milestone date distribution shared by the milestone editor (modal) and
// the schedule's inline 開始日/完了日 columns. The KEY idea (入力最小化): a row only
// needs a 開始日 and 完了日; each ◇ milestone's date is auto-placed across that span
// by cumulative phase weight (割合), and each phase's boundary is the preceding
// milestone's date (first phase → 開始日).

import { fmtISO, parseDate } from '@/lib/dates'
import type { DefaultMilestone, Milestone } from '@/types/api'

/** Phase weights (割合) keyed by phase name, from the sheet's default milestones. */
export function phaseWeightByName(defaults: DefaultMilestone[]): Map<string, number> {
  return new Map(
    defaults
      .filter((d) => d.kind !== 'milestone')
      .map((d) => [d.name, Math.max(0, d.weight ?? 1)]),
  )
}

/**
 * Re-place every milestone/phase date across [start, end] by cumulative phase
 * weight. Milestones (◇) get a date proportional to the phase weight preceding
 * them; phases inherit the date of the milestone before them (or 開始日). All
 * other fields (id/name/kind/order/done/actual_date/color) are preserved.
 *
 * Returns the list unchanged when either bound is missing.
 */
export function redistributeMilestones(
  milestones: Milestone[],
  start: string,
  end: string,
  weightByName: Map<string, number>,
): Milestone[] {
  const items = [...milestones].sort((a, b) => a.order - b.order)
  if (!start || !end) return items

  const startT = parseDate(start).getTime()
  const span = parseDate(end).getTime() - startT
  const weightOf = (name: string) => weightByName.get(name) ?? 1

  let total = 0
  for (const it of items) if (it.kind === 'phase') total += weightOf(it.name)
  if (total <= 0) total = items.filter((it) => it.kind === 'phase').length || 1

  // Pass 1: place each milestone by the cumulative weight of preceding phases.
  let cum = 0
  const dated = items.map((it) => {
    if (it.kind === 'phase') {
      cum += weightOf(it.name)
      return it
    }
    const frac = Math.max(0, Math.min(1, cum / total))
    return { ...it, boundary_date: fmtISO(new Date(startT + frac * span)) }
  })

  // Pass 2: a phase's boundary is the preceding milestone's date (first → start).
  let lastMs = start
  return dated.map((it) => {
    if (it.kind === 'milestone') {
      lastMs = it.boundary_date
      return it
    }
    return { ...it, boundary_date: lastMs }
  })
}
