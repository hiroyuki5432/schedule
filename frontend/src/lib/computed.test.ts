import { describe, expect, it } from 'vitest'
import { isComputed, makeComputedResolver } from './computed'
import type { Column, ColumnConfig, Row } from '@/types/api'

const col = (id: string, name: string, type: Column['type'], config: ColumnConfig = {}): Column => ({
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

describe('makeComputedResolver — 参照(LOOKUP)', () => {
  // 顧客マスタ: ID(key_value) → 会社名 / 担当
  const mCompany = col('90', '会社名', 'text')
  const mOwner = col('91', '担当', 'text')
  const master = {
    sheet: { id: '9' } as never,
    columns: [mCompany, mOwner],
    rows: [
      row('900', { 90: 'あ社', 91: '内田' }, 'C-1'),
      row('901', { 90: 'い社', 91: '寺本' }, 'C-2'),
      // 同じIDが2件あるときは先頭が勝つ（線形探索時と同じ意味）。
      row('902', { 90: 'あ社（旧）', 91: '—' }, 'C-1'),
    ],
  }
  const localKey = col('1', '顧客ID', 'text')
  const lookupCol = col('2', '会社', 'lookup', {
    target_sheet_id: '9',
    local_key_column_id: '1',
    return_column_id: '90',
  })

  it('resolves through the index', () => {
    const resolve = makeComputedResolver([localKey, lookupCol], { 9: master as never })
    expect(resolve(lookupCol, row('10', { 1: 'C-2' }))).toBe('い社')
  })

  it('keeps first-match-wins on duplicate keys', () => {
    const resolve = makeComputedResolver([localKey, lookupCol], { 9: master as never })
    expect(resolve(lookupCol, row('10', { 1: 'C-1' }))).toBe('あ社')
  })

  it('returns null when nothing matches', () => {
    const resolve = makeComputedResolver([localKey, lookupCol], { 9: master as never })
    expect(resolve(lookupCol, row('10', { 1: 'C-9' }))).toBeNull()
  })

  it('caches per row object, so a replaced row is recomputed', () => {
    const resolve = makeComputedResolver([localKey, lookupCol], { 9: master as never })
    const before = row('10', { 1: 'C-1' })
    expect(resolve(lookupCol, before)).toBe('あ社')
    expect(resolve(lookupCol, before)).toBe('あ社') // 2回目はキャッシュ
    // 保存すると react-query が行オブジェクトごと差し替える → 新しい値になる。
    expect(resolve(lookupCol, row('10', { 1: 'C-2' }))).toBe('い社')
  })

  it('a formula can read a lookup column', () => {
    const label = col('3', '表示', 'formula', { expr: '[会社] & " 御中"' })
    const resolve = makeComputedResolver([localKey, lookupCol, label], {
      9: master as never,
    })
    expect(resolve(label, row('10', { 1: 'C-2' }))).toBe('い社 御中')
  })
})
