import { describe, expect, it } from 'vitest'
import { evalFormula, formatFormulaValue, parseFormula } from './formula'
import type { FormulaValue } from './formula'

/** Evaluate `src` against a row given as {列名: 値}. */
function calc(src: string, row: Record<string, FormulaValue> = {}, today = '2026-08-03') {
  const { ast, error } = parseFormula(src)
  if (error) return `解析エラー: ${error}`
  const r = evalFormula(ast, {
    value: (name) => (name in row ? row[name] : undefined),
    today,
  })
  return r.error ? `エラー: ${r.error}` : formatFormulaValue(r.value)
}

describe('parseFormula', () => {
  it('accepts an empty formula (nothing configured yet)', () => {
    expect(parseFormula('  ')).toEqual({ ast: null, error: null })
  })

  it('reports where the式 is broken, in Japanese', () => {
    expect(parseFormula('[単価] * ').error).toBe('式が途中で終わっています')
    expect(parseFormula('[単価 * 2').error).toBe('列名の「]」が閉じていません')
    expect(parseFormula('1 + 2)').error).toBe('余分な「)」があります')
    expect(parseFormula('単価 * 2').error).toBe('列名は [ ] で囲んでください：単価')
  })

  it('collects the referenced column names', () => {
    expect(parseFormula('[単価]*[数量] + [単価]').ast?.refs).toEqual(['単価', '数量'])
  })
})

describe('四則計算', () => {
  it('multiplies columns', () => {
    expect(calc('[単価] * [数量]', { 単価: 1200, 数量: 3 })).toBe('3600')
  })

  it('follows operator precedence and parentheses', () => {
    expect(calc('1 + 2 * 3')).toBe('7')
    expect(calc('(1 + 2) * 3')).toBe('9')
    expect(calc('-2 ^ 2')).toBe('4') // Excel と同じで単項マイナスが ^ より強い
    expect(calc('0 - 2 ^ 2')).toBe('-4')
    expect(calc('2 ^ 3 ^ 2')).toBe('512')
  })

  it('treats blanks as zero but rejects real text', () => {
    expect(calc('[a] + 1', { a: null })).toBe('1')
    expect(calc('[a] + 1', { a: '' })).toBe('1')
    expect(calc('[a] + 1', { a: 'あ' })).toBe('エラー: 数値として計算できません：あ')
  })

  it('reads numbers that were imported as text', () => {
    expect(calc('[金額] * 2', { 金額: '1,200' })).toBe('2400')
  })

  it('refuses to divide by zero, and IF can avoid it', () => {
    expect(calc('[a] / [b]', { a: 10, b: 0 })).toBe('エラー: 0 で割りました')
    expect(calc('IF([b]=0, "", [a]/[b])', { a: 10, b: 0 })).toBe('')
    expect(calc('IFERROR([a]/[b], "—")', { a: 10, b: 0 })).toBe('—')
  })

  it('names the column that does not exist', () => {
    expect(calc('[単金] * 2', { 単価: 1 })).toBe('エラー: 「単金」という列がありません')
  })
})

describe('日付', () => {
  it('subtracts two dates into days', () => {
    expect(calc('[完了日] - [開始日]', { 完了日: '2026-08-10', 開始日: '2026-08-03' })).toBe('7')
    expect(calc('DAYS([完了日], [開始日])', { 完了日: '2026-08-10', 開始日: '2026-08-03' })).toBe(
      '7',
    )
  })

  it('adds days to a date and gives back a date', () => {
    expect(calc('[開始日] + 30', { 開始日: '2026-08-03' })).toBe('2026-09-02')
    expect(calc('[開始日] - 1', { 開始日: '2026-01-01' })).toBe('2025-12-31')
  })

  it('measures against today', () => {
    expect(calc('[期限] - TODAY()', { 期限: '2026-08-13' })).toBe('10')
  })

  it('pulls year/month/day out', () => {
    expect(calc('YEAR([d]) & "/" & MONTH([d])', { d: '2026-08-03' })).toBe('2026/8')
    expect(calc('DATE(2026, 8, 3)')).toBe('2026-08-03')
  })

  it('accepts slash-separated dates from Excel', () => {
    expect(calc('[d] + 1', { d: '2026/8/3' })).toBe('2026-08-04')
  })
})

describe('関数と文字列', () => {
  it('rounds', () => {
    expect(calc('ROUND(10/3, 1)')).toBe('3.3')
    expect(calc('ROUNDUP(10/3, 1)')).toBe('3.4')
    expect(calc('ROUNDDOWN(-10/3, 0)')).toBe('-3')
    expect(calc('ROUND(2.5, 0)')).toBe('3')
  })

  it('aggregates its arguments', () => {
    expect(calc('SUM([a],[b],[c])', { a: 1, b: null, c: 2 })).toBe('3')
    expect(calc('AVERAGE([a],[b],[c])', { a: 1, b: null, c: 2 })).toBe('1.5')
    expect(calc('COUNT([a],[b],[c])', { a: 1, b: null, c: '' })).toBe('1')
    expect(calc('MAX([a],[b])', { a: 3, b: 9 })).toBe('9')
  })

  it('joins text', () => {
    expect(calc('[姓] & " " & [名]', { 姓: '濱崎', 名: '博之' })).toBe('濱崎 博之')
    expect(calc('CONCAT([a], "-", [b])', { a: 'A', b: 'B' })).toBe('A-B')
    expect(calc('LEFT([s], 2) & LEN([s])', { s: 'あいうえお' })).toBe('あい5')
  })

  it('compares and branches', () => {
    expect(calc('IF([進捗] >= 100, "完了", "進行中")', { 進捗: 100 })).toBe('完了')
    expect(calc('IF([状態] = "完了", 1, 0)', { 状態: '完了' })).toBe('1')
    expect(calc('IF(AND([a]>0, [b]>0), "両方", "片方")', { a: 1, b: 0 })).toBe('片方')
    expect(calc('IF(ISBLANK([a]), "未入力", [a])', { a: '' })).toBe('未入力')
  })

  it('checks the argument count', () => {
    expect(calc('ROUND()')).toBe('エラー: ROUND の引数の数が違います')
    expect(calc('SUMIF([a], 1)')).toBe('エラー: 知らない関数です：SUMIF')
  })
})

describe('formatFormulaValue', () => {
  it('hides floating point noise and honours the decimals setting', () => {
    expect(formatFormulaValue(0.1 + 0.2)).toBe('0.3')
    expect(formatFormulaValue(3.14159, 2)).toBe('3.14')
    expect(formatFormulaValue(7, 2)).toBe('7.00')
    expect(formatFormulaValue(null)).toBe('')
    expect(formatFormulaValue(true)).toBe('TRUE')
  })
})
