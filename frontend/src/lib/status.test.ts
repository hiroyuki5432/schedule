import { describe, expect, it } from 'vitest'
import {
  badgeForRule,
  deriveStatus,
  firstMatchingRule,
  makeIsRowDone,
  resolveDisplayValue,
} from '@/lib/status'
import type { Column, Row, StatusRule } from '@/types/api'

function row(data: Record<string, string | number | null>): Row {
  return {
    id: '1',
    sheet_id: '1',
    parent_row_id: null,
    key_value: 'P26-001',
    data,
    version: 1,
    progress: null,
    progress_week: null,
    depends_on: [],
  }
}

const rule = (
  conditions: StatusRule['conditions'],
  label = 'ラベル',
  color = '#E3EFEA',
): StatusRule => ({ conditions, label, color })

describe('firstMatchingRule', () => {
  it('returns the first rule whose conditions all pass', () => {
    const rules = [
      rule([{ col_id: '10', op: '=', value: '完了' }], '完了'),
      rule([{ col_id: '10', op: '=', value: '進行中' }], '進行中'),
    ]
    expect(firstMatchingRule(row({ '10': '進行中' }), rules)).toBe(1)
  })

  it('requires EVERY condition of a rule to pass', () => {
    const rules = [
      rule([
        { col_id: '10', op: '=', value: 'A' },
        { col_id: '11', op: '>', value: 5 },
      ]),
    ]
    expect(firstMatchingRule(row({ '10': 'A', '11': 9 }), rules)).toBe(0)
    expect(firstMatchingRule(row({ '10': 'A', '11': 1 }), rules)).toBe(-1)
  })

  it('treats a rule with no conditions as always matching', () => {
    expect(firstMatchingRule(row({}), [rule([], '既定')])).toBe(0)
  })

  it('reports -1 when nothing matches, so the caller can show a blank status', () => {
    const rules = [rule([{ col_id: '10', op: '=', value: '完了' }])]
    expect(firstMatchingRule(row({ '10': '未着手' }), rules)).toBe(-1)
  })

  it('supports empty / not_empty without a comparison value', () => {
    const empty = [rule([{ col_id: '10', op: 'empty', value: null }])]
    const filled = [rule([{ col_id: '10', op: 'not_empty', value: null }])]
    expect(firstMatchingRule(row({ '10': '' }), empty)).toBe(0)
    expect(firstMatchingRule(row({ '10': 'x' }), empty)).toBe(-1)
    expect(firstMatchingRule(row({ '10': 'x' }), filled)).toBe(0)
  })
})

describe('badgeForRule', () => {
  it('picks dark ink on a pale fill and white on a dark one', () => {
    expect(badgeForRule(rule([], 'A', '#E3EFEA')).color).toBe('#3a382f')
    expect(badgeForRule(rule([], 'A', '#266B53')).color).toBe('#ffffff')
  })
})

describe('deriveStatus', () => {
  const column = (rules: StatusRule[]): Column => ({
    id: '99',
    sheet_id: '1',
    name: 'ステータス',
    type: 'status',
    order: 0,
    is_key: false,
    config: { rules },
  })

  it('returns the badge of the first matching rule', () => {
    const col = column([
      rule([{ col_id: '10', op: '=', value: '完了' }], '完了', '#E6F0DB'),
      rule([], '未着手', '#EFEDE4'),
    ])
    expect(deriveStatus(row({ '10': '完了' }), col)?.label).toBe('完了')
    expect(deriveStatus(row({ '10': 'その他' }), col)?.label).toBe('未着手')
  })

  it('returns null for a non-status column', () => {
    const notStatus = { ...column([]), type: 'text' as const }
    expect(deriveStatus(row({}), notStatus)).toBeNull()
  })
})

describe('resolveDisplayValue / makeIsRowDone', () => {
  const col = (over: Partial<Column>): Column => ({
    id: '10',
    sheet_id: '1',
    name: '列',
    type: 'text',
    order: 0,
    is_key: false,
    config: {},
    ...over,
  })
  const members = new Map([['7', '山田']])

  it('shows member names and falls back to the derived badge for status', () => {
    const member = col({ id: '20', type: 'member' })
    expect(resolveDisplayValue({ row: row({ '20': 7 }), status: null }, member, members)).toBe('山田')

    const status = col({ id: '30', type: 'status' })
    const badge = { label: '進行中', color: '#000', bg: '#fff' }
    // Stored value wins; with nothing stored the derived badge is used.
    expect(resolveDisplayValue({ row: row({ '30': '遅延' }), status: badge }, status, members)).toBe('遅延')
    expect(resolveDisplayValue({ row: row({}), status: badge }, status, members)).toBe('進行中')
  })

  it('marks 完了 from the status column when no done_filter is configured', () => {
    const status = col({ id: '30', type: 'status' })
    const isDone = makeIsRowDone([status], members)
    expect(isDone({ row: row({ '30': '完了' }), status: null })).toBe(true)
    expect(isDone({ row: row({ '30': '進行中' }), status: null })).toBe(false)
  })

  it('uses the sheet done_filter when set', () => {
    const dropdown = col({ id: '40', type: 'dropdown' })
    const isDone = makeIsRowDone([dropdown], members, {
      column_id: '40',
      values: ['出荷済', 'クローズ'],
    })
    expect(isDone({ row: row({ '40': 'クローズ' }), status: null })).toBe(true)
    expect(isDone({ row: row({ '40': '対応中' }), status: null })).toBe(false)
  })
})
