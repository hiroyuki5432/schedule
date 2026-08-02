// 数式列の設定。式そのもの＋小数桁数と、いまのデータでの計算結果プレビュー。
//
// 列は名前で参照する（`[単価] * [数量]`）。列名をクリックすると差し込めるので、
// 手で打ち間違えなくて済む。式が壊れているとき／存在しない列を指しているときは
// 保存する前にここで分かる。
import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers } from '@/hooks/useSheets'
import { useComputedValues } from '@/hooks/useComputedValues'
import { parseFormula } from '@/lib/formula'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { toast } from '@/lib/toast'
import type { Column } from '@/types/api'

/** 書き出しの見本（クリックで式に差し込む）。 */
const SAMPLES = [
  { label: '掛け算', expr: '[単価] * [数量]' },
  { label: '日数', expr: '[完了日] - [開始日]' },
  { label: '割合', expr: 'IFERROR([実績] / [予定] * 100, "")' },
  { label: '条件分け', expr: 'IF([進捗] >= 100, "完了", "進行中")' },
  { label: '文字の連結', expr: '[大分類] & "／" & [中分類]' },
]

export function FormulaConfigEditor({
  column,
  sheetId,
  onDone,
}: {
  column: Column
  sheetId: string
  onDone: () => void
}) {
  const [expr, setExpr] = useState(String(column.config?.expr ?? ''))
  const [decimals, setDecimals] = useState<string>(
    column.config?.decimals == null ? '' : String(column.config.decimals),
  )

  const detailQ = useQuery({ queryKey: ['sheet', sheetId], queryFn: () => api.getSheet(sheetId) })
  const membersQ = useMembers()
  const sheetColumns = useMemo(
    () => [...(detailQ.data?.columns ?? [])].sort((a, b) => a.order - b.order),
    [detailQ.data],
  )
  const rows = detailQ.data?.rows ?? []

  // プレビューは「保存したらこうなる」列で計算する（保存前の式で試せる）。
  const draft: Column = useMemo(
    () => ({
      ...column,
      config: {
        ...(column.config ?? {}),
        expr,
        decimals: decimals === '' ? null : Number(decimals),
      },
    }),
    [column, expr, decimals],
  )
  const previewColumns = useMemo(
    () => sheetColumns.map((c) => (String(c.id) === String(column.id) ? draft : c)),
    [sheetColumns, column.id, draft],
  )
  const { computedValue } = useComputedValues(previewColumns, membersQ.data ?? [])

  const parsed = useMemo(() => parseFormula(expr), [expr])
  // 存在しない列名は、式としては正しくても計算できない。先に名前で拾っておく。
  const unknownRefs = useMemo(() => {
    const names = new Set(sheetColumns.map((c) => c.name))
    return (parsed.ast?.refs ?? []).filter((r) => !names.has(r) && r.toUpperCase() !== 'ID')
  }, [parsed, sheetColumns])
  const selfRef = (parsed.ast?.refs ?? []).includes(column.name)

  const problem = parsed.error
    ? parsed.error
    : selfRef
      ? '自分自身は参照できません'
      : unknownRefs.length
        ? `この列がありません：${unknownRefs.join('、')}`
        : null

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, {
        config: {
          ...(column.config ?? {}),
          expr: expr.trim(),
          decimals: decimals === '' ? null : Number(decimals),
        },
      }),
    onSuccess: () => {
      onDone()
      toast.show('保存しました', 'success', 2000)
    },
    onError: () => toast.show('保存に失敗しました', 'error'),
  })

  const insert = (text: string) => setExpr((e) => (e ? `${e} ${text}` : text))

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — 数式</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          <label className="text-[12px] text-[var(--ink2)]">
            式
            <textarea
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="[単価] * [数量]"
              className="mt-1 w-full resize-y rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 font-mono text-[12.5px] text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--green-l)]"
            />
          </label>

          {problem ? (
            <div className="rounded-[9px] bg-[#FAE6E0] px-3 py-2 text-[11.5px] text-[#A8442B]">
              {problem}
            </div>
          ) : (
            expr.trim() && (
              <div className="text-[11.5px] text-[var(--green-d)]">式は正しく読めています</div>
            )
          )}

          <div>
            <div className="mb-1 text-[11.5px] text-[var(--ink3)]">
              列を差し込む（同じ行の値を使います）
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => insert('[ID]')}
                className="rounded-[7px] border border-[var(--line)] px-2 py-1 text-[11.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
              >
                ID
              </button>
              {sheetColumns
                .filter((c) => String(c.id) !== String(column.id))
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => insert(`[${c.name}]`)}
                    className="rounded-[7px] border border-[var(--line)] px-2 py-1 text-[11.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
                  >
                    {c.name}
                  </button>
                ))}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[11.5px] text-[var(--ink3)]">書き方の例</div>
            <div className="flex flex-wrap gap-1">
              {SAMPLES.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  title={s.expr}
                  onClick={() => setExpr(s.expr)}
                  className="rounded-[7px] bg-[var(--line2)] px-2 py-1 font-mono text-[11px] text-[var(--ink2)] hover:bg-[var(--line)]"
                >
                  {s.expr}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-[var(--ink3)]">
              使える関数：IF・IFERROR・AND・OR・SUM・AVERAGE・COUNT・MIN・MAX・ROUND・
              ROUNDUP・ROUNDDOWN・ABS・INT・LEN・LEFT・RIGHT・MID・CONCAT・TRIM・
              TODAY・DAYS・DATE・YEAR・MONTH・DAY・ISBLANK。日付どうしの引き算は日数、
              日付＋数値は日付になります。
            </div>
          </div>

          <label className="text-[12px] text-[var(--ink2)]">
            小数の桁数
            <Select
              className="mt-1 w-full"
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
            >
              <option value="">そのまま</option>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={String(n)}>
                  {n} 桁
                </option>
              ))}
            </Select>
          </label>

          <div>
            <div className="mb-1 text-[11.5px] text-[var(--ink3)]">
              いまのデータでの結果（先頭 3 行）
            </div>
            {rows.length === 0 ? (
              <div className="text-[11.5px] text-[var(--ink3)]">行がまだありません</div>
            ) : (
              <ul className="space-y-1">
                {rows.slice(0, 3).map((r) => {
                  const v = computedValue(draft, r) ?? ''
                  const bad = v.startsWith('#')
                  return (
                    <li
                      key={r.id}
                      className="flex items-center gap-2 rounded-[9px] bg-[var(--line2)] px-3 py-1.5 text-[11.5px]"
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--ink3)]">
                        {r.key_value || `#${r.id}`}
                      </span>
                      <span className={bad ? 'text-[#A8442B]' : 'text-[var(--ink)]'}>
                        {v || '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--ink3)]">
              計算結果は保存されません（表示のたびに計算）。手入力はできません。
            </span>
            <Button
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !!problem}
            >
              保存
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
