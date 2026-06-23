// One editable 実績入力 line as a vertical card (mobile layout). Same fields and
// commit semantics as WorkLogRow, stacked for narrow screens with big tap targets
// and a decimal keypad for hours. The parent decides create vs update.

import { CommitInput, type WorkLogRowValue } from '@/components/worklog/WorkLogRow'
import { TaskSelect } from '@/components/worklog/TaskPicker'
import { Select } from '@/components/ui/Select'
import { TrashIcon } from '@/components/ui/icons'
import type { TaskOption, WorkLogCategoryNode, WorkLogMaster } from '@/types/api'

interface Props {
  value: WorkLogRowValue
  tasks: TaskOption[]
  multiSheet: boolean
  master: WorkLogMaster | undefined
  onChange: (patch: Partial<WorkLogRowValue>) => void
  onDelete?: () => void
}

function childrenOf(
  nodes: WorkLogCategoryNode[] | undefined,
  name: string | null,
): WorkLogCategoryNode[] {
  if (!nodes || !name) return []
  return nodes.find((n) => n.name === name)?.children ?? []
}

const FieldLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="mb-1 block text-[11px] font-medium text-[var(--ink3)]">{children}</span>
)

export function WorkLogCard({ value, tasks, multiSheet, master, onChange, onDelete }: Props) {
  const lvl1 = master?.categories ?? []
  const lvl2 = childrenOf(lvl1, value.cat1)

  return (
    <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3">
      <div>
        <FieldLabel>タスク</FieldLabel>
        <TaskSelect
          tasks={tasks}
          multiSheet={multiSheet}
          rowId={value.row_id}
          fallbackLabel={value.row_key_value}
          onPick={(rowId) => onChange({ row_id: rowId })}
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <FieldLabel>大分類</FieldLabel>
          <Select
            className="w-full"
            value={value.cat1 ?? ''}
            onChange={(e) => onChange({ cat1: e.target.value || null, cat2: null })}
          >
            <option value="">（大分類）</option>
            {lvl1.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>中分類</FieldLabel>
          <Select
            className="w-full"
            value={value.cat2 ?? ''}
            disabled={lvl2.length === 0}
            onChange={(e) => onChange({ cat2: e.target.value || null })}
          >
            <option value="">（中分類）</option>
            {lvl2.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </Select>
        </div>
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
