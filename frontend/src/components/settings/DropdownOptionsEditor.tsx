// Editor for a dropdown column's options: { options: [{ id, value, color, frozen }] }.
// Add / bulk-import / reorder / freeze / remove options; color swatch per option.
// Each option carries a stable `id` so renaming a value follows through to the
// stored row data (the backend remaps on save). Frozen options stay in the data
// but are hidden from the picker. Saves into column.config.
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { TrashIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import type { Column, DropdownOption } from '@/types/api'

const SWATCHES = [
  '#E3EFEA',
  '#EFEDE4',
  '#FAE6E0',
  '#E6F0DB',
  '#CBD9EE',
  '#F1DBAC',
  '#E7DDEA',
  '#DCE6EA',
]

function newId(): string {
  return crypto.randomUUID()
}

/** Ensure every option has a stable id (legacy options were saved without one). */
function withIds(options: DropdownOption[]): DropdownOption[] {
  return options.map((o) => ({ ...o, id: o.id ?? newId() }))
}

export function DropdownOptionsEditor({
  column,
  onDone,
}: {
  column: Column
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [options, setOptions] = useState<DropdownOption[]>(() =>
    withIds(column.config?.options ?? []),
  )
  const [newValue, setNewValue] = useState('')
  const [bulk, setBulk] = useState('')
  const [showBulk, setShowBulk] = useState(false)

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, { config: { ...column.config, options } }),
    onSuccess: () => {
      // Renames may have remapped stored values → refresh the sheet's rows.
      void qc.invalidateQueries({ queryKey: ['sheet'] })
      onDone()
    },
  })

  function add() {
    const v = newValue.trim()
    if (!v) return
    setOptions([...options, { id: newId(), value: v, color: SWATCHES[0] }])
    setNewValue('')
  }

  function importBulk() {
    // One option per line; commas also split. Skip blanks and existing values.
    const existing = new Set(options.map((o) => o.value))
    const toAdd: DropdownOption[] = []
    for (const raw of bulk.split(/[\n,]/)) {
      const v = raw.trim()
      if (!v || existing.has(v)) continue
      existing.add(v)
      toAdd.push({ id: newId(), value: v, color: SWATCHES[0] })
    }
    if (toAdd.length) setOptions([...options, ...toAdd])
    setBulk('')
    setShowBulk(false)
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= options.length) return
    const next = [...options]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOptions(next)
  }

  function patch(i: number, p: Partial<DropdownOption>) {
    setOptions(options.map((x, j) => (j === i ? { ...x, ...p } : x)))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — 選択肢</CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="mb-3 flex flex-col gap-2">
          {options.map((o, i) => (
            <li
              key={o.id ?? i}
              className={cn('flex items-center gap-2', o.frozen && 'opacity-55')}
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="上へ"
                  className="px-1 text-[10px] leading-none text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === options.length - 1}
                  title="下へ"
                  className="px-1 text-[10px] leading-none text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                >
                  ▼
                </button>
              </div>
              <ColorPicker
                value={o.color ?? SWATCHES[0]}
                onChange={(c) => patch(i, { color: c })}
              />
              <Input
                className="flex-1"
                value={o.value}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              <button
                type="button"
                onClick={() => patch(i, { frozen: !o.frozen })}
                title={
                  o.frozen
                    ? '凍結を解除（選択肢に表示）'
                    : '凍結（データは残すが選択肢から隠す）'
                }
                className={cn(
                  'rounded px-2 py-1 text-[11px] hover:bg-[var(--line2)]',
                  o.frozen ? 'text-[#A8442B]' : 'text-[var(--ink3)]',
                )}
              >
                {o.frozen ? '凍結中' : '凍結'}
              </button>
              <button
                className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                onClick={() => setOptions(options.filter((_, j) => j !== i))}
                title="削除"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li className="text-[12px] text-[var(--ink3)]">選択肢がありません。</li>
          )}
        </ul>

        {showBulk ? (
          <div className="mb-3 flex flex-col gap-2">
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              rows={5}
              placeholder={'まとめて追加（1行に1つ、カンマ区切りも可）\n例：未着手\n進行中\n完了'}
              className="w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12.5px] text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none focus:ring-2 focus:ring-[var(--green-l)]"
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowBulk(false)}>
                キャンセル
              </Button>
              <Button onClick={importBulk}>取り込む</Button>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex gap-2">
            <Input
              placeholder="選択肢を追加"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <Button variant="outline" onClick={add}>
              追加
            </Button>
            <Button variant="ghost" onClick={() => setShowBulk(true)}>
              まとめて追加
            </Button>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        className="h-7 w-7 rounded-[7px] border border-[var(--line)]"
        style={{ background: value }}
        onClick={() => setOpen((o) => !o)}
        title="色"
      />
      {open && (
        <div className="absolute left-0 z-10 mt-1 flex w-[136px] flex-wrap gap-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className="h-6 w-6 rounded-[6px] border border-[var(--line)]"
              style={{ background: c }}
              onClick={() => {
                onChange(c)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
