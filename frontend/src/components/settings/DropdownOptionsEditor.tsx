// Editor for a dropdown column's options: { options: [{ value, color }] }.
// Add / remove rows; color swatch per option. Saves into column.config.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { TrashIcon } from '@/components/ui/icons'
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

export function DropdownOptionsEditor({
  column,
  onDone,
}: {
  column: Column
  onDone: () => void
}) {
  const [options, setOptions] = useState<DropdownOption[]>(
    () => column.config?.options ?? [],
  )
  const [newValue, setNewValue] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, { config: { ...column.config, options } }),
    onSuccess: onDone,
  })

  function add() {
    const v = newValue.trim()
    if (!v) return
    setOptions([...options, { value: v, color: SWATCHES[0] }])
    setNewValue('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — 選択肢</CardTitle>
      </CardHeader>
      <CardBody>
        <ul className="mb-3 flex flex-col gap-2">
          {options.map((o, i) => (
            <li key={i} className="flex items-center gap-2">
              <ColorPicker
                value={o.color ?? SWATCHES[0]}
                onChange={(c) =>
                  setOptions(options.map((x, j) => (j === i ? { ...x, color: c } : x)))
                }
              />
              <Input
                className="flex-1"
                value={o.value}
                onChange={(e) =>
                  setOptions(
                    options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  )
                }
              />
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
        <div className="flex gap-2">
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
