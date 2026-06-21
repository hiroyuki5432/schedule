// 先行タスク（依存）エディタ。このタスクが「前段が終わってから着手する」タスクを
// 複数選ぶ。保存は PATCH /api/rows/{id}（depends_on）。逆ザヤ（後段の開始が先行の
// 完了より前）はガント側で⚠表示される。

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/format'
import type { Row } from '@/types/api'

export interface DepCandidate {
  id: string
  key_value: string
  title: string
}

export function DependencyEditor({
  row,
  candidates,
  sheetId,
  onClose,
}: {
  row: Row
  candidates: DepCandidate[]
  sheetId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((row.depends_on ?? []).map(String)),
  )
  const [q, setQ] = useState('')

  const list = useMemo(() => {
    const query = q.trim().toLowerCase()
    return candidates.filter(
      (c) =>
        String(c.id) !== String(row.id) &&
        (!query || `${c.key_value} ${c.title}`.toLowerCase().includes(query)),
    )
  }, [candidates, q, row.id])

  const mutation = useMutation({
    mutationFn: () =>
      api.updateRow(row.id, {
        data: row.data,
        version: row.version,
        depends_on: [...selected],
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
      onClose()
    },
  })

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  return (
    <Modal
      title={`先行タスク（依存） — ${row.key_value}`}
      onClose={onClose}
      widthClass="w-[480px]"
    >
      <p className="mb-2 text-[12px] text-[var(--ink3)]">
        このタスクの前段（先に終わっているべき）タスクを選びます。後段の開始が先行の
        完了より前だと「逆ザヤ」として⚠で警告されます。
      </p>
      <Input
        className="mb-2"
        placeholder="タスクを検索（ID・件名）"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="flex max-h-[320px] flex-col gap-1 overflow-auto">
        {list.length === 0 && (
          <div className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--ink3)]">
            該当するタスクがありません。
          </div>
        )}
        {list.map((c) => {
          const on = selected.has(String(c.id))
          return (
            <label
              key={c.id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-[9px] border px-2 py-1.5',
                on
                  ? 'border-[var(--green)] bg-[var(--green-l)]/10'
                  : 'border-[var(--line)] hover:bg-[var(--line2)]',
              )}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(String(c.id))}
                className="h-4 w-4 flex-shrink-0 accent-[var(--green)]"
              />
              <span className="flex-shrink-0 text-[12px] font-medium text-[var(--ink3)]">
                {c.key_value}
              </span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px]">
                {c.title}
              </span>
            </label>
          )
        })}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[12px] text-[var(--ink3)]">{selected.size}件 選択中</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            キャンセル
          </Button>
          <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}
