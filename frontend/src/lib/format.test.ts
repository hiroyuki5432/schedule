import { describe, expect, it } from 'vitest'
import { normalizeDateForSort } from './format'

describe('normalizeDateForSort', () => {
  it('keeps real date strings', () => {
    expect(normalizeDateForSort('2026-06-26')).toBe('2026-06-26')
  })

  it('treats placeholder dashes as empty (so they sort last)', () => {
    for (const dash of ['-', '－', '−', '—', '–', 'ー', ' - ', '']) {
      expect(normalizeDateForSort(dash)).toBe('')
    }
  })

  it('handles null/undefined', () => {
    expect(normalizeDateForSort(null)).toBe('')
    expect(normalizeDateForSort(undefined)).toBe('')
  })
})
