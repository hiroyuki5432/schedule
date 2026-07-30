// 日報（みんなの入力一覧）の Excel 取り込みウィザード。取り込む前に
//   1. どのワークシート／何行目が見出し
//   2. 日付・ユーザー・タスクID・分類・メモ・時間 がそれぞれどの列か
//   3. 追加/スキップ/重複の件数と、スキップ理由の一覧
// を確認する。件数はサーバ側で本番と同じ処理を空実行して出しているので、
// プレビューの数字と実際の取り込み結果は一致する。
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import { Select } from '@/components/ui/Select'
import { WizardShell, colLetter } from '@/components/import/WizardShell'
import { SourceStep } from '@/components/import/SourceStep'
import { toast } from '@/lib/toast'

interface Props {
  file: File
  onClose: () => void
}

const STEPS = ['シートと見出し行', '列の対応', 'プレビュー']

export function ImportWorklogWizard({ file, onClose }: Props) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [sheetName, setSheetName] = useState('')
  const [headerRow, setHeaderRow] = useState(0)
  /** field key → Excel column index (-1 = 使わない). Seeded from the auto-match. */
  const [mapping, setMapping] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  const fileKey = `${file.name}:${file.size}:${file.lastModified}`

  const insp = useQuery({
    queryKey: ['worklog-inspect', fileKey, sheetName, headerRow],
    queryFn: () => api.inspectWorklogXlsx(file, { sheetName, headerRow }),
    staleTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    if (!insp.data) return
    const next: Record<string, number> = {}
    insp.data.fields.forEach((f) => (next[f.key] = f.index))
    setMapping(next)
  }, [insp.data])

  // Dry run with the user's own mapping — the numbers shown are the real outcome.
  const check = useQuery({
    queryKey: ['worklog-check', fileKey, sheetName, headerRow, JSON.stringify(mapping)],
    queryFn: () => api.inspectWorklogXlsx(file, { sheetName, headerRow, mapping }),
    enabled: step === 2 && Object.keys(mapping).length > 0,
    staleTime: Infinity,
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await api.importWorklogXlsx(file, {
        sheetName: insp.data?.sheet_name,
        headerRow: insp.data?.header_row,
        mapping,
      })
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['all-worklog'] }),
        qc.invalidateQueries({ queryKey: ['worklogs'] }),
        qc.invalidateQueries({ queryKey: ['effort'] }),
      ])
      const parts = [`追加 ${r.created} 件`]
      if (r.duplicates) parts.push(`重複スキップ ${r.duplicates} 件`)
      if (r.skipped) parts.push(`無効スキップ ${r.skipped} 件`)
      toast.show(`取り込み完了：${parts.join(' / ')}`, 'success')
      return r
    },
    onSuccess: () => onClose(),
    onError: (e) => setError(e instanceof ApiError ? e.message : '取り込みに失敗しました。'),
  })

  const data = insp.data
  const src = check.data ?? data
  const headerCells = useMemo(
    () => data?.headers ?? [],
    [data],
  )
  const missingRequired = (data?.fields ?? []).filter(
    (f) => f.required && (mapping[f.key] ?? -1) < 0,
  )
  const dataPreview = (data?.preview ?? []).filter((r) => r.row > (data?.header_row ?? 0))

  return (
    <WizardShell
      title="日報のExcel取込"
      steps={STEPS}
      step={step}
      onStep={setStep}
      loading={insp.isPending}
      error={insp.isError ? insp.error : undefined}
      status={data && `${file.name} ／ データ ${data.total_rows} 行`}
      notice={
        error ??
        (step > 0 && missingRequired.length
          ? `${missingRequired.map((f) => f.label).join('・')} の列を選んでください。`
          : null)
      }
      canNext={!!data && (step === 0 || missingRequired.length === 0)}
      runLabel="取り込む"
      running={mutation.isPending}
      canRun={!!data && missingRequired.length === 0 && (src?.created ?? 0) > 0}
      onRun={() => {
        setError(null)
        mutation.mutate()
      }}
      onBack={onClose}
      onClose={onClose}
    >
      {data && step === 0 && (
        <SourceStep
          data={data}
          sheetName={sheetName}
          onSheet={(v) => {
            setSheetName(v)
            setHeaderRow(0)
          }}
          onHeaderRow={setHeaderRow}
          note="日報は毎行が新規追加です（同じ内容の行は重複として自動でスキップされます）。"
        />
      )}

      {data && step === 1 && (
        <div>
          <div className="mb-2 text-[12px] text-[var(--ink2)]">
            それぞれの項目をExcelのどの列から読むか選んでください。見出し名が一致する列は自動で選ばれています。
          </div>
          <div className="max-h-[380px] overflow-auto rounded-[10px] border border-[var(--line)]">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
                <tr>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">項目</th>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">Excelの列</th>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">値の例</th>
                </tr>
              </thead>
              <tbody>
                {data.fields.map((f) => {
                  const idx = mapping[f.key] ?? -1
                  const samples =
                    idx === f.index ? f.samples : dataPreview.slice(0, 4).map((r) => r.cells[idx] ?? '')
                  return (
                    <tr key={f.key}>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                        {f.label}
                        {f.required && <span className="ml-1 text-[#A8442B]">*</span>}
                      </td>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                        <Select
                          value={String(idx)}
                          className="h-7 px-2 py-0 text-[11.5px]"
                          onChange={(e) =>
                            setMapping((m) => ({ ...m, [f.key]: Number(e.target.value) }))
                          }
                        >
                          <option value="-1">（使わない）</option>
                          {headerCells.map((h, i) => (
                            <option key={i} value={i}>
                              {colLetter(i)}: {h || '（見出しなし）'}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top text-[var(--ink2)]">
                        {samples.filter(Boolean).join(' / ') || '（空）'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
            * は必須。日付が空・読めない行はその日の日付で取り込みます。ユーザーは名前、タスクはIDで照合します。
          </div>
        </div>
      )}

      {data && step === 2 && src && (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px] text-[var(--ink2)]">
            <span className="rounded-[9px] bg-[#F2F6F3] px-2.5 py-1 text-[var(--green-d)]">
              追加 {src.created} 件
            </span>
            <span className="rounded-[9px] bg-[#EEF2F5] px-2.5 py-1">重複スキップ {src.duplicates} 件</span>
            <span className="rounded-[9px] bg-[#FBF3EE] px-2.5 py-1 text-[#A8442B]">
              取り込めない {src.skipped} 件
            </span>
            {check.isFetching && <span className="text-[var(--ink3)]">確認しています…</span>}
          </div>

          <div className="max-h-[240px] overflow-auto rounded-[10px] border border-[var(--line)]">
            <table className="w-max min-w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
                <tr>
                  {data.fields.map((f) => (
                    <th key={f.key} className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataPreview.slice(0, 8).map((r) => (
                  <tr key={r.row}>
                    {data.fields.map((f) => {
                      const idx = mapping[f.key] ?? -1
                      return (
                        <td
                          key={f.key}
                          className="max-w-[160px] truncate border-b border-[var(--line)] px-2 py-1"
                        >
                          {idx < 0 ? '' : (r.cells[idx] ?? '')}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
            先頭 {Math.min(8, dataPreview.length)} 行のプレビューです（データは {src.total_rows} 行）。
          </div>

          {src.issues.length > 0 && (
            <ul className="mt-3 max-h-[160px] space-y-1 overflow-auto rounded-[10px] bg-[#FBF3EE] px-3 py-2 text-[11.5px] text-[#A8442B]">
              {src.issues.map((i) => (
                <li key={`${i.row}-${i.reason}`}>
                  ・{i.row} 行目：{i.reason}
                </li>
              ))}
            </ul>
          )}
          {src.issues.length === 0 && (
            <div className="mt-3 text-[11.5px] text-[var(--green-d)]">
              そのまま取り込める内容です。
            </div>
          )}
        </div>
      )}
    </WizardShell>
  )
}
