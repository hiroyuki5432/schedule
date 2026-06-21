// Single dropdown of the current user's assigned tasks (from getMyTasks).
// Stores row_id. If the row isn't in the assigned list (e.g. reassigned later),
// a fallback option keeps the existing label visible.

import { Select } from '@/components/ui/Select'
import type { TaskOption } from '@/types/api'

interface Props {
  tasks: TaskOption[]
  /** Show the sheet name in each label (only when tasks span multiple sheets). */
  multiSheet: boolean
  rowId: string | null
  /** Fallback label for a row_id not present in `tasks`. */
  fallbackLabel?: string | null
  onPick: (rowId: string | null) => void
}

function label(t: TaskOption, multiSheet: boolean): string {
  const base = [t.key_value, t.title].filter(Boolean).join(' ') || `#${t.row_id}`
  return multiSheet ? `${base}（${t.sheet_name}）` : base
}

export function TaskSelect({ tasks, multiSheet, rowId, fallbackLabel, onPick }: Props) {
  const known = rowId != null && tasks.some((t) => String(t.row_id) === String(rowId))
  return (
    <Select className="w-full" value={rowId ?? ''} onChange={(e) => onPick(e.target.value || null)}>
      <option value="">（タスク）</option>
      {!known && rowId != null && (
        <option value={rowId}>{fallbackLabel || `#${rowId}`}</option>
      )}
      {tasks.map((t) => (
        <option key={t.row_id} value={t.row_id}>
          {label(t, multiSheet)}
        </option>
      ))}
    </Select>
  )
}
