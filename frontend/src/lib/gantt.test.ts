import { describe, expect, it } from 'vitest'
import { buildRowGantt } from './gantt'
import { parseDate } from './dates'
import type { Effort, Milestone } from '@/types/api'

const MS_WEEK = 7 * 24 * 60 * 60 * 1000

/** Five Monday-anchored weeks starting 2026-01-05. */
const weeks = Array.from(
  { length: 5 },
  (_, i) => new Date(parseDate('2026-01-05').getTime() + i * MS_WEEK),
)

function ms(partial: Partial<Milestone>): Milestone {
  return {
    id: 'x',
    row_id: '1',
    name: '',
    kind: 'milestone',
    boundary_date: '',
    color: '#000',
    order: 0,
    done: false,
    actual_date: null,
    ...partial,
  }
}

// Milestone-kind entries at weeks 1, 2 and 4 (by boundary_date + order).
const milestones: Milestone[] = [
  ms({ id: 'a', name: 'M1', order: 0, boundary_date: '2026-01-12' }),
  ms({ id: 'b', name: 'M2', order: 1, boundary_date: '2026-01-19' }),
  ms({ id: 'c', name: 'M3', order: 2, boundary_date: '2026-02-02' }),
]

function markerIdxs(display: 'all' | 'none' | 'last'): number[] {
  const g = buildRowGantt({
    weeks,
    effortByWeek: new Map<string, Effort>(),
    milestones,
    currentWeekIdx: 0,
    milestoneDisplay: display,
  })
  return g.cells
    .map((c, i) => (c?.milestoneMarker ? i : -1))
    .filter((i) => i >= 0)
}

describe('buildRowGantt milestoneDisplay', () => {
  it("'all' (default) draws every milestone diamond", () => {
    expect(markerIdxs('all')).toEqual([1, 2, 4])
  })

  it("'none' draws no diamonds", () => {
    expect(markerIdxs('none')).toEqual([])
  })

  it("'last' draws only the final milestone diamond", () => {
    expect(markerIdxs('last')).toEqual([4])
  })
})
