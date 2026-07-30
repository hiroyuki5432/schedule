// Cascading category selects (大分類 → 中分類 → …), driven by the org's master
// (org.settings.worklog). 段数も名称も設定で変わるため、レベル数ぶんの <td> を出す。
// 上位を選び直すと下位はクリアされる。

import { Select } from '@/components/ui/Select'
import { CAT_FIELDS, categoryLevels, optionsPerLevel, pickPatch } from '@/lib/worklogCats'
import type { WorkLogMaster } from '@/types/api'

export interface CategoryValue {
  cat1: string | null
  cat2: string | null
  cat3: string | null
}

interface Props {
  master: WorkLogMaster | undefined
  value: CategoryValue
  onChange: (patch: Partial<CategoryValue>) => void
}

export function CategorySelects({ master, value, onChange }: Props) {
  const levels = categoryLevels(master)
  const values = CAT_FIELDS.map((f) => value[f] ?? null)
  const options = optionsPerLevel(master, values, levels.length)

  return (
    <>
      {levels.map((label, i) => (
        <td key={label + i} className="px-1 py-1">
          <Select
            className="w-full"
            value={values[i] ?? ''}
            disabled={i > 0 && options[i].length === 0}
            onChange={(e) =>
              onChange(pickPatch(i, e.target.value || null, levels.length) as Partial<CategoryValue>)
            }
          >
            <option value="">（{label}）</option>
            {options[i].map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
              </option>
            ))}
          </Select>
        </td>
      ))}
    </>
  )
}
