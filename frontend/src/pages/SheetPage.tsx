// Renders the right view for a sheet: the schedule gantt when has_week_grid,
// otherwise the editable TableSheetView. Sheet id comes from the route param.
import { useParams } from 'react-router-dom'
import { useSheets } from '@/hooks/useSheets'
import { SchedulePage } from '@/pages/SchedulePage'
import { TableSheetView } from '@/pages/TableSheetView'

export function SheetPage() {
  const { sheetId } = useParams<{ sheetId: string }>()
  const sheetsQ = useSheets()

  if (sheetsQ.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--ink3)]">
        読み込み中…
      </div>
    )
  }

  const sheet = sheetsQ.data?.find((s) => String(s.id) === String(sheetId))
  if (!sheetId || !sheet) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--ink3)]">
        シートが見つかりません。
      </div>
    )
  }

  return sheet.has_week_grid ? (
    <SchedulePage sheetId={sheetId} sheetName={sheet.name} />
  ) : (
    <TableSheetView sheetId={sheetId} sheetName={sheet.name} />
  )
}
