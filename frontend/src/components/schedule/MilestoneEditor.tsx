// Per-row milestone (phase boundary) editor. Each phase has a name, a boundary
// (start) date, and a 達成(done) flag. The COLOR is inherited from the sheet's
// default milestone of the same name — there is no per-row color picking.
// Saves via PUT /api/rows/{rowId}/milestones (full replace) and invalidates
// ['milestones', rowId] so the gantt recolors.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  TrashIcon,
} from '@/components/ui/icons'
import type { DefaultMilestone, Milestone, Row } from '@/types/api'

// Fallback phases (index.css --p-* vars) used only when the sheet has no
// configured default milestones yet.
const FALLBACK_PALETTE: DefaultMilestone[] = [
  { name: '設計', color: '#D4E7DC' },
  { name: '実装', color: '#A7D0BE' },
  { name: 'テスト', color: '#F1DBAC' },
  { name: 'レビュー', color: '#CBD9EE' },
  { name: '完了', color: '#BFE2D3' },
]
const NEUTRAL = '#e3decf'

interface Draft {
  id: string
  name: string
  boundary_date: string
  done: boolean
  actual_date: string | null
}

/** Whole days from planned boundary to actual (+ = late). Null if either missing. */
function delayDays(boundary: string, actual: string | null): number | null {
  if (!actual || !boundary) return null
  const ms = new Date(actual).getTime() - new Date(boundary).getTime()
  return Math.round(ms / (24 * 60 * 60 * 1000))
}

interface Props {
  row: Row
  /** Sheet-level default phases — color source, name options, and prefill. */
  defaults?: DefaultMilestone[]
  onClose: () => void
}

/** ISO date (YYYY-MM-DD) for today + `days`. */
function todayPlusDaysISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

