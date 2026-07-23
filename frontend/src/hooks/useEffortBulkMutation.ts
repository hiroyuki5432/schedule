// Bulk weekly-effort write — one request for a whole pasted / cleared range,
// instead of one PUT per cell. Optimistically patches the ['effort', sheetId]
// cache so a 200-cell paste appears instantly, and rolls back on error.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { toast } from '@/lib/toast'
import type { Effort, EffortBulkItem } from '@/types/api'

export interface BulkEffortEdit {
  rowId: string
  weekStart: string
  field: 'planned_hours' | 'actual_hours'
  value: number | null
}

export function useEffortBulkMutation(sheetId: string | undefined) {
  const qc = useQueryClient()
  const key = ['effort', sheetId]

  return useMutation({
    mutationFn: (edits: BulkEffortEdit[]) =>
      api.putEffortBulk(
        edits.map(
          (e): EffortBulkItem => ({
            row_id: e.rowId,
            week_start: e.weekStart,
            [e.field]: e.value,
          }),
        ),
      ),
    onMutate: async (edits) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Effort[]>(key) ?? []
      qc.setQueryData<Effort[]>(key, applyAll(prev, edits))
      return { prev }
    },
    onError: (_err, _edits, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
      toast.show('まとめて保存できませんでした。通信状況を確認してください。', 'error')
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key })
    },
  })
}

function applyAll(list: Effort[], edits: BulkEffortEdit[]): Effort[] {
  // Index once — a large paste would otherwise be O(cells × entries).
  const byKey = new Map<string, number>()
  const out = list.slice()
  out.forEach((e, i) => byKey.set(`${e.row_id}|${e.week_start}`, i))
  for (const edit of edits) {
    const k = `${edit.rowId}|${edit.weekStart}`
    const idx = byKey.get(k)
    if (idx != null) {
      out[idx] = { ...out[idx], [edit.field]: edit.value }
    } else {
      byKey.set(k, out.length)
      out.push({
        row_id: edit.rowId,
        week_start: edit.weekStart,
        planned_hours: edit.field === 'planned_hours' ? edit.value : null,
        actual_hours: edit.field === 'actual_hours' ? edit.value : null,
      })
    }
  }
  return out
}
