import { describe, expect, it } from 'vitest'
import { isComputed, makeComputedResolver } from './computed'
import type { Column, Row } from '@/types/api'

const col = (id: string, name: string, type: Column['type'], config: object = {}): Column => ({
  id,
  sheet_id: '1',
  name,
  type,
  order: Number(id),
  is_key: false,
  config,
})

const row = (id: string, data: Record<string, unknown>, key = 'A-1'): Row =>
  ({ id, sheet_id: '1', key_value: key, data, parent_row_id: null }) as unknown as Row

describe('isComputed', () => {
  it('covers lookup and formula only', () => {
    expect(isComputed(col('1', 'x', 'formula'))).toBe(true)
    expect(isComputed(col('1', 'x', 'lookup'))).toBe(true)
    expect(isComputed(col('1', 'x', 'number'))).toBe(false)
    expect(isComputed(null)).toBe(false)
  })
})

describe('makeComputedResolver', () => {
  const unit = col('1', '単価', 'number')
  const qty = col('2', '数量', 'number')
  const amount = col('3', '金額', 'formula', { expr: '[単価] * [数量]' })

  it('computes a formula from the same row', () => {
    const resolve = makeComputedResolver([unit, qty, amount], {})
    expect(resolve(amount, row('10', { 1: 1200, 2: 3 }))).toBe('3600')
  })

  it('applies the decimals setting', () => {
    const rate = col('4', '率', 'formula', { expr: '[単価] / [数量]', decimals: 1 })
    const resolve = makeComputedResolver([unit, qty, rate], {})
    expect(resolve(rate, row('10', { 1: 10, 2: 3 }))).toBe('3.3')
  })

  it('reads a member column by name, not by id', () => {
    const owner = col('5', '担当', 'member')
    const label = col('6', '表示', 'formula', { expr: '[担当] & " さん"' })
    const resolve = makeComputedResolver([owner, label], {}, [
      { id: '7', name: '濱崎' } as never,
    ])
    expect(resolve(label, row('10', { 5: '7' }))).toBe('濱崎 さん')
  })

  it('can reference the row ID', () => {
    const c = col('5', 'ラベル', 'formula', { expr: '[ID] & "：" & [単価]' })
    const resolve = makeComputedResolver([unit, c], {})
    expect(resolve(c, row('10', { 1: 500 }, 'A-7'))).toBe('A-7：500')
  })

  it('chains one formula into another', () => {
    const tax = col('4', '税込', 'formula', { expr: 'ROUND([金額] * 1.1, 0)' })
    const resolve = makeComputedResolver([unit, qty, amount, tax], {})
    expect(resolve(tax, row('10', { 1: 1000, 2: 3 }))).toBe('3300')
  })

  it('stops a circular reference instead of hanging', () => {
    const a = col('1', 'A', 'formula', { expr: '[B] + 1' })
    const b = col('2', 'B', 'formula', { expr: '[A] + 1' })
    const resolve = makeComputedResolver([a, b], {})
    expect(resolve(a, row('10', {}))).toContain('循環参照')
  })

  it('marks errors with # so they stand out in the cell', () => {
    const bad = col('4', 'だめ', 'formula', { expr: '[ないよ] * 2' })
    const resolve = makeComputedResolver([unit, bad], {})
    expect(resolve(bad, row('10', { 1: 1 }))).toBe('#「ないよ」という列がありません')
  })

  it('returns null for an unconfigured formula', () => {
    const empty = col('4', '未設定', 'formula', {})
    expect(makeComputedResolver([empty], {})(empty, row('10', {}))).toBeNull()
  })
})
