import { describe, expect, it } from 'vitest'
import { phaseWeightByName, redistributeMilestones } from './milestones'
import type { DefaultMilestone, Milestone } from '@/types/api'

function ms(partial: Partial<Milestone>): Milestone {
  return {
    id: 'x',
    row_id: '1',
    name: '',
    kind: 'phase',
    boundary_date: '',
    color: '#000',
    order: 0,
    done: false,
    actual_date: null,
    ...partial,
  }
}

describe('redistributeMilestones', () => {
  const defaults: DefaultMilestone[] = [
    { name: '設計', color: '#a', kind: 'phase', weight: 1 },
    { name: '実装', color: '#b', kind: 'phase', weight: 1 },
  ]
  const weights = phaseWeightByName(defaults)

  it('places a mid milestone by cumulative phase weight and snaps phases to it', () => {
    const items: Milestone[] = [
      ms({ id: '1', name: '設計', kind: 'phase', order: 0 }),
      ms({ id: '2', name: 'レビュー', kind: 'milestone', order: 1 }),
      ms({ id: '3', name: '実装', kind: 'phase', order: 2 }),
    ]
    const out = redistributeMilestones(items, '2026-01-01', '2026-01-31', weights)
    const byId = Object.fromEntries(out.map((m) => [m.id, m]))
    // First phase → 開始日; milestone at the 50% point (1 of 2 phase-weights); last
    // phase inherits the preceding milestone's date.
    expect(byId['1'].boundary_date).toBe('2026-01-01')
    expect(byId['2'].boundary_date).toBe('2026-01-16')
    expect(byId['3'].boundary_date).toBe('2026-01-16')
  })

  it('preserves done / actual_date and returns unchanged without both bounds', () => {
    const items: Milestone[] = [
      ms({ id: '2', name: 'レビュー', kind: 'milestone', order: 0, done: true, actual_date: '2026-02-05' }),
    ]
    expect(redistributeMilestones(items, '', '2026-01-31', weights)).toEqual(items)
    const out = redistributeMilestones(items, '2026-01-01', '2026-01-31', weights)
    expect(out[0].done).toBe(true)
    expect(out[0].actual_date).toBe('2026-02-05')
  })
})
