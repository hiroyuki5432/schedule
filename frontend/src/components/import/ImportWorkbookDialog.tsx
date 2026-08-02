// Excel一括取り込み — ブックのワークシートをまとめて取り込む画面。
//
// 要望: シートが多いブックを毎回ウィザードで設定し直すのが辛い／データ取り込みは
// 何度もやり直す。ここでは .xlsx を1つ選ぶと、ブック内の全ワークシートが
// 「どのシートに入るか（前回の設定＝プリセット）／新規何行・更新何行／警告」の
// 一覧になる。行ごとに取り込み先を変えたり除外したりでき、最後に一括実行する。
//
// 実行は 1トランザクション。途中で失敗したら全部取り消されるので、半分だけ入った
// 状態にはならない。成功した設定は保存し直されるため、2回目以降は
// 「ファイルを選ぶ → 取り込む」で済む。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api/client'
import type { WorkbookPlanItem, WorkbookSheetPlan } from '@/api/client'
import { ApiError } from '@/lib/http'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/format'

interface Props {
  onClose: () => void
}

/** Per-worksheet edits layered on top of what the server proposed. */
type Overrides = Record<string, WorkbookPlanItem>

const NEW_SHEET = 'new'
const SKIP = 'skip'

export function ImportWorkbookDialog({ onClose }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [overrides, setOverrides] = useState<Overrides>({})
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<
    { worksheet: string; sheet_id: number; name: string; created: number; updated: number }[] | null
  >(null)

  const sheetsQ = useQuery({ queryKey: ['sheets'], queryFn: api.getSheets, staleTime: 60_000 })

  // Re-analysing means re-parsing the whole workbook, so the plan settles for a
  // moment before it is sent — otherwise every keystroke in 見出し行 re-uploads.
  const planItems = useMemo(() => Object.values(overrides), [overrides])
  const [settledPlan, setSettledPlan] = useState<WorkbookPlanItem[]>([])
  useEffect(() => {
    const t = setTimeout(() => setSettledPlan(planItems), 350)
    return () => clearTimeout(t)
  }, [planItems])
  // True while an edit has not been re-analysed yet — running now would use the
  // numbers from before the change.
  const stale = JSON.stringify(planItems) !== JSON.stringify(settledPlan)

  const fileKey = file ? `${file.name}:${file.size}:${file.lastModified}` : ''
  const insp = useQuery({
    queryKey: ['workbook-inspect', fileKey, JSON.stringify(settledPlan)],
    queryFn: () => api.inspectWorkbook(file!, settledPlan),
    enabled: !!file,
    staleTime: Infinity,
    retry: false,
  })

  const rows = insp.data?.worksheets ?? []
  const active = rows.filter((r) => r.action !== SKIP && !r.error)
  const totals = active.reduce(
    (a, r) => ({
      created: a.created + r.new_rows,
      updated: a.updated + r.updated_rows,
      invalid: a.invalid + r.invalid,
    }),
    { created: 0, updated: 0, invalid: 0 },
  )

  const patch = (worksheet: string, p: Partial<WorkbookPlanItem>) =>
    setOverrides((prev) => ({ ...prev, [worksheet]: { ...prev[worksheet], worksheet, ...p } }))

  const run = useMutation({
    mutationFn: async () => {
      // Send the full resolved plan, not just the edits — what the user confirmed
      // on screen is exactly what runs, even for rows they never touched.
      const plan: WorkbookPlanItem[] = rows.map((r) => ({
        worksheet: r.worksheet,
        action: r.error ? SKIP : r.action,
        target_sheet_id: r.target_sheet_id,
        target_sheet_name: r.target_sheet_name,
        has_week_grid: r.has_week_grid,
        header_row: r.header_row,
        last_row: r.last_row,
        id_column: r.id_column,
        // Omit when empty — an empty list would mean "take no columns at all",
        // where leaving it out means "use the saved / by-name defaults".
        ...(r.mapping?.length
          ? { columns: r.mapping.map((m) => ({ index: m.index, name: m.name, type: '' as const })) }
          : {}),
      }))
      return api.importWorkbook(file!, plan)
    },
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheets'] }),
        qc.invalidateQueries({ queryKey: ['import-presets'] }),
      ])
      // Every touched sheet's cached data is now stale.
      r.results.forEach((x) => {
        const id = String(x.sheet_id)
        ;['sheet', 'columns', 'effort', 'sheet-milestones', 'snapshot'].forEach((k) =>
          qc.invalidateQueries({ queryKey: [k, id] }),
        )
      })
      toast.show(
        `一括取り込み完了：${r.results.length} シート（新規 ${r.created} / 更新 ${r.updated}）`,
        'success',
      )
      setDone(r.results)
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : '一括取り込みに失敗しました。'),
  })

  if (done) {
    return (
      <Modal title="一括取り込みが完了しました" onClose={onClose} widthClass="w-[560px] max-w-[95vw]">
        <ul className="max-h-[50vh] space-y-1 overflow-auto text-[12px]">
          {done.map((r) => (
            <li
              key={r.worksheet}
              className="flex items-center gap-2 rounded-[9px] bg-[var(--line2)] px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate">
                {r.worksheet} <span className="text-[var(--ink3)]">→</span> {r.name}
              </span>
              <span className="text-[var(--ink2)] tabular-nums">
                新規 {r.created} / 更新 {r.updated}
              </span>
              <button
                type="button"
                className="text-[11.5px] text-[var(--green-d)] underline"
                onClick={() => {
                  onClose()
                  navigate(`/sheets/${r.sheet_id}`)
                }}
              >
                開く
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 text-[11.5px] text-[var(--ink3)]">
          この設定は保存されました。次回は同じファイルを選んで「一括で取り込む」だけで更新できます。
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Excel一括取り込み" onClose={onClose} widthClass="w-[980px] max-w-[96vw]">
      {!file ? (
        <div>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="w-full rounded-[10px] border border-dashed border-[var(--line)] px-4 py-6 text-center text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            .xlsx を選ぶ
            <span className="mt-1 block text-[11.5px] text-[var(--ink3)]">
              ブック内のワークシートをまとめて取り込みます。前に取り込んだことのある
              ワークシートは、そのときの設定が自動で使われます。
            </span>
          </button>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>
              キャンセル
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ink2)]">
            <span className="truncate font-medium text-[var(--ink)]">{file.name}</span>
            <span className="text-[var(--ink3)]">／ワークシート {rows.length} 枚</span>
            <button
              type="button"
              className="text-[var(--ink3)] underline hover:text-[var(--ink)]"
              onClick={() => {
                setFile(null)
                setOverrides({})
                setError(null)
                if (fileRef.current) fileRef.current.value = ''
              }}
            >
              別のファイルにする
            </button>
            {(insp.isFetching || stale) && (
              <span className="ml-auto text-[var(--ink3)]">確認中…</span>
            )}
          </div>

          {insp.isError && (
            <div className="py-8 text-center text-[12px] text-[#A8442B]">
              {insp.error instanceof ApiError
                ? insp.error.message
                : 'Excelファイルを読み込めませんでした。'}
            </div>
          )}

          {insp.isPending && !insp.isError && (
            <div className="py-8 text-center text-[12px] text-[var(--ink3)]">読み込み中…</div>
          )}

          {!!rows.length && (
            <div className="max-h-[46vh] overflow-auto rounded-[10px] border border-[var(--line)]">
              <table className="w-full border-collapse text-[11.5px]">
                <thead className="sticky top-0 z-10 bg-[var(--line2)] text-[var(--ink2)]">
                  <tr>
                    <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                      ワークシート
                    </th>
                    <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                      取り込み先
                    </th>
                    <th className="w-[76px] border-b border-[var(--line)] px-2 py-1.5 text-left">
                      見出し行
                    </th>
                    <th className="w-[86px] border-b border-[var(--line)] px-2 py-1.5 text-left">
                      最終行
                    </th>
                    <th className="w-[130px] border-b border-[var(--line)] px-2 py-1.5 text-left">
                      取り込み内容
                    </th>
                    <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">確認事項</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <PlanRow
                      key={r.worksheet}
                      row={r}
                      ov={overrides[r.worksheet]}
                      sheets={sheetsQ.data ?? []}
                      onPatch={(p) => patch(r.worksheet, p)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && <div className="mt-3 text-[12px] text-[#A8442B]">{error}</div>}

          <div className="mt-4 flex items-center justify-between gap-2">
            <div className="text-[11.5px] text-[var(--ink2)]">
              {active.length === 0 ? (
                <span className="text-[var(--ink3)]">
                  取り込むワークシートを選んでください（既定は「取り込まない」です）。
                </span>
              ) : (
                <>
                  <span className="rounded-[9px] bg-[#F2F6F3] px-2.5 py-1 text-[var(--green-d)]">
                    {active.length} シート
                  </span>
                  <span className="ml-2">
                    新規 {totals.created} 行 / 更新 {totals.updated} 行
                  </span>
                  {totals.invalid > 0 && (
                    <span className="ml-2 text-[#A8442B]">
                      読めない値 {totals.invalid} 件（空欄になります）
                    </span>
                  )}
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={run.isPending} onClick={onClose}>
                キャンセル
              </Button>
              <Button
                size="sm"
                disabled={active.length === 0 || run.isPending || insp.isFetching || stale}
                onClick={() => {
                  setError(null)
                  run.mutate()
                }}
              >
                {run.isPending ? '取込中…' : '一括で取り込む'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) {
            setFile(f)
            setOverrides({})
            setSettledPlan([])
            setError(null)
          }
        }}
      />
    </Modal>
  )
}

function PlanRow({
  row,
  ov,
  sheets,
  onPatch,
}: {
  row: WorkbookSheetPlan
  /** The user's un-analysed edits. They win over `row` so the controls respond
   *  immediately instead of snapping back while the dry-run catches up. */
  ov: WorkbookPlanItem | undefined
  sheets: { id: string; name: string }[]
  onPatch: (p: Partial<WorkbookPlanItem>) => void
}) {
  const action = row.error ? SKIP : (ov?.action ?? row.action)
  const targetId = ov && 'target_sheet_id' in ov ? ov.target_sheet_id : row.target_sheet_id
  const headerRow = ov?.header_row ?? row.header_row
  const lastRow = ov?.last_row ?? row.last_row
  const targetName = ov?.target_sheet_name ?? row.target_sheet_name
  const skipped = action === SKIP || !!row.error
  const excluded = row.available_rows - row.total_rows
  // One control for the whole decision: a sheet id, 新規作成, or 取り込まない.
  const value =
    action === SKIP ? SKIP : action === NEW_SHEET ? NEW_SHEET : String(targetId ?? NEW_SHEET)

  return (
    <tr className={cn(skipped && 'text-[var(--ink3)]')}>
      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
        <span className={cn('block truncate', !skipped && 'text-[var(--ink)]')}>
          {row.worksheet}
        </span>
        {row.preset_id !== null && !row.error && (
          <span className="mt-0.5 inline-block rounded-[6px] bg-[#F2F6F3] px-1.5 py-0.5 text-[10.5px] text-[var(--green-d)]">
            前回の設定
          </span>
        )}
      </td>

      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
        <Select
          value={value}
          disabled={!!row.error}
          className="h-7 w-full px-2 py-0 text-[11.5px]"
          onChange={(e) => {
            const v = e.target.value
            if (v === SKIP) onPatch({ action: SKIP })
            else if (v === NEW_SHEET) onPatch({ action: NEW_SHEET, target_sheet_id: null })
            else onPatch({ action: 'existing', target_sheet_id: Number(v) })
          }}
        >
          <option value={SKIP}>（取り込まない）</option>
          <option value={NEW_SHEET}>＋ 新しいシートを作る</option>
          {sheets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {action === NEW_SHEET && !row.error && (
          <Input
            value={targetName}
            placeholder={row.worksheet}
            onChange={(e) => onPatch({ target_sheet_name: e.target.value })}
            className="mt-1 h-7 w-full px-2 py-1 text-[11.5px]"
          />
        )}
      </td>

      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
        {skipped ? (
          <span className="text-[var(--ink3)]">—</span>
        ) : (
          <Input
            type="number"
            min={1}
            value={headerRow || ''}
            onChange={(e) => onPatch({ header_row: Number(e.target.value) || 0 })}
            className="h-7 w-[58px] px-2 py-1 text-[11.5px] tabular-nums"
          />
        )}
      </td>

      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
        {skipped ? (
          <span className="text-[var(--ink3)]">—</span>
        ) : (
          <>
            <Input
              type="number"
              min={0}
              max={row.sheet_last_row}
              value={lastRow || ''}
              placeholder="最後まで"
              title="この行までを取り込む（空＝最後まで）"
              onChange={(e) => onPatch({ last_row: Number(e.target.value) || 0 })}
              className="h-7 w-[74px] px-2 py-1 text-[11.5px] tabular-nums"
            />
            {excluded > 0 && (
              <span className="block text-[10.5px] text-[#A8442B]">−{excluded} 行</span>
            )}
          </>
        )}
      </td>

      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top tabular-nums">
        {skipped ? (
          <span className="text-[var(--ink3)]">—</span>
        ) : (
          <>
            <span className="text-[var(--green-d)]">新規 {row.new_rows}</span>
            {row.updated_rows > 0 && <span className="ml-1.5">更新 {row.updated_rows}</span>}
            <span className="block text-[10.5px] text-[var(--ink3)]">{row.column_count} 列</span>
          </>
        )}
      </td>

      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
        {row.error ? (
          <span className="text-[#A8442B]">{row.error}</span>
        ) : skipped ? (
          <span className="text-[var(--ink3)]">—</span>
        ) : row.warnings.length === 0 ? (
          <span className="text-[var(--green-d)]">そのまま取り込めます</span>
        ) : (
          <ul className="space-y-0.5 text-[#A8442B]">
            {row.warnings.map((w) => (
              <li key={w} className="line-clamp-2 max-w-[280px]">
                ・{w}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  )
}
