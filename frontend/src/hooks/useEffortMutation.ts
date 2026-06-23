// Optimistic effort upsert. Edits the ['effort', sheetId] cache immediately,
// rolls back on error (SPEC 14: optimistic + last-write-wins).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import type { Effort } from '@/types/api'

interface Vars {
  rowId: string
  weekStart: string
  /** Which value the cell currently represents (past=actual, future=planned). */
  field: 'planned_hours' | 'actual_hours'
  value: number | null
}

export function useEffortMutation(sheetId: string | undefined) {
  const qc = useQueryClient()
  const key = ['effort', sheetId]

  return useMutation({
    mutationFn: ({ rowId, weekStart, field, value }: Vars) => {
      // Send the current cell's version so a concurrent edit is detected (409)
      // rather than silently last-write-wins. New cells have no version → create.
      const cached = qc.getQueryData<Effort[]>(key) ?? []
      const cur = cached.find((e) => e.row_id === rowId && e.week_start === weekStart)
      return api.putEffort(rowId, weekStart, {
        [field]: value,
        ...(cur?.version != null ? { version: cur.version } : {}),
      })
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Effort[]>(key) ?? []
      const next = upsert(prev, vars)
      qc.setQueryData<Effort[]>(key, next)
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key })
    },
  })
}

function upsert(list: Effort[], vars: Vars): Effort[] {
  const idx = list.findIndex(
    (e) => e.row_id === vars.rowId && e.week_start === vars.weekStart,
  )
  if (idx >= 0) {
    const copy = list.slice()
    copy[idx] = { ...copy[idx], [vars.field]: vars.value }
    return copy
  }
  const fresh: Effort = {
    row_id: vars.rowId,
    week_start: vars.weekStart,
    planned_hours: vars.field === 'planned_hours' ? vars.value : null,
    actual_hours: vars.field === 'actual_hours' ? vars.value : null,
  }
  return [...list, fresh]
}
