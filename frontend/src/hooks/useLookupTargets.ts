// Fetches the sheet details referenced by lookup columns, returning a resolver.
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import * as api from '@/api/client'
import { lookupTargetSheetIds, resolveLookup } from '@/lib/lookup'
import type { TargetSheets } from '@/lib/lookup'
import type { Column, Member, Row, SheetDetail } from '@/types/api'

export function useLookupTargets(columns: Column[], members: Member[] = []) {
  const targetIds = useMemo(() => lookupTargetSheetIds(columns), [columns])

  const queries = useQueries({
    queries: targetIds.map((id) => ({
      queryKey: ['sheet', id],
      queryFn: () => api.getSheet(id),
    })),
  })

  const targets: TargetSheets = useMemo(() => {
    const map: TargetSheets = {}
    targetIds.forEach((id, i) => {
      map[id] = queries[i]?.data as SheetDetail | undefined
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIds, queries.map((q) => q.dataUpdatedAt).join(',')])

  const lookupValue = useMemo(
    () => (column: Column, row: Row) => resolveLookup(column, row, targets, members),
    [targets, members],
  )

  return { lookupValue }
}
