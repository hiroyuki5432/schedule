// 列の設定を「一覧の上で」開くモーダル。
//
// 要望: 設定とどう見えるかがいちいち戻らないといけない。
// 選択肢を1つ足すのに シート設定 → 列 → 選ぶ → 直す → 保存 → 一覧へ戻る、と往復して
// いた。結果を見ながら直したいものほど往復の回数が増えるので、見出しの ⋮ から直接
// ここを開けるようにした。中身はシート設定と同じ部品なので、直し方は1つだけ。
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { DropdownOptionsEditor } from '@/components/settings/DropdownOptionsEditor'
import { StatusRuleBuilder } from '@/components/settings/StatusRuleBuilder'
import { LookupConfigEditor } from '@/components/settings/LookupConfigEditor'
import { FormulaConfigEditor } from '@/components/settings/FormulaConfigEditor'
import { ReplaceDialog } from '@/components/settings/ReplaceDialog'
import { isComputed } from '@/lib/computed'
import { useSheetDetail } from '@/hooks/useSheets'
import { toast } from '@/lib/toast'
import type { Column, ColumnType } from '@/types/api'

const TYPE_LABEL: Record<ColumnType, string> = {
  text: '自由入力',
  number: '数値',
  date: '日付',
  dropdown: 'プルダウン',
  status: '条件付きステータス',
  member: 'メンバー',
  lookup: '参照(LOOKUP)',
  formula: '数式',
}

export function ColumnSettingsModal({
  column,
  columns,
  sheetId,
  onClose,
}: {
  column: Column
  columns: Column[]
  sheetId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  // 行は自分で取りにいく。呼び出し元（一覧）が持っているのは絞り込み後の行なので、
  // それを使うと「選択肢に無い値」の件数が実際より少なく出てしまう。キャッシュは
  // 一覧と共通なので、普通は通信は起きない。
  const detailQ = useSheetDetail(sheetId)
  const rows = detailQ.data?.rows ?? []
  const [name, setName] = useState(column.name)
  const [type, setType] = useState<ColumnType>(column.type)
  const [replacing, setReplacing] = useState(false)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['columns', sheetId] })
    void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
  }

  const meta = useMutation({
    mutationFn: () => api.updateColumn(column.id, { name: name.trim(), type }),
    onSuccess: () => {
      refresh()
      toast.show('保存しました', 'success', 2000)
    },
    onError: () => toast.show('保存に失敗しました', 'error'),
  })

  const dirty = name.trim() !== column.name || type !== column.type

  return (
    <Modal
      title={`${column.name} — 列の設定`}
      onClose={onClose}
      widthClass="w-[560px]"
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <label className="flex-1 text-[12px] text-[var(--ink2)]">
            名前
            <Input
              className="mt-1 w-full"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="w-[190px] text-[12px] text-[var(--ink2)]">
            型
            <Select
              className="mt-1 w-full"
              value={type}
              onChange={(e) => setType(e.target.value as ColumnType)}
            >
              {(Object.keys(TYPE_LABEL) as ColumnType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || meta.isPending} onClick={() => meta.mutate()}>
            {meta.isPending ? '保存中…' : '名前・型を保存'}
          </Button>
        </div>

        {/* 型ごとの詳細。型を変えた直後は、まず上の「名前・型を保存」を押してもらう —
            保存前に選択肢を編集しても、その型の列がまだ存在しないので。 */}
        {column.type === 'dropdown' && (
          <DropdownOptionsEditor column={column} rows={rows} onDone={refresh} />
        )}
        {column.type === 'status' && (
          <StatusRuleBuilder column={column} columns={columns} onDone={refresh} />
        )}
        {column.type === 'lookup' && (
          <LookupConfigEditor column={column} sheetId={sheetId} onDone={refresh} />
        )}
        {column.type === 'formula' && (
          <FormulaConfigEditor column={column} sheetId={sheetId} onDone={refresh} />
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[var(--line2)] pt-3">
          {/* 表記ゆれを直すのに、セルを1つずつ開かなくて済むように（要望: 列のみの
              一括置換）。ダイアログの中でシート全体にも切り替えられる。 */}
          {!isComputed(column) && (
            <Button
              size="sm"
              variant="ghost"
              className="mr-auto"
              onClick={() => setReplacing(true)}
            >
              ⇄ この列の値を一括置換…
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>

      {replacing && (
        <ReplaceDialog
          sheetId={sheetId}
          columns={columns}
          initialColumnId={String(column.id)}
          onClose={() => setReplacing(false)}
        />
      )}
    </Modal>
  )
}
