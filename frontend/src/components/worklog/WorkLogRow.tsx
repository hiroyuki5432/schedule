// One editable 実績入力 line (table row). Selects commit immediately; text/number
// fields commit on blur/Enter. The parent decides whether a change creates or
// updates a record.

import { useEffect, useState } from 'react'
import { CategorySelects } from '@/components/worklog/CategorySelects'
import { TaskSelect } from '@/components/worklog/TaskPicker'
import { Input } from '@/components/ui/Input'
import { TrashIcon } from '@/components/ui/icons'
import type { TaskOption, WorkLogMaster } from '@/types/api'

export interface WorkLogRowValue {
  row_id: string | null
  row_key_value: string | null
  cat1: string | null
  cat2: string | null
  memo: string | null
  hours: number | null
}

interface Props {
  value: WorkLogRowValue
  tasks: TaskOption[]
  multiSheet: boolean
  master: WorkLogMaster | undefined
  onChange: (patch: Partial<WorkLogRowValue>) => void
  onDelete?: () => void
}

/** Text/number input that commits on blur or Enter (not on every keystroke).
 *  Number fields request the decimal keypad on mobile (inputMode="decimal"). */
export function CommitInput({
  value,
  type = 'text',
  placeholder,
  className,
  onCommit,
}: {
  value: string
  type?: string
  placeholder?: string
  className?: string
  onCommit: (v: string) => void
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <Input
      type={type}
      inputMode={type === 'number' ? 'decimal' : undefined}
      step={type === 'number' ? '0.5' : undefined}
      value={v}
      placeholder={placeholder}
      className={className}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) onCommit(v)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

export function WorkLogRow({ value, tasks, multiSheet, master, onChange, onDelete }: Props) {
  return (
    <tr className="border-b border-[var(--line2)] align-middle">
      <td className="px-1 py-1">
        <TaskSelect
          tasks={tasks}
          multiSheet={multiSheet}
          rowId={value.row_id}
          fallbackLabel={value.row_key_value}
          onPick={(rowId) => onChange({ row_id: rowId })}
        />
      </td>

      <CategorySelects
        master={master}
        value={{ cat1: value.cat1, cat2: value.cat2 }}
        onChange={(patch) => onChange(patch)}
      />

      <td className="px-1 py-1">
        <CommitInput
          value={value.memo ?? ''}
          placeholder="メモ・詳細"
          className="w-full"
          onCommit={(v) => onChange({ memo: v || null })}
        />
      </td>

      <td className="px-1 py-1">
        <CommitInput
          value={value.hours == null ? '' : String(value.hours)}
          type="number"
          placeholder="0"
          className="w-[72px] text-right"
          onCommit={(v) => {
            const n = v.trim() === '' ? null : Number(v)
            onChange({ hours: n != null && Number.isFinite(n) ? n : null })
          }}
        />
      </td>

      <td className="px-1 py-1 text-right">
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="行を削除"
            className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </td>
    </tr>
  )
}
