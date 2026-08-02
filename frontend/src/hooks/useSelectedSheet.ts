// Sheet selection for the cross-sheet screens (ダッシュボード / マイタスク).
//
// Both used to hard-code sheets[0], so anyone whose real data lived on the
// second sheet saw someone else's numbers. The choice persists per screen.

import { useMemo } from 'react'
import { useSheets } from '@/hooks/useSheets'
import { usePersistentState } from '@/hooks/usePersistentState'
import type { Sheet } from '@/types/api'

export interface SelectedSheet {
  sheets: Sheet[]
  sheetId: string | undefined
  setSheetId: (id: string) => void
  loading: boolean
}

/**
 * @param storageKey  localStorage key so each screen remembers its own choice.
 * @param onlyWeekGrid Restrict to schedule sheets (screens that read weekly effort).
 */
export function useSelectedSheet(storageKey: string, onlyWeekGrid = false): SelectedSheet {
  const sheetsQ = useSheets()
  const sheets = useMemo(() => {
    // マスタシートは作業対象ではないので、この画面のシート選択には出さない。
    const all = [...(sheetsQ.data ?? [])]
      .filter((s) => !s.is_master)
      .sort((a, b) => a.order - b.order)
    return onlyWeekGrid ? all.filter((s) => s.has_week_grid) : all
  }, [sheetsQ.data, onlyWeekGrid])

  const [stored, setStored] = usePersistentState<string>(storageKey, '')
  // Fall back to the first sheet when nothing is stored, or when the stored
  // sheet has since been deleted or renamed out of this list.
  const sheetId = sheets.some((s) => String(s.id) === stored)
    ? stored
    : sheets[0]?.id

  return {
    sheets,
    sheetId,
    setSheetId: setStored,
    loading: sheetsQ.isLoading,
  }
}
