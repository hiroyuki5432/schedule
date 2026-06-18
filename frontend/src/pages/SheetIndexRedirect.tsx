// Root route: redirect to the first sheet, or show a friendly empty state with
// a create affordance when there are no sheets.
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useSheets } from '@/hooks/useSheets'
import { Button } from '@/components/ui/Button'
import { PlusIcon } from '@/components/ui/icons'
import { AddSheetDialog } from '@/components/AddSheetDialog'

export function SheetIndexRedirect() {
  const sheetsQ = useSheets()
  const [showAdd, setShowAdd] = useState(false)

  if (sheetsQ.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--ink3)]">
        読み込み中…
      </div>
    )
  }

  const sheets = [...(sheetsQ.data ?? [])].sort((a, b) => a.order - b.order)
  if (sheets.length > 0) {
    return <Navigate to={`/sheets/${sheets[0].id}`} replace />
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div>
        <div className="text-[16px] font-semibold">シートがありません</div>
        <div className="mt-1 text-[12px] text-[var(--ink3)]">
          最初のシートを作成して工数スケジュールを始めましょう。
        </div>
      </div>
      <Button onClick={() => setShowAdd(true)}>
        <PlusIcon className="h-[15px] w-[15px]" />
        シートを作成
      </Button>
      {showAdd && <AddSheetDialog onClose={() => setShowAdd(false)} />}
    </div>
  )
}
