// Excel-style per-column header filters. A column's filter kind is derived from
// its type: dates filter by a year>month>day tree, numbers by a value checklist
// OR a condition (=, ≠, >, ≥, <, ≤, between), everything else by a checked set of
// distinct values.

import type { Column } from '@/types/api'

/** Numeric condition operators (数値フィルター). */
export type NumOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'between'

export type ColFilter =
  | { kind: 'values'; values: string[] }
  // Checked 'YYYY-MM-DD' day keys (or '' for blank). Date columns.
  | { kind: 'dates'; dates: string[] }
  // Numeric condition. `a` is the primary value; `b` only for 'between'.
  | { kind: 'number'; op: NumOp; a: number | null; b: number | null }

export type ColFilterKind = ColFilter['kind']

export interface ColFilterOptions {
  kind: ColFilterKind
  /** 'values': distinct display values. 'dates': 'YYYY-MM-DD' keys. 'number':
   *  distinct numeric strings (for the value checklist). */
  values: string[]
  /** Any row has a blank / non-parsable value in this column. */
  hasBlank: boolean
  /** Data range for 'number' columns (null when no numeric values present). */
  numMin: number | null
  numMax: number | null
}

/** Which filter UI a column type uses. */
export function filterKindOf(col: Column): ColFilterKind {
  if (col.type === 'date') return 'dates'
  if (col.type === 'number') return 'number'
  return 'values'
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** 'YYYY-MM-DD' day key for a raw date string; '' when not a date. */
export function dayKey(raw: string): string {
  const m = DATE_RE.exec(raw)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** Split a 'YYYY-MM-DD' key into { year, month, day } string parts. */
export function dayParts(key: string): { y: string; m: string; d: string } {
  const [y, m, d] = key.split('-')
  return { y, m, d }
}

export function yearLabel(y: string): string {
  return `${y}年`
}
export function monthLabel(m: string): string {
  return `${Number(m)}月`
}
export function dayLabel(d: string): string {
  return `${Number(d)}日`
}

/** Does a row's resolved value pass this column filter? */
export function matchColFilter(f: ColFilter, raw: string): boolean {
  if (f.kind === 'values') return f.values.includes(raw)
  if (f.kind === 'dates') return f.dates.includes(dayKey(raw))
  // number condition
  const n = raw === '' ? NaN : Number(raw)
  if (f.op === 'ne') {
    // "not equal" keeps blanks/non-numeric (they aren't equal to the value).
    if (!Number.isFinite(n)) return true
    return f.a == null || n !== f.a
  }
  if (!Number.isFinite(n)) return false
  switch (f.op) {
    case 'eq':
      return f.a == null || n === f.a
    case 'gt':
      return f.a == null || n > f.a
    case 'ge':
      return f.a == null || n >= f.a
    case 'lt':
      return f.a == null || n < f.a
    case 'le':
      return f.a == null || n <= f.a
    case 'between':
      if (f.a != null && n < f.a) return false
      if (f.b != null && n > f.b) return false
      return true
  }
  return true
}

/** Build option metadata for each column from the (unfiltered) rows. */
export function buildColFilterOptions<R>(
  cols: Column[],
  rows: R[],
  resolveValue: (r: R, col: Column) => string,
): Map<string, ColFilterOptions> {
  const out = new Map<string, ColFilterOptions>()
  for (const col of cols) {
    const kind = filterKindOf(col)
    let hasBlank = false
    if (kind === 'number') {
      let numMin: number | null = null
      let numMax: number | null = null
      const set = new Set<string>()
      for (const r of rows) {
        const raw = resolveValue(r, col)
        const n = raw === '' ? NaN : Number(raw)
        if (!Number.isFinite(n)) {
          hasBlank = true
          continue
        }
        set.add(raw)
        numMin = numMin == null ? n : Math.min(numMin, n)
        numMax = numMax == null ? n : Math.max(numMax, n)
      }
      out.set(String(col.id), {
        kind,
        values: [...set].sort((a, b) => Number(a) - Number(b)),
        hasBlank,
        numMin,
        numMax,
      })
    } else if (kind === 'dates') {
      const set = new Set<string>()
      for (const r of rows) {
        const dk = dayKey(resolveValue(r, col))
        if (dk) set.add(dk)
        else hasBlank = true
      }
      out.set(String(col.id), {
        kind,
        values: [...set].sort(),
        hasBlank,
        numMin: null,
        numMax: null,
      })
    } else {
      const set = new Set<string>()
      for (const r of rows) {
        const raw = resolveValue(r, col)
        if (raw) set.add(raw)
        else hasBlank = true
      }
      out.set(String(col.id), {
        kind,
        values: [...set].sort((a, b) => a.localeCompare(b, 'ja')),
        hasBlank,
        numMin: null,
        numMax: null,
      })
    }
  }
  return out
}
