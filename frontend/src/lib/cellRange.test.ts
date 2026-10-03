import { describe, expect, it } from 'vitest'
import { fillSeries, parseCellText, parseDateText, parseTsv, toTsv } from './cellRange'
import type { Column, Member } from '@/types/api'

const col = (type: Column['type'], config: Column['config'] = {}): Column =>
  ({ id: '1', sheet_id: '1', name: '列', order: 0, type, is_key: false, config }) as Column

const members: Member[] = [
  { id: '7', name: '佐藤', email: 's', role: 'member', worklog_required: true, is_active: true },
  { id: '8', name: '田中', email: 't', role: 'member', worklog_required: true, is_active: true },
  { id: '9', name: '田中', email: 't2', role: 'member', worklog_required: true, is_active: true },
] as Member[]

describe('parseTsv / toTsv', () => {
  it('splits rows and cells, ignoring the trailing newline Excel adds', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps a quoted cell with a line break as ONE cell (Alt+Enter in Excel)', () => {
    expect(parseTsv('"1行目\n2行目"\tx\ny\tz')).toEqual([
      ['1行目\n2行目', 'x'],
      ['y', 'z'],
    ])
    expect(parseTsv('"say ""hi"""\t')).toEqual([['say "hi"', '']])
  })

  it('round-trips through toTsv', () => {
    const m = [
      ['a', 'b\nc', 'd"e'],
      ['', 'tab\there', 'ok'],
    ]
    expect(parseTsv(toTsv(m))).toEqual(m)
  })

  it('keeps empty cells in the middle of a row', () => {
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']])
  })
})

describe('parseCellText', () => {
  it('turns an empty paste into a clear', () => {
    expect(parseCellText(col('text'), '  ', members)).toEqual({ ok: true, value: null })
  })

  it('reads numbers with commas and full-width digits', () => {
    expect(parseCellText(col('number'), '１,２３４', members)).toEqual({ ok: true, value: 1234 })
    expect(parseCellText(col('number'), 'abc', members).ok).toBe(false)
  })

  it('reads the common date spellings', () => {
    expect(parseDateText('2026/10/3')).toBe('2026-10-03')
    expect(parseDateText('2026-10-03 00:00:00')).toBe('2026-10-03')
    expect(parseDateText('2026年1月9日')).toBe('2026-01-09')
    expect(parseDateText('10/3', new Date(2027, 0, 1))).toBe('2027-10-03')
    expect(parseDateText('2026/2/30')).toBeNull()
    expect(parseCellText(col('date'), 'そのうち', members).ok).toBe(false)
  })

  it('maps a member name to its id, and refuses an ambiguous one', () => {
    expect(parseCellText(col('member'), '佐藤', members)).toEqual({ ok: true, value: 7 })
    const dup = parseCellText(col('member'), '田中', members)
    expect(dup.ok).toBe(false)
    expect(parseCellText(col('member'), '鈴木', members).ok).toBe(false)
  })

  it('accepts a dropdown value that is not listed, but flags it', () => {
    const c = col('dropdown', { options: [{ value: '済' }] } as Column['config'])
    expect(parseCellText(c, '済', members)).toEqual({ ok: true, value: '済', unlisted: false })
    expect(parseCellText(c, '保留', members)).toEqual({ ok: true, value: '保留', unlisted: true })
  })

  it('refuses computed columns instead of silently dropping', () => {
    const r = parseCellText(col('formula', { expr: '1' } as Column['config']), 'x', members)
    expect(r.ok).toBe(false)
  })
})

describe('fillSeries (Excel のフィルハンドル)', () => {
  it('copies a single number, continues two or more', () => {
    expect(fillSeries([5], 3)).toEqual([5, 5, 5])
    expect(fillSeries([1, 3], 3)).toEqual([5, 7, 9])
  })

  it('steps dates by a day, or by the given interval', () => {
    expect(fillSeries(['2026-12-30'], 3)).toEqual(['2026-12-31', '2027-01-01', '2027-01-02'])
    expect(fillSeries(['2026-10-05', '2026-10-12'], 2)).toEqual(['2026-10-19', '2026-10-26'])
  })

  it('increments a trailing number and keeps its zero padding', () => {
    expect(fillSeries(['P26-009'], 2)).toEqual(['P26-010', 'P26-011'])
    expect(fillSeries(['A1', 'A3'], 2)).toEqual(['A5', 'A7'])
  })

  it('repeats anything else', () => {
    expect(fillSeries(['済', '未'], 5)).toEqual(['済', '未', '済', '未', '済'])
    expect(fillSeries([null], 2)).toEqual([null, null])
  })

  it('goes backwards when filling upward', () => {
    expect(fillSeries(['2026-10-05'], 2, true)).toEqual(['2026-10-04', '2026-10-03'])
    expect(fillSeries([1, 3, 5], 2, true)).toEqual([-1, -3])
    expect(fillSeries(['P26-002'], 2, true)).toEqual(['P26-001', 'P26-000'])
  })
})
