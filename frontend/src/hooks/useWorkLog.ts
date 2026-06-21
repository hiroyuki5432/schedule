// Daily work-log (日報) queries + mutations. Mutations invalidate the schedule
// caches so the gantt/dashboard reflect the recomputed weekly actuals.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import type { WorkLogInput } from '@/types/api'

export function useWorkLogs(from: string, to: string) {
  return useQuery({
    queryKey: ['worklogs', from, to],
    queryFn: () => api.getWorkLogs({ from, to }),
  })
}

export function useWorkLogMutations() {
  const qc = useQueryClient()
  // A worklog change recomputes EffortEntry.actual_hours, so refresh anything
  // that reads effort (gantt sheet detail, effort range, dashboard aggregate).
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['worklogs'] })
    qc.invalidateQueries({ queryKey: ['effort'] })
    qc.invalidateQueries({ queryKey: ['aggregate'] })
    qc.invalidateQueries({ queryKey: ['sheet'] })
  }

  const create = useMutation({
    mutationFn: (body: WorkLogInput) => api.createWorkLog(body),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<WorkLogInput> }) =>
      api.updateWorkLog(id, patch),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkLog(id),
    onSuccess: invalidate,
  })

  return { create, update, remove }
}
