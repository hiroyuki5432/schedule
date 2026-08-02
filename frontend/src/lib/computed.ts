// 計算列（自動で値が決まる列）の解決。いまは 参照(LOOKUP) と 数式(formula) の2つ。
//
// 計算列の値は DB に持たない。表示のたびにここで求めるので、元になった列を直せば
// すぐ追従する。編集は不可（セルは読み取り専用）、Excel取り込みでも対象外。
//
// 数式は同じ行の列を名前で参照する（lib/formula.ts）。参照先が計算列でもよく、
// その場合は再帰的に解決する — ぐるっと回って自分に戻ってきたら循環参照として
// エラーにする。

import { evalFormula, formatFormulaValue, parseFormula } from '@/lib/formula'
import type { FormulaAst, FormulaValue } from '@/lib/formula'
import { resolveLookup } from '@/lib/lookup'
import type { TargetSheets } from '@/lib/lookup'
import type { Column, ColumnType, Member, Row } from '@/types/api'

/** 値を自動計算する列の型。 */
export const COMPUTED_TYPES: ColumnType[] = ['lookup', 'formula']

/** この列は自動計算か（＝手で編集できないか）。 */
export function isComputed(c: { type: ColumnType } | null | undefined): boolean {
  return !!c && COMPUTED_TYPES.includes(c.type)
}

/** 数式から [ID] で参照できる、行のキー値。 */
const ID_REF = 'ID'

export type ComputedResolver = (column: Column, row: Row) => string | null

/**
 * 1シートぶんの計算列リゾルバを作る。
 * `targets` は参照(LOOKUP)先シートの中身（useComputedValues が集める）。
 */
export function makeComputedResolver(
  columns: Column[],
  targets: TargetSheets,
  members: Member[] = [],
): ComputedResolver {
  // 式の解析は列ごとに1回だけ（行数ぶん解析し直さない）。
  const asts = new Map<string, { ast: FormulaAst | null; error: string | null }>()
  const byName = new Map<string, Column>()
  for (const c of columns) if (!byName.has(c.name)) byName.set(c.name, c)

  const memberName = (v: unknown): string => {
    const m = members.find((x) => String(x.id) === String(v))
    return m ? m.name : v == null ? '' : String(v)
  }

  /** 数式から見た「その行のその列の値」。undefined = そんな列はない。 */
  const rawValue = (name: string, row: Row, seen: Set<string>): FormulaValue | undefined => {
    const col = byName.get(name)
    if (!col) return name.toUpperCase() === ID_REF ? (row.key_value ?? '') : undefined
    if (isComputed(col)) {
      const t = resolve(col, row, seen)
      return t
    }
    const v = row.data?.[col.id]
    if (v === undefined || v === null) return null
    if (col.type === 'member') return memberName(v)
    if (col.type === 'number') return typeof v === 'number' ? v : String(v)
    return v as FormulaValue
  }

  const formulaValue = (column: Column, row: Row, seen: Set<string>): string | null => {
    const expr = String(column.config?.expr ?? '')
    if (!expr.trim()) return null
    let parsed = asts.get(column.id)
    if (!parsed) {
      parsed = parseFormula(expr)
      asts.set(column.id, parsed)
    }
    if (parsed.error) return `#${parsed.error}`
    const { value, error } = evalFormula(parsed.ast, {
      value: (name) => rawValue(name, row, seen),
    })
    if (error) return `#${error}`
    const decimals = column.config?.decimals
    return formatFormulaValue(value, typeof decimals === 'number' ? decimals : null)
  }

  function resolve(column: Column, row: Row, seen: Set<string>): string | null {
    const key = `${column.id}:${row.id}`
    if (seen.has(key)) return '#循環参照しています'
    if (column.type === 'lookup') return resolveLookup(column, row, targets, members)
    if (column.type !== 'formula') return null
    const next = new Set(seen)
    next.add(key)
    return formulaValue(column, row, next)
  }

  return (column, row) => resolve(column, row, new Set())
}
