import { describe, expect, it } from 'vitest'
import { addWeeks, monthStarts, startOfWeek, weekIndex } from '@/lib/dates'

describe('startOfWeek', () => {
  it('snaps to the Monday of the week (default)', () => {
    // 2026-06-24 is a Wednesday -> Monday 2026-06-22.
    expect(startOfWeek(new Date(2026, 5, 24))).toEqual(new Date(2026, 5, 22))
  })
  it('a Monday maps to itself', () => {
    expect(startOfWeek(new Date(2026, 5, 22))).toEqual(new Date(2026, 5, 22))
  })
  it('honors a Sunday week start (7)', () => {
    // Sunday start: 2026-06-24 (Wed) -> Sunday 2026-06-21.
    expect(startOfWeek(new Date(2026, 5, 24), 7)).toEqual(new Date(2026, 5, 21))
  })
})

describe('addWeeks', () => {
  it('moves a week_start string forward/back by N weeks', () => {
    expect(addWeeks('2026-06-22', 1)).toBe('2026-06-29')
    expect(addWeeks('2026-06-22', -1)).toBe('2026-06-15')
    expect(addWeeks('2026-06-22', 0)).toBe('2026-06-22')
  })
})

describe('weekIndex', () => {
  it('locates the week containing a date', () => {
    const weeks = [new Date(2026, 5, 22), new Date(2026, 5, 29), new Date(2026, 6, 6)]
    expect(weekIndex(weeks, new Date(2026, 5, 22))).toBe(0)
    expect(weekIndex(weeks, new Date(2026, 6, 6))).toBe(2)
  })
})

describe('monthStarts', () => {
  it('flags the first week and any week starting a new month', () => {
    const weeks = [new Date(2026, 5, 22), new Date(2026, 5, 29), new Date(2026, 6, 6)]
    expect(monthStarts(weeks)).toEqual([true, false, true])
  })
})
