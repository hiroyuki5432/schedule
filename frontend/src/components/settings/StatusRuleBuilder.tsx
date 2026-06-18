// Rule builder for a status column: an ordered list of rules
//   { conditions: [{ col_id, op, value }], label, color }
// evaluated top-down, "first match wins". Ops per lib/status.ts.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import * as api from '@/api/client'
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
import type { Column, StatusRule, StatusRuleCondition } from '@/types/api'

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
              <div className="mt-1.5 flex items-center gap-2">
                <Badge bg={rule.color} color="#3a382f">
                  {rule.label || '（ラベル未設定）'}
                </Badge>
              </div>
            </div>
          ))}
        </div>

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
