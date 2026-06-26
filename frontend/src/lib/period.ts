// Monthly accounting periods with a configurable close (締め日).
//
// Model: 「月末の N 稼働日前締め」. The period labelled (year, month) ends on the
// close date = N business days before that month's last calendar day, and starts
// the day after the previous month's close. N = 0 ⇒ plain calendar months.
//
// Used everywhere a month total is shown (ダッシュボード / 日報 / スケジュール月表示)
// so 「いつからいつまで」 is consistent. Works fully offline (jpHolidays).
import { fmtISO, parseDate } from './dates'
import { isBusinessDay } from './holidays'

export interface ClosingSettings {
  /** Close N business days before month-end. Default 0 (= calendar month). */
  offset_business_days?: number
  /** Extra org-specific holidays (会社の休日), ISO dates. */
  holidays?: string[]
}

export interface MonthPeriod {
  /** YYYY-MM label of the period. */
  label: string
  year: number
  month: number // 1..12
  /** Inclusive ISO bounds. */
  start: string
  end: string
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

function lastDayOfMonth(year: number, month1: number): Date {
  return new Date(year, month1, 0) // day 0 of next month = last day of this month
}

/** Step back `n` business days from `date` (n=0 returns the date unchanged). */
export function businessDaysBefore(date: Date, n: number, holidays?: string[]): Date {
  let out = new Date(date)
  let remaining = n
  while (remaining > 0) {
    out = addDays(out, -1)
    if (isBusinessDay(out, holidays)) remaining--
  }
  return out
}

/** Close date (inclusive end) of the period labelled (year, month1). */
export function closeDate(year: number, month1: number, s: ClosingSettings): Date {
  const offset = Math.max(0, s.offset_business_days ?? 0)
  return businessDaysBefore(lastDayOfMonth(year, month1), offset, s.holidays)
}

/** Inclusive [start, end] of the period labelled (year, month1). */
export function periodBounds(
  year: number,
  month1: number,
  s: ClosingSettings,
): { start: string; end: string } {
  const end = closeDate(year, month1, s)
  const prevYear = month1 === 1 ? year - 1 : year
  const prevMonth = month1 === 1 ? 12 : month1 - 1
  const start = addDays(closeDate(prevYear, prevMonth, s), 1)
  return { start: fmtISO(start), end: fmtISO(end) }
}

/** The period (year, month) that contains the given ISO date. */
export function periodForDate(iso: string, s: ClosingSettings): { year: number; month: number; label: string } {
  const d = parseDate(iso)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  // The close offset is small, so iso belongs to its calendar month's period or
  // the next one. Check current then next.
  for (const [yy, mm] of [
    [y, m],
    [m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1],
  ] as const) {
    const b = periodBounds(yy, mm, s)
    if (iso >= b.start && iso <= b.end) return { year: yy, month: mm, label: label(yy, mm) }
  }
  // Fallback (shouldn't happen): calendar month.
  return { year: y, month: m, label: label(y, m) }
}

/** Ordered periods covering [rangeStartISO, rangeEndISO]. */
export function monthPeriods(rangeStartISO: string, rangeEndISO: string, s: ClosingSettings): MonthPeriod[] {
  if (rangeStartISO > rangeEndISO) return []
  const first = periodForDate(rangeStartISO, s)
  const last = periodForDate(rangeEndISO, s)
  const out: MonthPeriod[] = []
  let y = first.year
  let m = first.month
  // Guard against runaway loops.
  for (let i = 0; i < 600; i++) {
    const b = periodBounds(y, m, s)
    out.push({ label: label(y, m), year: y, month: m, ...b })
    if (y === last.year && m === last.month) break
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

function label(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, '0')}`
}
