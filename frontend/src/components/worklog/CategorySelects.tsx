// Cascading 大分類 → 中分類 selects, driven by the org's category master
// (org.settings.worklog.categories). Selecting 大 narrows 中 and resets it.

import { Select } from '@/components/ui/Select'
import type { WorkLogCategoryNode, WorkLogMaster } from '@/types/api'

export interface CategoryValue {
  cat1: string | null
  cat2: string | null
}

interface Props {
  master: WorkLogMaster | undefined
  value: CategoryValue
  onChange: (patch: Partial<CategoryValue>) => void
}

function childrenOf(
  nodes: WorkLogCategoryNode[] | undefined,
  name: string | null,
): WorkLogCategoryNode[] {
  if (!nodes || !name) return []
  return nodes.find((n) => n.name === name)?.children ?? []
}

export function CategorySelects({ master, value, onChange }: Props) {
  const lvl1 = master?.categories ?? []
  const lvl2 = childrenOf(lvl1, value.cat1)

  return (
    <>
      <td className="px-1 py-1">
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
      </td>
      <td className="px-1 py-1">
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
      </td>
    </>
  )
}
