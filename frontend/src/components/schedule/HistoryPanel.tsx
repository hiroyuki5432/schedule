// 変更履歴 — who changed what, when.
//
// The weekly snapshot diff can only say "something changed between these two
// weeks". This reads the recorded change log instead, so 「先週から何が変わった？」
// has a real answer down to the individual cell.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { cn } from '@/lib/format'
import type { RowEvent } from '@/types/api'

export type HistoryScope =
  | { kind: 'sheet'; sheetId: string; name: string }
  | { kind: 'row'; rowId: string; name: string }

const KIND_LABEL: Record<RowEvent['kind'], string> = {
  create: '追加',
  update: '変更',
  delete: '削除',
  effort: '工数',
}

const KIND_STYLE: Record<RowEvent['kind'], string> = {
  create: 'bg-[#E6F0DB] text-[#3E6D14]',
  update: 'bg-[#E3EFEA] text-[#266B53]',
  delete: 'bg-[#FAE6E0] text-[#A8442B]',
  effort: 'bg-[#EFEDE4] text-[#6A675C]',
}

export function HistoryPanel({
  scope,
  onClose,
}: {
  scope: HistoryScope
  onClose: () => void
}) {
  const [query, setQuery] = useState('')

  const q = useQuery({
    queryKey:
      scope.kind === 'sheet'
        ? ['sheet-history', scope.sheetId]
        : ['row-history', scope.rowId],
    queryFn: () =>
      scope.kind === 'sheet'
        ? api.getSheetHistory(scope.sheetId)
        : api.getRowHistory(scope.rowId),
  })

  const events = useMemo(() => {
    const all = q.data ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter((e) =>
      [e.row_key, e.user_name, e.field_label, e.old_value, e.new_value]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [q.data, query])

  // Group by calendar day so a long log stays scannable.
  const groups = useMemo(() => {
    const map = new Map<string, RowEvent[]>()
    for (const e of events) {
      const day = dayLabel(e.created_at)
      const list = map.get(day) ?? []
      list.push(e)
      map.set(day, list)
    }
    return [...map.entries()]
  }, [events])

  return (
    <Modal
      title={
        <span className="flex items-baseline gap-2">
          変更履歴
          <span className="text-[12px] font-normal text-[var(--ink3)]">{scope.name}</span>
        </span>
      }
      onClose={onClose}
      widthClass="w-[720px] max-w-full"
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="タスクID・担当者・項目名で絞り込み"
        className="mb-3 w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12.5px] outline-none focus:border-[var(--green-l)]"
      />

      {q.isLoading ? (
        <TableSkeleton rows={6} cols={4} />
      ) : q.isError ? (
        <EmptyState
          compact
          title="履歴を読み込めませんでした"
          body="通信状況を確認して、もう一度開いてください。"
        />
      ) : groups.length === 0 ? (
        <EmptyState
          compact
          title={query ? '一致する変更はありません' : 'まだ変更の記録はありません'}
          body={
            query
              ? '別のことばで探してみてください。'
              : 'この画面で値を変えると、ここに「誰が・いつ・何を」が記録されていきます。'
          }
        />
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          {groups.map(([day, list]) => (
            <div key={day}>
              <div className="sticky top-0 z-10 bg-[var(--surface)] py-1.5 text-[11px] font-semibold text-[var(--ink3)]">
                {day}
              </div>
              {list.map((e) => (
                <div
                  key={e.id}
                  className="flex items-start gap-2.5 border-b border-[var(--line2)] py-2 text-[12.5px]"
                >
                  <span className="w-[42px] flex-shrink-0 pt-0.5 text-[11px] text-[var(--ink3)]">
                    {timeLabel(e.created_at)}
                  </span>
                  <span
                    className={cn(
                      'mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      KIND_STYLE[e.kind],
                    )}
                  >
                    {KIND_LABEL[e.kind]}
                  </span>
                  <span className="w-[110px] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                    {e.row_key ?? '—'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-[var(--ink3)]">{e.field_label}</span>{' '}
                    <ValueChange oldValue={e.old_value} newValue={e.new_value} />
                  </span>
                  <span className="w-[80px] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[11.5px] text-[var(--ink3)]">
                    {e.user_name}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** 「未着手 → 進行中」. A blank side renders as (空) so a clear is still visible. */
function ValueChange({
  oldValue,
  newValue,
}: {
  oldValue: string | null
  newValue: string | null
}) {
  const blank = <span className="text-[var(--ink3)]">(空)</span>
  if (!oldValue && !newValue) return null
  return (
    <span className="whitespace-normal break-words">
      {oldValue ? <s className="text-[var(--ink3)]">{oldValue}</s> : blank}
      <span className="mx-1 text-[var(--ink3)]">→</span>
      {newValue ? <b className="font-semibold">{newValue}</b> : blank}
    </span>
  )
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (same(d, today)) return '今日'
  if (same(d, yesterday)) return '昨日'
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
