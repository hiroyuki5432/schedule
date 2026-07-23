// Rule builder for a status column: an ordered list of rules
//   { conditions: [{ col_id, op, value }], label, color }
// evaluated top-down, "first match wins". Ops per lib/status.ts.
import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { badgeForRule, firstMatchingRule } from '@/lib/status'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/ui/icons'
import type { Column, Row, StatusRule, StatusRuleCondition } from '@/types/api'

const OPS: Array<{ value: string; label: string; needsValue: boolean }> = [
  { value: '=', label: '=', needsValue: true },
  { value: '!=', label: '≠', needsValue: true },
  { value: '>', label: '>', needsValue: true },
  { value: '>=', label: '≥', needsValue: true },
  { value: '<', label: '<', needsValue: true },
  { value: '<=', label: '≤', needsValue: true },
  { value: 'contains', label: '含む', needsValue: true },
  { value: 'empty', label: '空', needsValue: false },
  { value: 'not_empty', label: '非空', needsValue: false },
]

const COLORS = ['#E3EFEA', '#EFEDE4', '#FAE6E0', '#E6F0DB', '#CBD9EE', '#F1DBAC']

function opNeedsValue(op: string): boolean {
  return OPS.find((o) => o.value === op)?.needsValue ?? true
}

export function StatusRuleBuilder({
  column,
  columns,
  onDone,
}: {
  column: Column
  columns: Column[]
  onDone: () => void
}) {
  const [rules, setRules] = useState<StatusRule[]>(() => column.config?.rules ?? [])
  // Feature 6: auto-derive the status badge from the row's milestones.
  const [autoFromMilestones, setAutoFromMilestones] = useState<boolean>(
    () => column.config?.auto_from_milestones === true,
  )

  // Columns selectable as a condition's left-hand side (exclude self).
  const condCols = columns.filter((c) => String(c.id) !== String(column.id))

  // Live preview: run the DRAFT rules over this sheet's real rows so the effect
  // of a rule is visible before saving. Rules are hard to get right blind — this
  // is what turns "I think that's the condition" into "yes, 12 tasks land here".
  const rowsQ = useQuery({
    queryKey: ['rows', column.sheet_id],
    queryFn: () => api.getRows(column.sheet_id),
    staleTime: 30_000,
  })
  const preview = useMemo(
    () => buildPreview(rowsQ.data ?? [], rules),
    [rowsQ.data, rules],
  )

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, {
        config: {
          ...column.config,
          rules,
          auto_from_milestones: autoFromMilestones,
        },
      }),
    onSuccess: onDone,
  })

  function setRule(i: number, next: StatusRule) {
    setRules(rules.map((r, j) => (j === i ? next : r)))
  }
  function moveRule(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = rules.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setRules(next)
  }
  function addRule() {
    setRules([
      ...rules,
      { conditions: [], label: '新規ステータス', color: COLORS[rules.length % COLORS.length] },
    ])
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — ステータスルール</CardTitle>
      </CardHeader>
      <CardBody>
        <label className="mb-3 flex cursor-pointer select-none items-start gap-2 rounded-[10px] border border-[var(--line)] bg-[#FCFBF7] p-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 accent-[var(--green)]"
            checked={autoFromMilestones}
            onChange={(e) => setAutoFromMilestones(e.target.checked)}
          />
          <span className="text-[12px] text-[var(--ink2)]">
            <span className="font-medium">達成状況から自動判定</span>
            <span className="mt-0.5 block text-[11px] text-[var(--ink3)]">
              ONのとき、各行のマイルストン達成と今日からステータスを自動算出（読み取り専用）。全達成=完了／節目超過かつ未達=遅延／一部達成または最初の節目到達=進行中／それ以外=未着手。下のルールは無視されます。
            </span>
          </span>
        </label>
        <p
          className={
            'mb-3 text-[11.5px] text-[var(--ink3)]' +
            (autoFromMilestones ? ' opacity-50' : '')
          }
        >
          上から順に評価し、最初に全条件を満たしたルールのラベル／色を表示します。条件が空のルールは「常に一致」（既定値）。
        </p>

        <div className="flex flex-col gap-3">
          {rules.map((rule, i) => (
            <div
              key={i}
              className="rounded-[10px] border border-[var(--line)] bg-[#FCFBF7] p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[11px] font-medium text-[var(--ink3)]">#{i + 1}</span>
                <Input
                  className="flex-1"
                  placeholder="ラベル"
                  value={rule.label}
                  onChange={(e) => setRule(i, { ...rule, label: e.target.value })}
                />
                <Select
                  value={rule.color}
                  onChange={(e) => setRule(i, { ...rule, color: e.target.value })}
                >
                  {COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
                <span
                  className="h-7 w-7 flex-shrink-0 rounded-[7px] border border-[var(--line)]"
                  style={{ background: rule.color }}
                />
                <div className="flex flex-col">
                  <button
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => moveRule(i, -1)}
                  >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    disabled={i === rules.length - 1}
                    onClick={() => moveRule(i, 1)}
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                <button
                  className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  title="ルールを削除"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>

              <ConditionList
                conditions={rule.conditions}
                cols={condCols}
                onChange={(conds) => setRule(i, { ...rule, conditions: conds })}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Badge bg={rule.color} color="#3a382f">
                  {rule.label || '（ラベル未設定）'}
                </Badge>
                <RuleMatchHint
                  count={preview.counts[i] ?? 0}
                  total={preview.total}
                  unreachable={preview.unreachableFrom != null && i > preview.unreachableFrom}
                  loading={rowsQ.isLoading}
                />
              </div>
            </div>
          ))}
        </div>

        {!autoFromMilestones && (
          <RulePreview
            rules={rules}
            rows={rowsQ.data ?? []}
            preview={preview}
            loading={rowsQ.isLoading}
          />
        )}

        <button
          onClick={addRule}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
        >
          <PlusIcon className="h-[15px] w-[15px]" />
          ルールを追加
        </button>

        <div className="mt-4 flex justify-end">
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

interface PreviewResult {
  total: number
  /** How many rows land on each rule (first match wins, so these don't overlap). */
  counts: number[]
  /** Rows matching no rule at all — they show a blank status in the grid. */
  unmatched: number
  /** Index of the first "always matches" rule; anything after it is dead. */
  unreachableFrom: number | null
  /** A few example rows per rule, for the sample table. */
  samples: Array<{ ruleIndex: number; keyValue: string }>
}

const SAMPLE_LIMIT = 6

function buildPreview(rows: Row[], rules: StatusRule[]): PreviewResult {
  const counts = new Array(rules.length).fill(0)
  const samples: PreviewResult['samples'] = []
  let unmatched = 0
  for (const row of rows) {
    const i = firstMatchingRule(row, rules)
    if (i < 0) {
      unmatched++
      continue
    }
    counts[i]++
    if (samples.length < SAMPLE_LIMIT) {
      samples.push({ ruleIndex: i, keyValue: row.key_value || `#${row.id}` })
    }
  }
  // A rule with no conditions matches everything, so nothing below it can ever
  // be reached — a mistake that's invisible without saying so.
  const alwaysIdx = rules.findIndex((r) => r.conditions.length === 0)
  return {
    total: rows.length,
    counts,
    unmatched,
    unreachableFrom: alwaysIdx >= 0 && alwaysIdx < rules.length - 1 ? alwaysIdx : null,
    samples,
  }
}

/** "12件が該当" chip next to each rule. */
function RuleMatchHint({
  count,
  total,
  unreachable,
  loading,
}: {
  count: number
  total: number
  unreachable: boolean
  loading: boolean
}) {
  if (loading) return null
  if (unreachable) {
    return (
      <span className="rounded bg-[#FAE6E0] px-1.5 py-0.5 text-[10.5px] font-medium text-[#A8442B]">
        上のルールが常に一致するため、ここには届きません
      </span>
    )
  }
  if (total === 0) return null
  if (count === 0) {
    return (
      <span className="rounded bg-[#FBF3E6] px-1.5 py-0.5 text-[10.5px] text-[#8A5A1E]">
        今は該当なし
      </span>
    )
  }
  return (
    <span className="rounded bg-[var(--line2)] px-1.5 py-0.5 text-[10.5px] text-[var(--ink3)]">
      {count}件が該当
    </span>
  )
}

/** Overall preview: how the current rules would label this sheet's rows today. */
function RulePreview({
  rules,
  rows,
  preview,
  loading,
}: {
  rules: StatusRule[]
  rows: Row[]
  preview: PreviewResult
  loading: boolean
}) {
  if (loading) {
    return (
      <p className="mt-4 text-[11.5px] text-[var(--ink3)]">プレビューを読み込み中…</p>
    )
  }
  if (rules.length === 0) return null

  const byKey = new Map(rows.map((r) => [r.key_value || `#${r.id}`, r]))

  return (
    <div className="mt-4 rounded-[10px] border border-[var(--line)] bg-[#FCFBF7] p-3">
      <div className="mb-1.5 text-[12px] font-medium text-[var(--ink2)]">
        いまのデータだとこう表示されます
      </div>
      {preview.total === 0 ? (
        <p className="text-[11.5px] text-[var(--ink3)]">
          このシートにはまだ行がないため、試せるデータがありません。
        </p>
      ) : (
        <>
          <p className="mb-2 text-[11.5px] text-[var(--ink3)]">
            全 {preview.total} 件のうち
            {preview.unmatched > 0 ? (
              <>
                、<b className="font-semibold text-[#8A5A1E]">{preview.unmatched} 件</b>
                はどのルールにも当てはまらず、ステータスが空欄になります。
              </>
            ) : (
              'すべてがいずれかのルールに当てはまります。'
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {preview.samples.map((s, i) => {
              const rule = rules[s.ruleIndex]
              if (!rule || !byKey.has(s.keyValue)) return null
              const badge = badgeForRule(rule)
              return (
                <span
                  key={`${s.keyValue}-${i}`}
                  className="flex items-center gap-1.5 rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1 text-[11px]"
                >
                  <span className="font-semibold">{s.keyValue}</span>
                  <Badge bg={badge.bg} color={badge.color}>
                    {rule.label || '（ラベル未設定）'}
                  </Badge>
                </span>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function ConditionList({
  conditions,
  cols,
  onChange,
}: {
  conditions: StatusRuleCondition[]
  cols: Column[]
  onChange: (c: StatusRuleCondition[]) => void
}) {
  function setCond(i: number, next: StatusRuleCondition) {
    onChange(conditions.map((c, j) => (j === i ? next : c)))
  }
  function add() {
    onChange([
      ...conditions,
      { col_id: cols[0] ? String(cols[0].id) : '', op: '=', value: '' },
    ])
  }

  return (
    <div className="flex flex-col gap-1.5">
      {conditions.map((cond, i) => {
        const needsValue = opNeedsValue(cond.op)
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Select
              className="flex-1"
              value={cond.col_id == null ? '' : String(cond.col_id)}
              onChange={(e) => setCond(i, { ...cond, col_id: e.target.value })}
            >
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              value={cond.op}
              onChange={(e) => setCond(i, { ...cond, op: e.target.value })}
            >
              {OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {needsValue && (
              <Input
                className="flex-1"
                placeholder="値"
                value={cond.value == null ? '' : String(cond.value)}
                onChange={(e) => setCond(i, { ...cond, value: e.target.value })}
              />
            )}
            <button
              className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
              onClick={() => onChange(conditions.filter((_, j) => j !== i))}
              title="条件を削除"
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
      <button
        onClick={add}
        disabled={cols.length === 0}
        className="self-start text-[11.5px] text-[var(--green)] hover:underline disabled:opacity-40"
      >
        ＋ 条件を追加
      </button>
    </div>
  )
}
