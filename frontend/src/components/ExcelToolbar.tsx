import { useRef, useState } from 'react'
import * as api from '@/api/client'
import { Button } from '@/components/ui/Button'
import { ImportRowsWizard } from '@/components/import/ImportRowsWizard'

/** Export-to-Excel link + import-from-Excel picker for a sheet.
 *  Picking a file opens the 取り込みウィザード — ワークシート／見出し行／ID列／列の
 *  対応とプレビューを確認してから upsert する（要望: 確認しながら取り込みたい）。 */
export function ExcelToolbar({ sheetId }: { sheetId: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)

  return (
    <div className="flex items-center gap-2">
      <a href={api.exportXlsxUrl(sheetId)} download>
        <Button size="sm" variant="outline">
          Excel出力
        </Button>
      </a>
      <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
        Excel取込
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) setFile(f)
        }}
      />
      {file && (
        <ImportRowsWizard
          sheetId={sheetId}
          file={file}
          onClose={() => {
            setFile(null)
            if (inputRef.current) inputRef.current.value = ''
          }}
        />
      )}
    </div>
  )
}
