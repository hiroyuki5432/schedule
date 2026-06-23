// Per-row schedule editor. The KEY idea (入力最小化): a row only needs a 開始日 and
// 完了日; the phases/milestones and their dates are auto-distributed across that
// span using the sheet template's phase weights (割合). Phases are the colored
// spans (no own date); milestones are the ◇ points whose dates are computed.
//
// Persistence:
//  - The expanded phase/milestone list (with computed dates) → PUT /rows/{id}/milestones.
//  - The row's 開始日/完了日 → reserved row.data keys __sched_start / __sched_end.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { parseDate } from '@/lib/dates'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, TrashIcon } from '@/components/ui/icons'
import type { DefaultMilestone, Milestone, Row } from '@/types/api'

// Fallback phases used only when the sheet has no configured default milestones.
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
  /** 'phase' = colored span; 'milestone' = ◇ point between phases. */
  kind: 'phase' | 'milestone'
  name: string
  /** Date only meaningful for milestones; phases derive theirs on save. '' = unset. */
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

/** Local YYYY-MM-DD (avoids the UTC off-by-one of toISOString). */
function isoOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
const todayISO = () => isoOf(new Date())

interface Props {
  row: Row
  /** Sheet-level default phases — color source, weights, name options, prefill. */
  defaults?: DefaultMilestone[]
  onClose: () => void
}

