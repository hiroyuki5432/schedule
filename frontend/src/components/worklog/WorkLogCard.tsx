// One editable 実績入力 line as a vertical card (mobile layout). Same fields and
// commit semantics as WorkLogRow, stacked for narrow screens with big tap targets
// and a decimal keypad for hours. The parent decides create vs update.

import { CommitInput, type WorkLogRowValue } from '@/components/worklog/WorkLogRow'
import { TaskSelect } from '@/components/worklog/TaskPicker'
import { Select } from '@/components/ui/Select'
import { TrashIcon } from '@/components/ui/icons'
import { CAT_FIELDS, categoryLevels, optionsPerLevel, pickPatch } from '@/lib/worklogCats'
import type { TaskOption, WorkLogMaster } from '@/types/api'

interface Props {
  value: WorkLogRowValue
  tasks: TaskOption[]
  multiSheet: boolean
  master: WorkLogMaster | undefined
  onChange: (patch: Partial<WorkLogRowValue>) => void
  onDelete?: () => void
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="mb-1 block text-[11px] font-medium text-[var(--ink3)]">{children}</span>
)

export function WorkLogCard({ value, tasks, multiSheet, master, onChange, onDelete }: Props) {
  const levels = categoryLevels(master)
  const values = CAT_FIELDS.map((f) => value[f] ?? null)
  const options = optionsPerLevel(master, values, levels.length)

  return (
    <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3">
      <div>
        <FieldLabel>タスク</FieldLabel>
        <TaskSelect
          tasks={tasks}
          multiSheet={multiSheet}
          rowId={value.row_id}
          fallbackLabel={value.row_label || value.row_key_value}
          onPick={(rowId) => onChange({ row_id: rowId })}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {levels.map((label, i) => (
          <div key={label + i}>
            <FieldLabel>{label}</FieldLabel>
            <Select
              className="w-full"
              value={values[i] ?? ''}
              disabled={i > 0 && options[i].length === 0}
              onChange={(e) =>
                onChange(
                  pickPatch(i, e.target.value || null, levels.length) as Partial<WorkLogRowValue>,
                )
              }
            >
              <option value="">（{label}）</option>
              {options[i].map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>

      <div className="mt-2">
        <FieldLabel>メモ・詳細</FieldLabel>
        <CommitInput
          value={value.memo ?? ''}
          placeholder="メモ・詳細"
          className="w-full"
          onCommit={(v) => onChange({ memo: v || null })}
        />
      </div>

      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="flex-1">
          <FieldLabel>時間(h)</FieldLabel>
          <CommitInput
            value={value.hours == null ? '' : String(value.hours)}
            type="number"
            placeholder="0"
            className="w-[110px] text-right"
            onCommit={(v) => {
              const n = v.trim() === '' ? null : Number(v)
              onChange({ hours: n != null && Number.isFinite(n) ? n : null })
            }}
          />
        </div>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="行を削除"
            className="rounded-[9px] border border-[var(--line)] p-2 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
