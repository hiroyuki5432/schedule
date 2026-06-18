import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'

export function useSheets() {
  return useQuery({ queryKey: ['sheets'], queryFn: api.getSheets })
}

export function useColumns(sheetId: string | undefined) {
  return useQuery({
    queryKey: ['columns', sheetId],
    queryFn: () => api.getColumns(sheetId!),
    enabled: !!sheetId,
  })
}

export function useOrg() {
  return useQuery({ queryKey: ['org'], queryFn: api.getOrg })
}

export function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: api.getMembers })
}

/** Week-start weekday from org settings, defaulting to Monday (1). */
export function useWeekStartWeekday(): number {
  const { data } = useOrg()
  return data?.settings?.week_start_weekday ?? 1
}
