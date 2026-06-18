// Row data mutation (PATCH /api/rows/{id}). Used by both the schedule frozen
// attribute columns and the table sheet view. Invalidates the sheet detail so
// derived models (status badge, gantt, lookups) recompute.
//
// NOTE: row ids are numbers at runtime even though the type says string; `data`
// keys are stringified column ids. We merge a partial `data` patch onto the
// row's existing data and send the row's current `version` for optimistic lock.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import type { CellValue, Row } from '@/types/api'

interface Vars {
  row: Row
  /** Partial data patch keyed by (stringified) column id. */
  patch: Record<string, CellValue>
  /** When set, also rename the row's key_value (ID). Duplicates are allowed. */
  keyValue?: string
}

export function useRowMutation(sheetId: string | undefined) {
  const qc = useQueryClient()

  return useMutation({
    mutationFn: ({ row, patch, keyValue }: Vars) =>
      api.updateRow(row.id, {
        data: { ...row.data, ...patch },
        version: row.version,
        ...(keyValue !== undefined ? { key_value: keyValue } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
    },
    onError: (err) => {
      // 409 conflict: re-fetch so the user sees the current value.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
      }
      // TODO: surface a toast on failure.
    },
  })
}