export function MilestoneEditor({ row, defaults = [], onClose }: Props) {
  const qc = useQueryClient()
  const rowId = row.id

  // Phases offered + their colors. Sheet defaults win; fall back to the built-in
  // set only when the sheet has none configured.
  const phases = defaults.length > 0 ? defaults : FALLBACK_PALETTE
  const hasDefaults = defaults.length > 0
  const colorByName = useMemo(() => new Map(phases.map((p) => [p.name, p.color])), [phases])
  const colorFor = (name: string) => colorByName.get(name) ?? NEUTRAL

  const msQ = useQuery({
    queryKey: ['milestones', rowId],
    queryFn: () => api.getMilestones(rowId),
  })

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const items: Draft[] = useMemo(() => {
    if (drafts) return drafts
    const existing = [...(msQ.data ?? [])].sort((a, b) => a.order - b.order)
    if (existing.length > 0) {
      return existing.map((m) => ({
        id: String(m.id),
        name: m.name,
        boundary_date: m.boundary_date,
        done: !!m.done,
        actual_date: m.actual_date ?? null,
      }))
    }
    // No milestones yet: prefill from the default phases (staggered ~4 weeks
    // apart) as an editable starting point — nothing is saved until 保存.
    return phases.map((p, i) => ({
      id: `default-${i}`,
      name: p.name,
      boundary_date: todayPlusDaysISO(i * 28),
      done: false,
      actual_date: null,
    }))
  }, [drafts, msQ.data, phases])

  function update(next: Draft[]) {
    setDrafts(next)
  }

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Milestone[] = items.map((d, i) => ({
        id: d.id,
        row_id: rowId,
        name: d.name,
        boundary_date: d.boundary_date,
        color: colorFor(d.name), // inherited from the default phase of this name
        order: i,
        done: d.done,
        actual_date: d.done ? d.actual_date : null,
      }))
      return api.putMilestones(rowId, payload)
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['milestones', rowId] })
      onClose()
    },
  })

  function addMilestone() {
    const next = phases[items.length % phases.length] ?? phases[0]
    update([
      ...items,
      {
        id: `new-${Date.now()}`,
        name: next?.name ?? '',
        boundary_date: todayPlusDaysISO(items.length * 28),
        done: false,
        actual_date: null,
      },
    ])
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    update(next)
  }

  // Names offered in the dropdown: the default phases + any legacy names present.
  const phaseNames = useMemo(() => {
    const names = phases.map((p) => p.name)
    for (const it of items) if (it.name && !names.includes(it.name)) names.push(it.name)
    return names
  }, [phases, items])

  return (
    <Modal
      title={`マイルストン（フェーズ） — ${row.key_value}`}
      onClose={onClose}
      widthClass="w-[640px]"
    >
      {msQ.isLoading ? (
        <div className="py-4 text-[var(--ink3)]">読み込み中…</div>
      ) : (
        <>
          <p className="mb-2.5 text-[12px] text-[var(--ink3)]">
            各フェーズの開始日（境界＝予定）と達成を設定します。達成にすると実績完了日を入力でき、予定との
            遅延日数が出ます。色は設定画面の「既定マイルストン」から名前で引き継ぎます。
          </p>
          <div className="flex flex-col gap-2.5">
            {items.length === 0 && (
              <div className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--ink3)]">
                マイルストンがありません。下の「追加」で境界を作成します。
              </div>
            )}
            {items.map((d, i) => (
              <div
                key={d.id}
                className="flex items-end gap-2.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-2"
              >
                <div className="flex flex-col pb-1.5">
                  <button
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    title="上へ"
                  >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                    title="下へ"
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                <span
                  className="mb-1.5 h-6 w-6 flex-shrink-0 rounded-[6px] border border-[var(--line)]"
                  style={{ background: colorFor(d.name) }}
                  title="色は既定マイルストンから自動で決まります"
                />
                <label className="flex flex-1 flex-col gap-1 text-[11px] text-[var(--ink3)]">
                  フェーズ
                  {hasDefaults ? (
                    <Select
                      value={d.name}
                      onChange={(e) =>
                        update(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                      }
                    >
                      {phaseNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      placeholder="例: 設計 / 実装 / テスト"
                      value={d.name}
                      onChange={(e) =>
                        update(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                      }
                    />
                  )}
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[var(--ink3)]">
                  開始日（境界）
                  <Input
                    type="date"
                    className="w-[150px]"
                    value={d.boundary_date}
                    onChange={(e) =>
                      update(
                        items.map((x, j) =>
                          j === i ? { ...x, boundary_date: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </label>
                <label
                  className="flex cursor-pointer select-none flex-col items-center gap-1 whitespace-nowrap pb-1.5 text-[11px] text-[var(--ink3)]"
                  title="この節目を達成（完了）済みにする"
                >
                  達成
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--green)]"
                    checked={d.done}
                    onChange={(e) =>
                      update(
                        items.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                done: e.target.checked,
                                // Default the actual date to today on first check;
                                // clear it when unchecking.
                                actual_date: e.target.checked
                                  ? x.actual_date ?? todayPlusDaysISO(0)
                                  : null,
                              }
                            : x,
                        ),
                      )
                    }
                  />
                </label>
                {d.done && (
                  <label className="flex flex-col gap-1 text-[11px] text-[var(--ink3)]">
                    実績完了日
                    <Input
                      type="date"
                      className="w-[150px]"
                      value={d.actual_date ?? ''}
                      onChange={(e) =>
                        update(
                          items.map((x, j) =>
                            j === i ? { ...x, actual_date: e.target.value || null } : x,
                          ),
                        )
                      }
                    />
                    <DelayBadge boundary={d.boundary_date} actual={d.actual_date} />
                  </label>
                )}
                <button
                  className="rounded p-1 pb-2 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                  onClick={() => update(items.filter((_, j) => j !== i))}
                  title="削除"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={addMilestone}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            <PlusIcon className="h-[15px] w-[15px]" />
            マイルストンを追加
          </button>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              キャンセル
            </Button>
            <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              保存
            </Button>
          </div>
        </>
      )}
    </Modal>
  )
}

/** Small colored 遅延/前倒し label from planned vs actual dates. */
function DelayBadge({ boundary, actual }: { boundary: string; actual: string | null }) {
  const d = delayDays(boundary, actual)
  if (d == null) return null
  const text = d > 0 ? `${d}日 遅れ` : d < 0 ? `${-d}日 前倒し` : '予定通り'
  return (
    <span className="text-[10.5px]" style={{ color: d > 0 ? '#A8442B' : '#266B53' }}>
      {text}
    </span>
  )
}
