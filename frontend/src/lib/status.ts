// Derives a status badge {label,color,bg} for a row from a `status`-type column's
// rule list (上から最初の一致 — first matching rule wins). SPEC 4.3.

import { parseDate } from '@/lib/dates'
import type { Column, Milestone, Row, StatusRule } from '@/types/api'

export interface StatusBadge {
  label: string
  /** text color */
  color: string
  /** background color */
  bg: string
}

// Soft background derived from a foreground hex, matching the mock's badge look.
function softBg(color: string): string {
  if (/^#([0-9a-f]{6})$/i.test(color)) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    // blend toward white
    const mix = (c: number) => Math.round(c + (255 - c) * 0.82)
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
  }
  return '#EFEDE4'
}

// Pick a readable text color for a given background. Pale fills (the default
// status palette) need dark ink; saturated/dark fills need white.
function readableInk(bg: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(bg)
  if (!m) return '#3a382f'
  const r = parseInt(bg.slice(1, 3), 16)
  const g = parseInt(bg.slice(3, 5), 16)
  const b = parseInt(bg.slice(5, 7), 16)
  // relative luminance (sRGB approximation)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#3a382f' : '#ffffff'
}

function evalCondition(
  cond: StatusRule['conditions'][number],
  row: Row,
): boolean {
  const left = row.data[cond.col_id]
  const right = cond.value
  switch (cond.op) {
    case '=':
    case '==':
    case 'eq':
      return String(left ?? '') === String(right ?? '')
    case '!=':
    case 'ne':
      return String(left ?? '') !== String(right ?? '')
    case '>':
      return Number(left) > Number(right)
    case '>=':
      return Number(left) >= Number(right)
    case '<':
      return Number(left) < Number(right)
    case '<=':
      return Number(left) <= Number(right)
    case 'contains':
      return String(left ?? '').includes(String(right ?? ''))
    case 'empty':
      return left == null || left === ''
    case 'not_empty':
      return left != null && left !== ''
    default:
      return false
  }
}

export function deriveStatus(
  row: Row,
  statusColumn: Column | undefined,
): StatusBadge | null {
  if (!statusColumn || statusColumn.type !== 'status') {
    return null
  }
  const rules = statusColumn.config?.rules ?? []
  for (const rule of rules) {
    const all = rule.conditions.every((c) => evalCondition(c, row))
    if (all) {
      return { label: rule.label, color: readableInk(rule.color), bg: rule.color }
    }
  }
  return null
}

// Fallback palette for common literal status values (used when the value is a
// plain dropdown/text rather than a rule-based status column).
const LITERAL_STATUS: Record<string, [string, string]> = {
  進行中: ['#E3EFEA', '#266B53'],
  未着手: ['#EFEDE4', '#6A675C'],
  遅延: ['#FAE6E0', '#A8442B'],
  完了: ['#E6F0DB', '#3E6D14'],
}

export function literalStatusBadge(value: string): StatusBadge | null {
  if (!value) return null
  const hit = LITERAL_STATUS[value]
  if (hit) return { label: value, bg: hit[0], color: hit[1] }
  return { label: value, bg: '#EFEDE4', color: '#6A675C' }
}

/**
 * Auto-derive a status badge from a row's milestones + today (Feature 6):
 *   all milestones done                              → 完了
 *   a boundary < today exists that is not done       → 遅延
 *   any milestone done, or today ≥ earliest boundary → 進行中
 *   else                                             → 未着手
 * Reuses the literal status palette. Returns null when there are no milestones.
 */
export function statusFromMilestones(
  milestones: Milestone[],
  today: Date = new Date(),
): StatusBadge | null {
  if (milestones.length === 0) return null
  const t = today.getTime()

  if (milestones.every((m) => m.done)) return literalStatusBadge('完了')

  const overdue = milestones.some(
    (m) => !m.done && parseDate(m.boundary_date).getTime() < t,
  )
  if (overdue) return literalStatusBadge('遅延')

  const earliest = Math.min(
    ...milestones.map((m) => parseDate(m.boundary_date).getTime()),
  )
  if (milestones.some((m) => m.done) || t >= earliest)
    return literalStatusBadge('進行中')

  return literalStatusBadge('未着手')
}

/** Default status values offered even when not yet present in the data. */
export const DEFAULT_STATUS_VALUES = ['未着手', '進行中', '完了', '遅延']

export interface StatusOption {
  value: string
  badge: StatusBadge
}

/**
 * Build the editable option list for a `status` column:
 *   union of rule labels, config.options values, distinct values already present
 *   across `rows` for this column, and the defaults — de-duped, order preserved.
 * Each option carries its badge (rule color wins, else literal palette).
 */
export function statusOptions(column: Column, rows: Row[]): StatusOption[] {
  const colorByLabel = new Map<string, string>()
  const order: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown, color?: string) => {
    const v = value == null ? '' : String(value)
    if (!v) return
    if (color && !colorByLabel.has(v)) colorByLabel.set(v, color)
    if (!seen.has(v)) {
      seen.add(v)
      order.push(v)
    }
  }

  for (const rule of column.config?.rules ?? []) add(rule.label, rule.color)
  for (const opt of column.config?.options ?? []) add(opt.value, opt.color)
  for (const r of rows) add(r.data[column.id])
  for (const d of DEFAULT_STATUS_VALUES) add(d)

  return order.map((value) => {
    const ruleColor = colorByLabel.get(value)
    const badge = ruleColor
      ? { label: value, color: readableInk(ruleColor), bg: ruleColor }
      : literalStatusBadge(value)!
    return { value, badge }
  })
}

export { softBg }
