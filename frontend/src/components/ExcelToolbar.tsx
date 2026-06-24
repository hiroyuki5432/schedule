import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { ApiError } from '@/lib/http'

/** Export-to-Excel link + import-from-Excel picker for a sheet.
 *  Import upserts rows by ID; on success it refreshes the sheet's data. */
export function ExcelToolbar({ sheetId }: { sheetId: string }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function onFile(file: File) {
    setBusy(true)
    try {
      const r = await api.importXlsx(sheetId, file)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
        qc.invalidateQueries({ queryKey: ['columns', sheetId] }),
        qc.invalidateQueries({ queryKey: ['effort', sheetId] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones', sheetId] }),
        qc.invalidateQueries({ queryKey: ['snapshot', sheetId] }),
      ])
      toast.show(`取り込み完了：新規 ${r.created} 件 / 更新 ${r.updated} 件`, 'success')
    } catch (e) {
      toast.show(
        e instanceof ApiError ? e.message : 'Excelの取り込みに失敗しました。',
        'error',
      )
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-2">
      <a href={api.exportXlsxUrl(sheetId)} download>
        <Button size="sm" variant="outline">
          Excel出力
        </Button>
      </a>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '取込中…' : 'Excel取込'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onFile(f)
        }}
      />
    </div>
  )
}
