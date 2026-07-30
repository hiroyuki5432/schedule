// "シート追加" dialog: name + type radio, plus an optional .xlsx to build the
// sheet from. With a file, 「次へ」 hands over to the 取り込みウィザード
// (ImportSheetWizard) so the worksheet / 見出し行 / 列 can be confirmed before
// anything is written. Without one it just creates the sheet and navigates to it.
import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ImportSheetWizard } from '@/components/ImportSheetWizard'
import { cn } from '@/lib/format'

interface Props {
  onClose: () => void
}

export function AddSheetDialog({ onClose }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [hasWeekGrid, setHasWeekGrid] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [wizard, setWizard] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const s = await api.createSheet({ name: name.trim(), has_week_grid: hasWeekGrid })
      return { id: String(s.id) }
    },
    onSuccess: async (sheet) => {
      await qc.invalidateQueries({ queryKey: ['sheets'] })
      onClose()
      navigate(`/sheets/${sheet.id}`)
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : 'シートの作成に失敗しました。')
    },
  })

  // With a file the name is optional (the worksheet name is used instead).
  const canSubmit = (!!file || name.trim() !== '') && !mutation.isPending

  if (wizard && file) {
    return (
      <ImportSheetWizard
        file={file}
        defaultName={name.trim()}
        hasWeekGrid={hasWeekGrid}
        onBack={() => setWizard(false)}
        onClose={onClose}
      />
    )
  }

  return (
    <Modal title="シートを追加" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          if (!canSubmit) return
          if (file) setWizard(true)
          else mutation.mutate()
        }}
      >
        <label className="mb-1.5 block text-[12px] text-[var(--ink2)]">
          シート名{file && <span className="text-[var(--ink3)]">（省略可）</span>}
        </label>
        <Input
          autoFocus
          placeholder={file ? `例: ${file.name.replace(/\.xlsx$/i, '')}` : '例: 開発スケジュール'}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="mb-1.5 mt-4 text-[12px] text-[var(--ink2)]">種類</div>
        <div className="flex flex-col gap-2">
          <TypeRadio
            checked={hasWeekGrid}
            onSelect={() => setHasWeekGrid(true)}
            title="スケジュール（週次グリッド）"
            desc="ガントの週次工数を入力できるシート"
          />
          <TypeRadio
            checked={!hasWeekGrid}
            onSelect={() => setHasWeekGrid(false)}
            title="テーブル（集計・参照）"
            desc="属性列のみの一覧／参照用シート"
          />
        </div>

        <div className="mb-1.5 mt-4 text-[12px] text-[var(--ink2)]">
          Excelから取り込む<span className="text-[var(--ink3)]">（任意）</span>
        </div>
        {file ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-[var(--green)] bg-[#F2F6F3] px-3 py-2.5">
            <span className="flex-1 truncate text-[12.5px] text-[var(--ink)]">{file.name}</span>
            <button
              type="button"
              onClick={() => {
                setFile(null)
                if (fileRef.current) fileRef.current.value = ''
              }}
              className="text-[11.5px] text-[var(--ink3)] hover:text-[var(--ink)]"
            >
              取り消す
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-[10px] border border-dashed border-[var(--line)] px-3 py-2.5 text-left text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            .xlsx を選ぶ
            <span className="block text-[11.5px] text-[var(--ink3)]">
              次の画面で、どのワークシート・何行目が見出し・どの列を取り込むかを確認できます。
            </span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setFile(f)
          }}
        />

        {error && <div className="mt-3 text-[12px] text-[#A8442B]">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {mutation.isPending ? '作成中…' : file ? '次へ（内容を確認）' : '作成'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function TypeRadio({
  checked,
  onSelect,
  title,
  desc,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  desc: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
        checked
          ? 'border-[var(--green)] bg-[#F2F6F3]'
          : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--line2)]',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-[var(--green)]' : 'border-[var(--line)]',
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-[var(--green)]" />}
      </span>
      <span>
        <span className="block text-[12.5px] font-medium text-[var(--ink)]">{title}</span>
        <span className="block text-[11.5px] text-[var(--ink3)]">{desc}</span>
      </span>
    </button>
  )
}
