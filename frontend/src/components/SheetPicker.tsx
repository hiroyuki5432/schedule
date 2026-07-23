// Sheet selector for the cross-sheet screens. Hidden when there is only one
// sheet — a dropdown with a single option is just noise.

import { Select } from '@/components/ui/Select'
import type { Sheet } from '@/types/api'

export function SheetPicker({
  sheets,
  sheetId,
  onChange,
  label = 'シート',
}: {
  sheets: Sheet[]
  sheetId: string | undefined
  onChange: (id: string) => void
  label?: string
}) {
  if (sheets.length <= 1) return null
  return (
    <label className="flex items-center gap-2 text-[12px] text-[var(--ink2)]">
      {label}:
      <Select value={sheetId ?? ''} onChange={(e) => onChange(e.target.value)}>
        {sheets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </label>
  )
}