export function MilestoneEditor({ row, defaults = [], onClose }: Props) {
  const qc = useQueryClient()
  const rowId = row.id

  // Presets: sheet defaults win; fall back to the built-in set when none configured.
  const presets = defaults.length > 0 ? defaults : FALLBACK_PALETTE
  const hasDefaults = defaults.length > 0
  const phasePresets = useMemo(() => presets.filter((p) => p.kind !== 'milestone'), [presets])
  const colorByName = useMemo(
    () => new Map(phasePresets.map((p) => [p.name, p.color])),
    [phasePresets],
  )
  const colorFor = (name: string) => colorByName.get(name) ?? NEUTRAL
  const weightByName = useMemo(
    () => new Map(phasePresets.map((p) => [p.name, Math.max(0, p.weight ?? 1)])),
    [phasePresets],
  )
  const weightOf = (name: string) => weightByName.get(name) ?? 1

  const msQ = useQuery({
    queryKey: ['milestones', rowId],
    queryFn: () => api.getMilestones(rowId),
  })

  // 開始日 / 完了日 (task span) from reserved row.data keys.
  const [start, setStart] = useState<string>((row.data.__sched_start as string | null) ?? '')
  const [end, setEnd] = useState<string>((row.data.__sched_end as string | null) ?? '')

  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const items: Draft[] = useMemo(() => {
    if (drafts) return drafts
    const existing = [...(msQ.data ?? [])].sort((a, b) => a.order - b.order)
    if (existing.length > 0) {
      return existing.map((m) => ({
        id: String(m.id),
        kind: m.kind === 'milestone' ? 'milestone' : 'phase',
        name: m.name,
        boundary_date: m.kind === 'milestone' ? m.boundary_date : '',
        done: !!m.done,
        actual_date: m.actual_date ?? null,
      }))
    }
    // No milestones yet: prefill structure from the presets but WITHOUT dates —
    // they fill in once 開始日/完了日 are entered (no surprise default dates).
    return presets.map((p, i) => ({
      id: `default-${i}`,
      kind: p.kind === 'milestone' ? ('milestone' as const) : ('phase' as const),
      name: p.name,
      boundary_date: '',
      done: false,
      actual_date: null,
    }))
  }, [drafts, msQ.data, presets])

  function update(next: Draft[]) {
    setDrafts(next)
  }

  /** Auto-place every milestone's date across [s, e] by cumulative phase weight. */
  function distribute(list: Draft[], s: string, e: string): Draft[] {
    if (!s || !e) return list
    const startT = parseDate(s).getTime()
    const span = parseDate(e).getTime() - startT
    let total = 0
    for (const it of list) if (it.kind === 'phase') total += weightOf(it.name)
    if (total <= 0) total = list.filter((it) => it.kind === 'phase').length || 1
    let cum = 0
    return list.map((it) => {
      if (it.kind === 'phase') {
        cum += weightOf(it.name)
        return it
      }
      const frac = Math.max(0, Math.min(1, cum / total))
      return { ...it, boundary_date: isoOf(new Date(startT + frac * span)) }
    })
  }

  /** Re-run auto distribution with the given (or current) span. */
  function redistribute(s = start, e = end) {
    if (!s || !e) return
    update(distribute(items, s, e))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      // Build the persisted list: milestones keep their (computed) date; a phase's
      // boundary is the preceding milestone's date (first phase → 開始日). Items
      // with no derivable date (span未入力) are skipped.
      let lastMsDate: string | null = null
      const payload: Milestone[] = []
      items.forEach((d, i) => {
        const isMs = d.kind === 'milestone'
        if (isMs) {
          if (!d.boundary_date) return // not yet placed
          lastMsDate = d.boundary_date
        }
        const boundary = isMs ? d.boundary_date : lastMsDate ?? start ?? d.boundary_date
        if (!boundary) return
        payload.push({
          id: d.id,
          row_id: rowId,
          kind: d.kind,
          name: d.name,
          color: isMs ? NEUTRAL : colorFor(d.name),
          boundary_date: boundary,
          order: i,
          done: isMs ? d.done : false,
          actual_date: isMs && d.done ? d.actual_date : null,
        })
      })
      await api.putMilestones(rowId, payload)
      // Persist the task span so the gantt bounds coloring (範囲外は無色).
      const curStart = (row.data.__sched_start as string | null) ?? ''
      const curEnd = (row.data.__sched_end as string | null) ?? ''
      if (start !== curStart || end !== curEnd) {
        await api.updateRow(rowId, {
          data: { ...row.data, __sched_start: start || null, __sched_end: end || null },
          version: row.version,
        })
      }
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['milestones', rowId] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones', String(row.sheet_id)] }),
        qc.invalidateQueries({ queryKey: ['sheet', String(row.sheet_id)] }),
      ])
      onClose()
    },
  })

  function addPhase() {
    const pool = phasePresets.length > 0 ? phasePresets : presets
    const next = pool[items.filter((i) => i.kind === 'phase').length % pool.length] ?? pool[0]
    update([
      ...items,
      { id: `new-${Date.now()}`, kind: 'phase', name: next?.name ?? '', boundary_date: '', done: false, actual_date: null },
    ])
  }

  function addMilestonePoint() {
    update([
      ...items,
      { id: `new-${Date.now()}`, kind: 'milestone', name: '', boundary_date: '', done: false, actual_date: null },
    ])
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    update(next)
  }

  function toggleKind(i: number) {
    update(
      items.map((x, j) =>
        j === i
          ? { ...x, kind: x.kind === 'phase' ? 'milestone' : 'phase' }
          : x,
      ),
    )
  }

  // Names offered in the phase dropdown: phase presets + any legacy names present.
  const phaseNames = useMemo(() => {
    const names = phasePresets.map((p) => p.name)
    for (const it of items)
      if (it.kind === 'phase' && it.name && !names.includes(it.name)) names.push(it.name)
    return names
  }, [phasePresets, items])

  return (
    <Modal title={`フェーズ／マイルストン — ${row.key_value}`} onClose={onClose} widthClass="w-[680px]">
      {msQ.isLoading ? (
        <div className="py-4 text-[var(--ink3)]">読み込み中…</div>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-[var(--ink3)]">
            <b>開始日と完了日</b>を入れると、設定の割合に応じてマイルストン（◇）の日付が自動で入ります。
            各日付は個別に上書きもできます。マイルストンを達成すると次のフェーズへ移行し、現在のフェーズが
            ステータスに表示されます。
          </p>

          {/* Task span — the only required input */}
          <div className="mb-3 flex flex-wrap items-end gap-3 rounded-[10px] border border-[var(--line)] bg-[#FCFBF7] px-3 py-2.5">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--ink3)]">
              開始日
              <Input
                type="date"
                className="w-[160px]"
                value={start}
                onChange={(e) => {
                  const v = e.target.value
                  setStart(v)
                  if (v && end) update(distribute(items, v, end))
                }}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--ink3)]">
              完了日
              <Input
                type="date"
                className="w-[160px]"
                value={end}
                onChange={(e) => {
                  const v = e.target.value
                  setEnd(v)
                  if (start && v) update(distribute(items, start, v))
                }}
              />
            </label>
            <Button variant="outline" size="sm" onClick={() => redistribute()} disabled={!start || !end}>
              割合で再配分
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {items.length === 0 && (
              <div className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--ink3)]">
                まだ項目がありません。下の「フェーズを追加」「マイルストンを追加」で作成します。
              </div>
            )}
            {items.map((d, i) => (
              <div
                key={d.id}
                className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-2"
              >
                <div className="flex flex-col">
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

                {/* Mark = kind. Click to toggle フェーズ⇄マイルストン (種別セレクト撤去). */}
                <button
                  type="button"
                  onClick={() => toggleKind(i)}
                  title={
                    d.kind === 'phase'
                      ? 'フェーズ（色付き区間）— クリックでマイルストンに変更'
                      : 'マイルストン（◇の節目）— クリックでフェーズに変更'
                  }
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded hover:bg-[var(--line2)]"
                >
                  {d.kind === 'phase' ? (
                    <span
                      className="h-5 w-5 rounded-[5px] border border-[var(--line)]"
                      style={{ background: colorFor(d.name) }}
                    />
                  ) : (
                    <span
                      className="h-[13px] w-[13px] border-[1.6px] border-[var(--ink)] bg-white"
                      style={{ transform: 'rotate(45deg)' }}
                    />
                  )}
                </button>

                {/* Name (no stacked label → stable row height / no がたつき) */}
                {d.kind === 'phase' && hasDefaults ? (
                  <Select
                    className="min-w-[160px] flex-1"
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
                    className="min-w-[160px] flex-1"
                    placeholder={d.kind === 'phase' ? 'フェーズ名（例: 設計）' : 'マイルストン名（例: レビュー）'}
                    value={d.name}
                    onChange={(e) =>
                      update(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                    }
                  />
                )}

                {/* Milestone-only: date / achievement / actual date */}
                {d.kind === 'milestone' && (
                  <>
                    <Input
                      type="date"
                      className="w-[150px] flex-shrink-0"
                      title="日付（開始〜完了から自動。手で上書き可）"
                      value={d.boundary_date}
                      onChange={(e) =>
                        update(items.map((x, j) => (j === i ? { ...x, boundary_date: e.target.value } : x)))
                      }
                    />
                    <label
                      className="flex flex-shrink-0 cursor-pointer select-none items-center gap-1 whitespace-nowrap text-[11px] text-[var(--ink3)]"
                      title="この節目を達成（完了）済みにする"
                    >
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
                                    actual_date: e.target.checked ? x.actual_date ?? todayISO() : null,
                                  }
                                : x,
                            ),
                          )
                        }
                      />
                      達成
                    </label>
                    {d.done && (
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <Input
                          type="date"
                          className="w-[150px]"
                          title="実績完了日"
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
                      </div>
                    )}
                  </>
                )}

                <button
                  className="ml-auto flex-shrink-0 rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                  onClick={() => update(items.filter((_, j) => j !== i))}
                  title="削除"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={addPhase}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
            >
              <PlusIcon className="h-[15px] w-[15px]" />
              フェーズを追加
            </button>
            <button
              onClick={addMilestonePoint}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
            >
              <PlusIcon className="h-[15px] w-[15px]" />
              マイルストンを追加
            </button>
          </div>

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
    <span className="whitespace-nowrap text-[10.5px]" style={{ color: d > 0 ? '#A8442B' : '#266B53' }}>
      {text}
    </span>
  )
}
