// Week math helpers. Weeks are Monday-anchored (ISO), stored as YYYY-MM-DD.

export const MS_WEEK = 7 * 24 * 60 * 60 * 1000

/** Parse a YYYY-MM-DD string into a local Date at midnight. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Format a Date as YYYY-MM-DD (local). */
export function fmtISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Short M/D label used in the gantt. */
export function fmtMD(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * Normalize a date to the Monday of its week.
 * `weekStartWeekday` is 1..7 (1 = Mon) per org settings; defaults to Monday.
 */
export function startOfWeek(d: Date, weekStartWeekday = 1): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  // JS getDay(): 0 = Sun .. 6 = Sat. Convert org weekday (1..7, 1=Mon) to JS.
  const target = weekStartWeekday % 7 // 1=Mon -> 1, 7=Sun -> 0
  const diff = (out.getDay() - target + 7) % 7
  out.setDate(out.getDate() - diff)
  return out
}

/** Build `count` consecutive Monday-anchored weeks starting at `start`. */
export function buildWeeks(start: Date, count: number): Date[] {
  const base = start.getTime()
  const weeks: Date[] = []
  for (let i = 0; i < count; i++) weeks.push(new Date(base + i * MS_WEEK))
  return weeks
}

/** Index of the week containing `d` within `weeks` (clamped to range). */
export function weekIndex(weeks: Date[], d: Date): number {
  if (weeks.length === 0) return -1
  return Math.round((d.getTime() - weeks[0].getTime()) / MS_WEEK)
}

/** Add weeks to a YYYY-MM-DD week_start string. */
export function addWeeks(weekStart: string, n: number): string {
  return fmtISO(new Date(parseDate(weekStart).getTime() + n * MS_WEEK))
}

/** For each week, true when it begins a new calendar month (for the month header). */
export function monthStarts(weeks: Date[]): boolean[] {
  return weeks.map(
    (w, i) => i === 0 || w.getMonth() !== weeks[i - 1].getMonth(),
  )
}
