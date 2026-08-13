// 一括置換（要望: 列のみやシートの一括置換ができるといい）。
//
// Excel の「すべて置換」に当たるもの。取り込んだ表記ゆれ（「(株)」→「株式会社」、
// 旧部署名、全角の混入…）を直すのに、いままではセルを1つずつ開くしかなかった。
//
// この画面の要は **必ず先に見せる** こと。置換は取り消せないうえ、部分一致は思ったより
// 広く当たる（「東京」で「東京海上」まで変わる）。なので「置換する」は、いまの条件で
// 確認した直後にしか押せない — 条件を1文字でも変えたら、もう一度確認しなおしになる。
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { isComputed } from '@/lib/computed'
import { toast } from '@/lib/toast'
import type { Column } from '@/types/api'

/** ID(key_value) を指す擬似的な列キー（サーバと同じ）。 */
const ID_SCOPE = '__id__'
/** シート全体。 */
const ALL_SCOPE = ''

export function ReplaceDialog({
  sheetId,
  columns,
  initialColumnId,
  onClose,
}: {
  sheetId: string
  columns: Column[]
  /** 最初に選ぶ範囲。省略＝シート全体、`'__id__'`＝ID列。 */
  initialColumnId?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const editable = useMemo(() => columns.filter((c) => !isComputed(c)), [columns])

  const [scope, setScope] = useState<string>(initialColumnId ?? ALL_SCOPE)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [wholeCell, setWholeCell] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [includeKey, setIncludeKey] = useState(false)
  const [includeOptions, setIncludeOptions] = useState(true)
  const [preview, setPreview] = useState<api.ReplaceResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const body = (dryRun: boolean): api.ReplaceInput => ({
    column_id: scope || null,
    find,
    replace,
    whole_cell: wholeCell,
    case_sensitive: caseSensitive,
    include_key: includeKey,
    include_options: includeOptions,
    dry_run: dryRun,
  })

  // 確認したときの条件。1つでも変わったら結果は当てにならないので出し直す。
  const signature = JSON.stringify(body(true))
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const fresh = checkedAt === signature && preview !== null

  const check = useMutation({
    mutationFn: () => api.replaceValues(sheetId, body(true)),
    onSuccess: (r) => {
      setPreview(r)
      setCheckedAt(signature)
      setError(null)
    },
    onError: (e) => {
      setPreview(null)
      setError(e instanceof ApiError ? e.message : '確認できませんでした。')
    },
  })

  const apply = useMutation({
    mutationFn: () => api.replaceValues(sheetId, body(false)),
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
        qc.invalidateQueries({ queryKey: ['columns', sheetId] }),
      ])
      toast.show(
        `置換しました：${r.cells} セル（${r.rows} 行）` +
          (r.options ? ` ／ 選択肢 ${r.options} 件` : ''),
        'success',
      )
      onClose()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : '置換できませんでした。'),
  })

  const scopeLabel =
    scope === ALL_SCOPE
      ? 'このシートのすべての列'
      : scope === ID_SCOPE
        ? 'ID（行の識別子）'
        : (editable.find((c) => String(c.id) === scope)?.name ?? '—')

  return (
    <Modal title="値の一括置換" onClose={onClose} widthClass="w-[640px] max-w-[95vw]">
      <div className="flex flex-col gap-3">
        <label className="text-[12px] text-[var(--ink2)]">
          置換する範囲
          <Select
            className="mt-1 w-full"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value)
              setPreview(null)
            }}
          >
            <option value={ALL_SCOPE}>このシートのすべての列</option>
            <option value={ID_SCOPE}>ID（行の識別子）だけ</option>
            {editable.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </Select>
          <span className="mt-1 block text-[11px] text-[var(--ink3)]">
            参照(LOOKUP)・数式の列は自動計算なので置換できません（一覧に出ません）。
          </span>
        </label>

        <div className="flex gap-2">
          <label className="flex-1 text-[12px] text-[var(--ink2)]">
            検索する文字列
            <Input
              className="mt-1 w-full"
              value={find}
              autoFocus
              onChange={(e) => setFind(e.target.value)}
            />
          </label>
          <label className="flex-1 text-[12px] text-[var(--ink2)]">
            置換後の文字列<span className="text-[var(--ink3)]">（空＝削除）</span>
            <Input
              className="mt-1 w-full"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-[var(--ink2)]">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[var(--green)]"
              checked={wholeCell}
              onChange={(e) => setWholeCell(e.target.checked)}
            />
            セル全体が一致するときだけ
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[var(--green)]"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            大文字・小文字を区別する
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-[var(--green)]"
              checked={includeOptions}
              onChange={(e) => setIncludeOptions(e.target.checked)}
            />
            プルダウンの選択肢も置換する
          </label>
          {scope === ALL_SCOPE && (
            <label className="flex items-center gap-1.5" title="IDを変えると、参照(LOOKUP)や先行タスクの当たり先も変わります">
              <input
                type="checkbox"
                className="accent-[var(--green)]"
                checked={includeKey}
                onChange={(e) => setIncludeKey(e.target.checked)}
              />
              ID（行の識別子）も置換する
            </label>
          )}
        </div>

        {error && <div className="text-[12px] text-[#A8442B]">{error}</div>}

        {fresh && preview && (
          <div className="rounded-[10px] border border-[var(--line)]">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-[12px]">
              {preview.cells === 0 ? (
                <span className="text-[var(--ink2)]">
                  当てはまるものはありませんでした（{scopeLabel}）。
                </span>
              ) : (
                <>
                  <span className="rounded-[9px] bg-[#F2F6F3] px-2.5 py-1 text-[var(--green-d)]">
                    {preview.cells} セル / {preview.rows} 行
                  </span>
                  {preview.options > 0 && (
                    <span className="rounded-[9px] bg-[#EEF2F5] px-2.5 py-1">
                      選択肢 {preview.options} 件
                    </span>
                  )}
                  <span className="text-[var(--ink3)]">{scopeLabel}</span>
                </>
              )}
            </div>
            {preview.samples.length > 0 && (
              <div className="max-h-[220px] overflow-auto">
                <table className="w-full border-collapse text-[11.5px]">
                  <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
                    <tr>
                      <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">ID</th>
                      <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">列</th>
                      <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">いま</th>
                      <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">置換後</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.samples.map((s, i) => (
                      <tr key={i}>
                        <td className="border-b border-[var(--line)] px-2 py-1 text-[var(--ink3)]">
                          {s.row_key}
                        </td>
                        <td className="border-b border-[var(--line)] px-2 py-1">
                          {s.column_name}
                        </td>
                        <td className="max-w-[180px] truncate border-b border-[var(--line)] px-2 py-1 text-[var(--ink3)] line-through">
                          {s.before}
                        </td>
                        <td className="max-w-[180px] truncate border-b border-[var(--line)] px-2 py-1 text-[var(--green-d)]">
                          {s.after}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.cells > preview.samples.length && (
                  <div className="px-3 py-1.5 text-[11px] text-[var(--ink3)]">
                    ほか {preview.cells - preview.samples.length} セル（例は先頭
                    {preview.samples.length} 件）
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-[var(--line2)] pt-3">
          <span className="mr-auto text-[11.5px] text-[var(--ink3)]">
            {fresh
              ? '置換は取り消せません。変更履歴には残ります。'
              : '先に「確認する」を押すと、何件がどう変わるか出ます。'}
          </span>
          <Button size="sm" variant="outline" onClick={onClose}>
            閉じる
          </Button>
          <Button
            size="sm"
            variant={fresh ? 'outline' : undefined}
            disabled={!find || check.isPending || apply.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? '確認中…' : '確認する'}
          </Button>
          <Button
            size="sm"
            disabled={!fresh || !preview?.cells || apply.isPending}
            title={fresh ? undefined : '先に「確認する」を押してください'}
            onClick={() => {
              if (
                window.confirm(
                  `${preview?.cells} セル（${preview?.rows} 行）を置換します。よろしいですか？`,
                )
              )
                apply.mutate()
            }}
          >
            {apply.isPending ? '置換中…' : '置換する'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
