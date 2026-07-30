// Admin settings for 実績入力, shown as a panel on the 実績入力 page:
//  - category master: cascading levels (既定は 大分類 → 中分類)。段数（1〜3）も
//    各段の名称も変えられ、各段の項目は上位で選んだ項目にひもづく。
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
import { CAT_FIELDS, categoryLevels } from '@/lib/worklogCats'
import type { WorkLogCategoryNode } from '@/types/api'

const MAX_LEVELS = CAT_FIELDS.length

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
  return (
    <Editor
      initialCategories={wl?.categories ?? []}
      initialLevels={categoryLevels(wl)}
      initialNote={wl?.note ?? ''}
      onClose={onClose}
    />
  )
}

function Editor({
  initialCategories,
  initialLevels,
  initialNote,
  onClose,
}: {
  initialCategories: WorkLogCategoryNode[]
  initialLevels: string[]
  initialNote: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [cats, setCats] = useState<WorkLogCategoryNode[]>(() => clone(initialCategories))
  const [levels, setLevels] = useState<string[]>(() => [...initialLevels])
  const [note, setNote] = useState(initialNote)
  /** Selected item index per level (drives which list the next level shows). */
  const [path, setPath] = useState<number[]>([0, 0])

  const save = useMutation({
    mutationFn: () =>
      api.updateOrg({
        settings: {
          worklog: {
            categories: strip(cats),
            category_levels: levels.map((l, i) => l.trim() || `分類${i + 1}`),
            note: note.trim(),
          },
        },
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

  /** The item list shown at `level`, following the current selection path
   *  (read-only — edits go through listAtIn on a draft copy). */
  function listAt(level: number, tree: WorkLogCategoryNode[]): WorkLogCategoryNode[] | null {
    let nodes: WorkLogCategoryNode[] = tree
    for (let i = 0; i < level; i++) {
      const node: WorkLogCategoryNode | undefined = nodes[path[i] ?? 0]
      if (!node) return null
      nodes = node.children ?? []
    }
    return nodes
  }

  const selectAt = (level: number, index: number) =>
    setPath((p) => {
      const next = [...p]
      next[level] = index
      for (let i = level + 1; i < next.length; i++) next[i] = 0
      return next
    })

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="text-[13px] font-semibold">実績入力の設定</div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-medium text-[var(--ink2)]">
              分類（{levels.join(' → ')}）
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={levels.length >= MAX_LEVELS}
              onClick={() => setLevels([...levels, `分類${levels.length + 1}`])}
              title={levels.length >= MAX_LEVELS ? `分類は最大${MAX_LEVELS}段です` : '段を追加'}
            >
              ＋段を追加
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={levels.length <= 1}
              onClick={() => setLevels(levels.slice(0, -1))}
              title="最後の段を減らす（その段の項目は残りますが、入力欄には出なくなります）"
            >
              − 段を減らす
            </Button>
          </div>
          <div className="mb-2 text-[11.5px] text-[var(--ink3)]">
            左の段で項目を選ぶと、その項目にひもづく次の段を右で編集できます。段の名前も変更できます
            （最大{MAX_LEVELS}段）。
          </div>
          <div
            className="grid grid-cols-1 gap-3"
            style={{ gridTemplateColumns: `repeat(${Math.min(levels.length, 3)}, minmax(0, 1fr))` }}
          >
            {levels.map((label, level) => {
              const items = listAt(level, cats)
              const parentName =
                level === 0 ? null : listAt(level - 1, cats)?.[path[level - 1] ?? 0]?.name?.trim()
              return (
                <LevelColumn
                  key={level}
                  label={label}
                  onLabel={(v) =>
                    setLevels((ls) => ls.map((x, i) => (i === level ? v : x)))
                  }
                  hint={level === 0 ? undefined : parentName ? `「${parentName}」の中` : '上の段を選択'}
                  disabled={level > 0 && (items === null || !parentName)}
                  items={items ?? []}
                  selected={path[level] ?? 0}
                  onFocusItem={(i) => selectAt(level, i)}
                  onRename={(i, v) =>
                    edit((d) => {
                      const list = listAtIn(d, path, level)
                      if (list) list[i].name = v
                    })
                  }
                  onDelete={(i) =>
                    edit((d) => {
                      const list = listAtIn(d, path, level)
                      if (!list) return
                      list.splice(i, 1)
                      if ((path[level] ?? 0) >= list.length) selectAt(level, Math.max(0, list.length - 1))
                    })
                  }
                  onAdd={() =>
                    edit((d) => {
                      const list = listAtIn(d, path, level)
                      list?.push({ name: '', children: [] })
                    })
                  }
                />
              )
            })}
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

/** Same walk as listAt, but against a draft tree being mutated. */
function listAtIn(
  tree: WorkLogCategoryNode[],
  path: number[],
  level: number,
): WorkLogCategoryNode[] | null {
  let nodes: WorkLogCategoryNode[] | null = tree
  for (let i = 0; i < level; i++) {
    const node: WorkLogCategoryNode | undefined = nodes?.[path[i] ?? 0]
    if (!node) return null
    nodes = node.children ??= []
  }
  return nodes
}

function LevelColumn({
  label,
  onLabel,
  hint,
  items,
  selected,
  disabled,
  onFocusItem,
  onRename,
  onDelete,
  onAdd,
}: {
  label: string
  onLabel: (v: string) => void
  hint?: string
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
      <div className="mb-1.5 flex items-center gap-1.5">
        <Input
          value={label}
          placeholder="段の名前"
          className="h-7 w-[110px] px-2 py-1 text-[12px] font-medium"
          onChange={(e) => onLabel(e.target.value)}
          title="この段の名前（例: 大分類）"
        />
        {hint && <span className="truncate text-[11px] text-[var(--ink3)]">{hint}</span>}
      </div>
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
