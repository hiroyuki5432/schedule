// "シート追加" dialog: name + type radio. Creates the sheet, invalidates the
// sheet list, and navigates to the new sheet.
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/format'

interface Props {
  onClose: () => void
}

export function AddSheetDialog({ onClose }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [hasWeekGrid, setHasWeekGrid] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.createSheet({ name: name.trim(), has_week_grid: hasWeekGrid }),
    onSuccess: async (sheet) => {
      await qc.invalidateQueries({ queryKey: ['sheets'] })
      onClose()
      navigate(`/sheets/${sheet.id}`)
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : 'シートの作成に失敗しました。')
    },
  })

  return (
    <Modal title="シートを追加" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          if (name.trim()) mutation.mutate()
        }}
      >
        <label className="mb-1.5 block text-[12px] text-[var(--ink2)]">シート名</label>
        <Input
          autoFocus
          placeholder="例: 開発スケジュール"
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

        {error && <div className="mt-3 text-[12px] text-[#A8442B]">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            キャンセル
          </Button>
          <Button type="submit" size="sm" disabled={!name.trim() || mutation.isPending}>
            作成
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
