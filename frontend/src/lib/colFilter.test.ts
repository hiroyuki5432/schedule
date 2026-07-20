import { describe, expect, it } from 'vitest'
import {
  buildColFilterOptions,
  dayKey,
  filterKindOf,
  matchColFilter,
} from './colFilter'
import type { ColFilter } from './colFilter'
import type { Column } from '@/types/api'

function col(partial: Partial<Column>): Column {
  return {
    id: 'c',
    sheet_id: '1',
    name: '',
    type: 'text',
    order: 0,
    is_key: false,
    config: {},
    ...partial,
  } as Column
}

describe('dayKey', () => {
  it('extracts YYYY-MM-DD from a date, else blank', () => {
    expect(dayKey('2026-01-15')).toBe('2026-01-15')
    expect(dayKey('2026-12-31T09:00')).toBe('2026-12-31')
    expect(dayKey('-')).toBe('')
    expect(dayKey('')).toBe('')
  })
})

describe('filterKindOf', () => {
  it('maps column type to a filter kind', () => {
    expect(filterKindOf(col({ type: 'date' }))).toBe('dates')
    expect(filterKindOf(col({ type: 'number' }))).toBe('number')
    expect(filterKindOf(col({ type: 'text' }))).toBe('values')
    expect(filterKindOf(col({ type: 'member' }))).toBe('values')
  })
})

describe('matchColFilter', () => {
  it('values: passes only checked values', () => {
    const f: ColFilter = { kind: 'values', values: ['A', 'B'] }
    expect(matchColFilter(f, 'A')).toBe(true)
    expect(matchColFilter(f, 'C')).toBe(false)
    expect(matchColFilter({ kind: 'values', values: [''] }, '')).toBe(true)
  })

  it('dates: passes rows whose day is checked', () => {
    const f: ColFilter = { kind: 'dates', dates: ['2026-01-15'] }
    expect(matchColFilter(f, '2026-01-15')).toBe(true)
    expect(matchColFilter(f, '2026-01-16')).toBe(false)
    expect(matchColFilter(f, '')).toBe(false)
    expect(matchColFilter({ kind: 'dates', dates: [''] }, '-')).toBe(true)
  })

  it('number: honours each operator; blanks excluded except for ≠', () => {
    expect(matchColFilter({ kind: 'number', op: 'eq', a: 5, b: null }, '5')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'eq', a: 5, b: null }, '6')).toBe(false)
    expect(matchColFilter({ kind: 'number', op: 'ne', a: 5, b: null }, '6')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'ne', a: 5, b: null }, '5')).toBe(false)
    expect(matchColFilter({ kind: 'number', op: 'ne', a: 5, b: null }, '')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'gt', a: 5, b: null }, '6')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'gt', a: 5, b: null }, '5')).toBe(false)
    expect(matchColFilter({ kind: 'number', op: 'ge', a: 5, b: null }, '5')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'lt', a: 5, b: null }, '4')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'le', a: 5, b: null }, '5')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'between', a: 3, b: 7 }, '5')).toBe(true)
    expect(matchColFilter({ kind: 'number', op: 'between', a: 3, b: 7 }, '8')).toBe(false)
    expect(matchColFilter({ kind: 'number', op: 'ge', a: 5, b: null }, '')).toBe(false)
  })
})

describe('buildColFilterOptions', () => {
  const cols = [
    col({ id: 'name', type: 'text' }),
    col({ id: 'due', type: 'date' }),
    col({ id: 'hours', type: 'number' }),
  ]
  const rows = [
    { name: 'B', due: '2026-02-10', hours: '8' },
    { name: 'A', due: '2026-01-05', hours: '3' },
    { name: '', due: '-', hours: '' },
  ]
  const resolve = (r: (typeof rows)[number], c: Column) =>
    String((r as Record<string, string>)[c.id] ?? '')

  const opts = buildColFilterOptions(cols, rows, resolve)

  it('text: sorted distinct values + blank flag', () => {
    const o = opts.get('name')!
    expect(o.kind).toBe('values')
    expect(o.values).toEqual(['A', 'B'])
    expect(o.hasBlank).toBe(true)
  })

  it('date: sorted day keys + blank flag', () => {
    const o = opts.get('due')!
    expect(o.kind).toBe('dates')
    expect(o.values).toEqual(['2026-01-05', '2026-02-10'])
    expect(o.hasBlank).toBe(true)
  })

  it('number: distinct values (numeric sort), range + blank flag', () => {
    const o = opts.get('hours')!
    expect(o.kind).toBe('number')
    expect(o.values).toEqual(['3', '8'])
    expect(o.numMin).toBe(3)
    expect(o.numMax).toBe(8)
    expect(o.hasBlank).toBe(true)
  })
})
