// Japanese national-holiday calendar, computed (no network — works fully offline).
// Covers fixed-date holidays, Happy-Monday holidays, the spring/autumn equinoxes
// (approximation valid for 2000–2099), 振替休日 (substitute when a holiday is Sun),
// and 国民の休日 (a weekday sandwiched between two holidays). Admins can add extra
// org-specific holidays on top (会社の休日).
import { fmtISO, parseDate } from './dates'

const cache = new Map<number, Set<string>>()

function nthMonday(year: number, month0: number, n: number): Date {
  const d = new Date(year, month0, 1)
  const offset = (8 - d.getDay()) % 7 // days until first Monday (getDay: 0=Sun)
  return new Date(year, month0, 1 + offset + (n - 1) * 7)
}

/** Spring/Autumn equinox day (approximation, accurate 2000–2099). */
function equinoxDay(year: number, spring: boolean): number {
  const base = spring ? 20.8431 : 23.2488
  return Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4))
}

/** Set of ISO holiday dates for a year (national holidays only). */
export function jpHolidays(year: number): Set<string> {
  const cached = cache.get(year)
  if (cached) return cached

  const base: Date[] = [
    new Date(year, 0, 1), // 元日
    nthMonday(year, 0, 2), // 成人の日
    new Date(year, 1, 11), // 建国記念の日
    new Date(year, 1, 23), // 天皇誕生日
    new Date(year, 2, equinoxDay(year, true)), // 春分の日
    new Date(year, 3, 29), // 昭和の日
    new Date(year, 4, 3), // 憲法記念日
    new Date(year, 4, 4), // みどりの日
    new Date(year, 4, 5), // こどもの日
    nthMonday(year, 6, 3), // 海の日
    new Date(year, 7, 11), // 山の日
    nthMonday(year, 8, 3), // 敬老の日
    new Date(year, 8, equinoxDay(year, false)), // 秋分の日
    nthMonday(year, 9, 2), // スポーツの日
    new Date(year, 10, 3), // 文化の日
    new Date(year, 10, 23), // 勤労感謝の日
  ]

  const set = new Set(base.map(fmtISO))

  // 振替休日: a holiday on Sunday pushes a substitute to the next non-holiday day.
  for (const d of base) {
    if (d.getDay() === 0) {
      const sub = new Date(d)
      do {
        sub.setDate(sub.getDate() + 1)
      } while (set.has(fmtISO(sub)))
      set.add(fmtISO(sub))
    }
  }

  // 国民の休日: a weekday flanked by holidays on both sides becomes a holiday.
  for (const d of [...base]) {
    const between = new Date(d)
    between.setDate(between.getDate() + 1)
    const prev = new Date(between)
    prev.setDate(prev.getDate() - 1)
    const next = new Date(between)
    next.setDate(next.getDate() + 1)
    if (
      between.getDay() !== 0 &&
      set.has(fmtISO(prev)) &&
      set.has(fmtISO(next)) &&
      !set.has(fmtISO(between))
    ) {
      set.add(fmtISO(between))
    }
  }

  cache.set(year, set)
  return set
}

/** True when `iso` is a national holiday or one of the org's extra holidays. */
export function isHoliday(iso: string, extraHolidays?: Iterable<string>): boolean {
  const year = Number(iso.slice(0, 4))
  if (jpHolidays(year).has(iso)) return true
  if (extraHolidays) for (const h of extraHolidays) if (h === iso) return true
  return false
}

/** A business day = weekday (Mon–Fri) that is not a holiday. */
export function isBusinessDay(d: Date | string, extraHolidays?: Iterable<string>): boolean {
  const date = typeof d === 'string' ? parseDate(d) : d
  const day = date.getDay()
  if (day === 0 || day === 6) return false
  return !isHoliday(fmtISO(date), extraHolidays)
}
