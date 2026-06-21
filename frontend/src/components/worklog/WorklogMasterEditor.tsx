// Admin settings for 実績入力, shown as a panel on the 実績入力 page:
//  - category master: a 2-level cascading tree (大分類 → 中分類). Each 大分類 has
//    its OWN 中分類 list (pick a 大分類 on the left to edit its 中分類 on the right).
//  - 記載ルール: free text shown to everyone at the bottom of 実績入力.

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useOrg } from '@/hooks/useSheets'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PlusIcon, TrashIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import type { WorkLogCategoryNode } from '@/types/api'

function clone(nodes: WorkLogCategoryNode[]): WorkLogCategoryNode[] {
  return nodes.map((n) => ({ name: n.name, children: n.children ? clone(n.children) : [] }))
}

/** Drop blank names and empty children arrays before saving. */
function strip(nodes: WorkLogCategoryNode[]): WorkLogCategoryNode[] {
  return nodes
    .filter((n) => n.name.trim())
    .map((n) => {
      const children = strip(n.children ?? [])
      return children.length ? { name: n.name.trim(), children } : { name: n.name.trim() }
    })
}

export function WorklogMasterEditor({ onClose }: { onClose: () => void }) {
  const orgQ = useOrg()
  if (orgQ.isLoading || !orgQ.data) {
    return (
      <Card>
        <CardBody className="text-[var(--ink3)]">読み込み中…</CardBody>
      </Card>
    )
  }
  const wl = orgQ.data.settings?.worklog
  return <Editor initialCategories={wl?.categories ?? []} initialNote={wl?.note ?? ''} onClose={onClose} />
}

function Editor({
  initialCategories,
  initialNote,
  onClose,
}: {
  initialCategories: WorkLogCategoryNode[]
  initialNote: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [cats, setCats] = useState<WorkLogCategoryNode[]>(() => clone(initialCategories))
  const [note, setNote] = useState(initialNote)
  const [sel1, setSel1] = useState(0)

  const save = useMutation({
    mutationFn: () =>
      api.updateOrg({
        settings: { worklog: { categories: strip(cats), note: note.trim() } },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org'] })
      onClose()
    },
  })

  // Immutable tree edit: deep-clone, mutate the draft, set.
  function edit(mut: (d: WorkLogCategoryNode[]) => void) {
    const next = clone(cats)
    mut(next)
    setCats(next)
  }
  const cur1 = cats[sel1]
  const cur1Name = cur1?.name?.trim()

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="text-[13px] font-semibold">実績入力の設定</div>

        <div>
          <div className="mb-1.5 text-[12px] font-medium text-[var(--ink2)]">分類（大分類 → 中分類）</div>
          <div className="mb-2 text-[11.5px] text-[var(--ink3)]">
            左で大分類を選ぶと、その大分類にひもづく中分類を右で編集できます。
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Column
              title="大分類"
              items={cats}
              selected={sel1}
              onFocusItem={(i) => setSel1(i)}
              onRename={(i, v) => edit((d) => void (d[i].name = v))}
              onDelete={(i) =>
                edit((d) => {
                  d.splice(i, 1)
                  if (sel1 >= d.length) setSel1(Math.max(0, d.length - 1))
                })
              }
              onAdd={() => edit((d) => void d.push({ name: '', children: [] }))}
            />
            <Column
              title={cur1Name ? `「${cur1Name}」の中分類` : '中分類（先に大分類を選択）'}
              disabled={!cur1}
              items={cur1?.children ?? []}
              onRename={(j, v) => edit((d) => void (d[sel1].children![j].name = v))}
              onDelete={(j) => edit((d) => void d[sel1].children!.splice(j, 1))}
              onAdd={() => edit((d) => void (d[sel1].children ??= []).push({ name: '', children: [] }))}
            />
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-[12px] font-medium text-[var(--ink2)]">記載ルール（実績入力の下に常に表示）</div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="例：1日の合計が実働時間と合うように入力してください。会議は『その他』に。"
            className="w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12.5px] text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none focus:ring-2 focus:ring-[var(--green-l)]"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            キャンセル
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function Column({
  title,
  items,
  selected,
  disabled,
  onFocusItem,
  onRename,
  onDelete,
  onAdd,
}: {
  title: string
  items: WorkLogCategoryNode[]
  selected?: number
  disabled?: boolean
  onFocusItem?: (i: number) => void
  onRename: (i: number, v: string) => void
  onDelete: (i: number) => void
  onAdd: () => void
}) {
  return (
    <div className={cn('rounded-[10px] border border-[var(--line)] p-2.5', disabled && 'opacity-50')}>
      <div className="mb-1.5 text-[12px] font-medium text-[var(--ink2)]">{title}</div>
      <div className="flex flex-col gap-1">
        {items.map((n, i) => (
          <div
            key={i}
            className={cn(
              'flex items-center gap-1 rounded',
              onFocusItem && selected === i && 'bg-[var(--line2)]',
            )}
          >
            <Input
              value={n.name}
              placeholder="名称"
              className="w-full"
              onFocus={() => onFocusItem?.(i)}
              onChange={(e) => onRename(i, e.target.value)}
            />
            <button
              type="button"
              title="削除"
              onClick={() => onDelete(i)}
              className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={onAdd}
          className="flex items-center gap-1.5 rounded-[9px] border border-dashed border-[var(--line)] px-2.5 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)] disabled:cursor-not-allowed"
        >
          <PlusIcon className="h-[14px] w-[14px]" />
          追加
        </button>
      </div>
    </div>
  )
}
