import { describe, expect, it } from 'vitest'
import { jpHolidays, isBusinessDay } from './holidays'
import { closeDate, monthPeriods, periodBounds, periodForDate } from './period'
import { fmtISO } from './dates'

describe('jpHolidays', () => {
  it('includes fixed and computed holidays', () => {
    const h = jpHolidays(2026)
    expect(h.has('2026-01-01')).toBe(true) // 元日
    expect(h.has('2026-05-03')).toBe(true) // 憲法記念日
    expect(h.has('2026-05-06')).toBe(true) // 振替休日 (5/3 is Sunday in 2026)
    expect(h.has('2026-11-23')).toBe(true) // 勤労感謝の日
  })

  it('treats weekends and holidays as non-business days', () => {
    expect(isBusinessDay('2026-01-01')).toBe(false) // holiday
    expect(isBusinessDay('2026-01-03')).toBe(false) // Saturday
    expect(isBusinessDay('2026-01-05')).toBe(true) // Monday, no holiday
  })
})

describe('period (月末のN稼働日前締め)', () => {
  it('offset 0 = plain calendar month', () => {
    const b = periodBounds(2026, 6, { offset_business_days: 0 })
    expect(b.start).toBe('2026-06-01')
    expect(b.end).toBe('2026-06-30')
  })

  it('offset N moves the close back N business days', () => {
    // 2026-06-30 is a Tuesday; 4 business days before = 2026-06-24 (Wed).
    const end = fmtISO(closeDate(2026, 6, { offset_business_days: 4 }))
    expect(end).toBe('2026-06-24')
    const b = periodBounds(2026, 6, { offset_business_days: 4 })
    // May 2026 ends Sun 05-31; 4 business days back = 05-26 close → June starts 05-27.
    expect(b.start).toBe('2026-05-27')
    expect(b.end).toBe('2026-06-24')
  })

  it('periodForDate finds the containing period across the boundary', () => {
    const s = { offset_business_days: 4 }
    // 2026-06-25 falls AFTER June's close (06-24) → belongs to July's period.
    expect(periodForDate('2026-06-25', s).month).toBe(7)
    // 2026-06-24 is June's close → June.
    expect(periodForDate('2026-06-24', s).month).toBe(6)
  })

  it('monthPeriods covers the range contiguously', () => {
    const ps = monthPeriods('2026-01-01', '2026-03-31', { offset_business_days: 2 })
    expect(ps.length).toBeGreaterThanOrEqual(3)
    // Each period starts the day after the previous one ends.
    for (let i = 1; i < ps.length; i++) {
      const prevEnd = new Date(ps[i - 1].end)
      const curStart = new Date(ps[i].start)
      expect((curStart.getTime() - prevEnd.getTime()) / 86400000).toBe(1)
    }
  })
})
