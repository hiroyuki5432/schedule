// 既存シートへの Excel 取り込みウィザード。いきなり upsert せず、
//   1. どのワークシート／何行目が見出し／どの列がID
//   2. Excelの各列をシートのどの列に入れるか（対応の変更・除外）
//   3. 新規/更新の件数と警告をプレビュー
// を確認してから取り込む。書き込みは最後の「取り込む」だけ。
//
// 2回目以降は前回の設定（プリセット）を自動で読み込むので、そのまま「取り込む」
// まで進めば同じ取り込みを再現できる。取り込みに成功したら設定は保存し直される。
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import type { ImportMatchMode, ImportRowsColumn } from '@/api/client'
import { ApiError } from '@/lib/http'
import { Select } from '@/components/ui/Select'
import { WizardShell, colLetter } from '@/components/import/WizardShell'
import { SourceStep } from '@/components/import/SourceStep'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/format'

interface Props {
  sheetId: string
  file: File
  onClose: () => void
}

/** One entry of the column mapping as the inspect/import endpoints take it. */
type ImportRowsColumnPick = { index: number; name: string; type: '' }

const STEPS = ['シートと見出し行', '列の対応', 'プレビュー']

const ROLE_LABEL: Record<string, string> = {
  attr: '',
  week: '週次工数',
  progress: '進捗',
  deps: '先行タスク',
  milestone: 'マイルストン',
}

const TYPE_LABEL: Record<string, string> = {
  text: '自由入力',
  number: '数値',
  date: '日付',
  dropdown: 'プルダウン',
  status: 'ステータス',
  member: '担当者',
}

export function ImportRowsWizard({ sheetId, file, onClose }: Props) {
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [sheetName, setSheetName] = useState('')
  const [headerRow, setHeaderRow] = useState(0) // 0 = 自動判定
  const [lastRow, setLastRow] = useState(0) // 0 = 最後まで
  const [tailFrom, setTailFrom] = useState(0) // 0 = 末尾から自動
  // 既定は「照合しない」＝ Excelの1行がそのまま1行になる（要望: 1列目が被るだけで
  // 1行にまとめないでほしい）。ID列は照合しないときも既定どおり先頭列のまま —
  // 照合に使わないだけで、**その値は行のIDとして残す**（要望: もともとのIDで紐付け
  // したいので消さないでほしい）。IDの無い表だけ「自動採番」を選ぶ。
  const [matchMode, setMatchMode] = useState<ImportMatchMode>('none')
  const [idColumn, setIdColumn] = useState(0)
  /** Excel column index → target (sheet column name / reserved header). '' = 除外 */
  const [mapping, setMapping] = useState<Record<number, string>>({})
  /** The saved mapping, once applied — sent to inspect so the server proposes it. */
  const [presetCols, setPresetCols] = useState<ImportRowsColumnPick[] | undefined>(undefined)
  const [applied, setApplied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fileKey = `${file.name}:${file.size}:${file.lastModified}`

  // 前回この シート に取り込んだときの設定。複数あれば直近に使ったものを採用する。
  const presetsQ = useQuery({
    queryKey: ['import-presets'],
    queryFn: api.getImportPresets,
    staleTime: 60_000,
    retry: false,
  })
  const preset = useMemo(() => {
    const mine = (presetsQ.data ?? []).filter((p) => p.target_sheet_id === Number(sheetId))
    return (
      [...mine].sort((a, b) =>
        (b.last_used_at ?? b.updated_at).localeCompare(a.last_used_at ?? a.updated_at),
      )[0] ?? null
    )
  }, [presetsQ.data, sheetId])

  const insp = useQuery({
    queryKey: [
      'xlsx-rows-inspect',
      sheetId,
      fileKey,
      sheetName,
      headerRow,
      lastRow,
      tailFrom,
      idColumn,
      matchMode,
      JSON.stringify(presetCols ?? null),
    ],
    queryFn: () =>
      api.inspectImportRowsXlsx(sheetId, file, {
        sheetName,
        headerRow,
        lastRow,
        tailFrom,
        idColumn,
        matchMode,
        columns: presetCols,
      }),
    // Wait for the presets so the first analysis is already the saved one — no
    // flash of the auto-guessed mapping before it is replaced.
    enabled: !presetsQ.isPending,
    staleTime: Infinity,
    retry: false,
  })

  // Apply the saved setting once, and only when its worksheet is actually in this
  // file — the mapping is by column POSITION, so replaying it on a different
  // worksheet would silently write values into the wrong columns.
  const [usingPreset, setUsingPreset] = useState(false)
  useEffect(() => {
    if (applied || !preset || !insp.data) return
    setApplied(true)
    if (!insp.data.worksheets.some((w) => w.name === preset.worksheet_name)) return
    setUsingPreset(true)
    setSheetName(preset.worksheet_name)
    setHeaderRow(preset.header_row)
    setLastRow(preset.last_row)
    setIdColumn(preset.id_column)
    if (preset.match_mode) setMatchMode(preset.match_mode)
    // An empty saved mapping means "never recorded" — leave it to the by-name
    // defaults rather than asking for a mapping that takes no columns.
    if (preset.mapping.length) {
      setPresetCols(preset.mapping.map((m) => ({ index: m.index, name: m.name, type: '' })))
    }
  }, [applied, preset, insp.data])

  // Re-seed the proposed mapping whenever the worksheet / 見出し行 / ID列 changes.
  useEffect(() => {
    if (!insp.data) return
    const next: Record<number, string> = {}
    insp.data.columns.forEach((c) => (next[c.index] = c.target))
    setMapping(next)
  }, [insp.data])

  const info = useMemo(() => {
    const m = new Map<number, ImportRowsColumn>()
    insp.data?.columns.forEach((c) => m.set(c.index, c))
    return m
  }, [insp.data])

  const chosen = useMemo(
    () =>
      Object.entries(mapping)
        .filter(([idx, target]) => target && Number(idx) !== idColumn)
        .map(([idx, target]) => ({ index: Number(idx), name: target, type: '' as const })),
    [mapping, idColumn],
  )

  // Re-check against the user's own mapping (invalid values / 新規・更新の件数).
  const check = useQuery({
    queryKey: [
      'xlsx-rows-check',
      sheetId,
      fileKey,
      sheetName,
      headerRow,
      lastRow,
      idColumn,
      matchMode,
      JSON.stringify(chosen),
    ],
    queryFn: () =>
      api.inspectImportRowsXlsx(sheetId, file, {
        sheetName,
        headerRow,
        lastRow,
        idColumn,
        matchMode,
        columns: chosen,
      }),
    enabled: step === 2 && chosen.length > 0,
    staleTime: Infinity,
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await api.importXlsx(sheetId, file, {
        sheetName: insp.data?.sheet_name,
        headerRow: insp.data?.header_row,
        lastRow,
        idColumn,
        matchMode,
        columns: chosen,
      })
      // Remember what just worked, so the next round (and the 一括取り込み) can
      // replay it. Best effort: the rows are already committed, and failing to
      // save a convenience setting must not be reported as a failed import.
      if (insp.data) {
        await api
          .saveImportPreset({
            worksheet_name: insp.data.sheet_name,
            workbook_name: file.name,
            target_sheet_id: Number(sheetId),
            header_row: insp.data.header_row,
            last_row: lastRow,
            id_column: idColumn,
            match_mode: matchMode,
            mapping: chosen,
          })
          .then(() => qc.invalidateQueries({ queryKey: ['import-presets'] }))
          .catch(() => {})
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
        qc.invalidateQueries({ queryKey: ['columns', sheetId] }),
        qc.invalidateQueries({ queryKey: ['effort', sheetId] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones', sheetId] }),
        qc.invalidateQueries({ queryKey: ['snapshot', sheetId] }),
      ])
      toast.show(
        r.deleted
          ? `入れ替え完了：${r.deleted} 件を削除して ${r.created} 件を取り込みました`
          : `取り込み完了：新規 ${r.created} 件 / 更新 ${r.updated} 件`,
        'success',
      )
      // プルダウン列の選択肢をどう扱ったか（増やした／多すぎるので増やさなかった）は、
      // 黙っていると「取り込んだのに選択肢に出ない」になるので必ず伝える。
      for (const note of r.notes ?? []) toast.show(note, 'info', 7000)
      return r
    },
    onSuccess: () => onClose(),
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Excelの取り込みに失敗しました。'),
  })

  const data = insp.data
  const src = check.data ?? data
  const dataPreview = (data?.preview ?? []).filter(
    (r) =>
      r.row > (data?.header_row ?? 0) && (!data?.last_row || r.row <= data.last_row),
  )

  return (
    <WizardShell
      title="Excel取込（このシートに反映）"
      steps={STEPS}
      step={step}
      onStep={setStep}
      loading={insp.isPending || presetsQ.isPending}
      error={insp.isError ? insp.error : undefined}
      status={data && `${file.name} ／ データ ${data.total_rows} 行`}
      notice={error}
      canNext={!!data}
      runLabel="取り込む"
      running={mutation.isPending}
      canRun={!!data && chosen.length > 0}
      onRun={() => {
        setError(null)
        mutation.mutate()
      }}
      onBack={onClose}
      onClose={onClose}
    >
      {usingPreset && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[10px] bg-[#F2F6F3] px-3 py-2 text-[11.5px] text-[var(--green-d)]">
          <span>
            前回の設定を読み込みました（ワークシート「{preset?.worksheet_name}」／見出し{' '}
            {preset?.header_row} 行目）。このまま進めば同じ取り込みになります。
          </span>
          <button
            type="button"
            className="ml-auto text-[var(--ink3)] underline hover:text-[var(--ink)]"
            onClick={() => {
              setUsingPreset(false)
              setPresetCols(undefined)
              setSheetName('')
              setHeaderRow(0)
              setLastRow(0)
              setTailFrom(0)
              setIdColumn(0)
              setMatchMode('none')
            }}
          >
            設定を使わず最初から
          </button>
        </div>
      )}

      {data && step === 0 && (
        <SourceStep
          data={data}
          sheetName={sheetName}
          onSheet={(v) => {
            setSheetName(v)
            setHeaderRow(0)
            setLastRow(0)
            setTailFrom(0)
            setIdColumn(0)
            setMatchMode('none')
            // The saved mapping is by column position — it means nothing on
            // another worksheet, so switching drops it.
            setPresetCols(undefined)
            setUsingPreset(false)
          }}
          onHeaderRow={setHeaderRow}
          onLastRow={setLastRow}
          onTailFrom={setTailFrom}
          idColumn={idColumn}
          onIdColumn={setIdColumn}
          matchMode={matchMode}
          onMatchMode={(m) => {
            setMatchMode(m)
            // ID列の指定はそのまま残す。照合しないときも、ID列の値は行のIDとして
            // 使う（照合に使わないだけ）。「IDで照合」に切り替えたときだけ、照合する
            // 列が無いと成立しないので先頭列を補う。
            if (m === 'id') setIdColumn((cur) => (cur < 0 ? 0 : cur))
          }}
          note={
            matchMode === 'id'
              ? 'ID列（薄い黄色）が既存のタスクと一致する行は上書き、無い行は新規追加になります。'
              : 'ID列（薄い黄色）の値がそのまま行のIDになります（空欄の行だけ自動採番）。'
          }
        />
      )}

      {data && step === 1 && (
        <div>
          <div className="mb-2 text-[12px] text-[var(--ink2)]">
            Excelの列を、このシートのどの列に入れるか選んでください。同じ名前の列は自動で対応済みです。
          </div>
          <div className="max-h-[380px] overflow-auto rounded-[10px] border border-[var(--line)]">
            <table className="w-full border-collapse text-[11.5px]">
              <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
                <tr>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">Excelの見出し</th>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">取り込み先</th>
                  <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">値の例</th>
                </tr>
              </thead>
              <tbody>
                {data.columns.map((c) => {
                  const isId = c.index === idColumn
                  const target = mapping[c.index] ?? ''
                  const cur = info.get(c.index)
                  return (
                    <tr key={c.index} className={cn(isId && 'bg-[#FBF6EC]')}>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                        <span className="text-[var(--ink3)]">{colLetter(c.index)}: </span>
                        {c.header || <span className="text-[var(--ink3)]">（見出しなし）</span>}
                        {isId && <span className="ml-1 text-[var(--ink3)]">→ ID列</span>}
                      </td>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                        {isId ? (
                          <span className="text-[var(--ink3)]">ID（行の識別子）</span>
                        ) : c.week_start ? (
                          // 週次工数の列は日付そのものが宛先なので、入れるか外すかだけ。
                          <Select
                            value={target}
                            className="h-7 px-2 py-0 text-[11.5px]"
                            onChange={(e) =>
                              setMapping((m) => ({ ...m, [c.index]: e.target.value }))
                            }
                          >
                            <option value="">（取り込まない）</option>
                            <option value={c.header}>週次工数（{c.week_start}）</option>
                          </Select>
                        ) : (
                          <Select
                            value={target}
                            className="h-7 px-2 py-0 text-[11.5px]"
                            onChange={(e) =>
                              setMapping((m) => ({ ...m, [c.index]: e.target.value }))
                            }
                          >
                            <option value="">（取り込まない）</option>
                            {data.targets.map((t) => (
                              <option key={t.key} value={t.key}>
                                {t.label}
                                {ROLE_LABEL[t.role] ? `（${ROLE_LABEL[t.role]}）` : ''}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td className="border-b border-[var(--line)] px-2 py-1.5 align-top text-[var(--ink2)]">
                        <span className="line-clamp-2 block max-w-[300px]">
                          {c.samples.join(' / ') || '（空）'}
                        </span>
                        {cur && cur.type && target && (
                          <span className="text-[var(--ink3)]">{TYPE_LABEL[cur.type] ?? cur.type}として取り込み</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && step === 2 && src && (
        <PreviewStep
          src={src}
          chosen={chosen}
          idColumn={idColumn}
          matchMode={matchMode}
          dataPreview={dataPreview}
          checking={check.isFetching}
        />
      )}
    </WizardShell>
  )
}

function PreviewStep({
  src,
  chosen,
  idColumn,
  matchMode,
  dataPreview,
  checking,
}: {
  src: api.ImportRowsInspection
  chosen: { index: number; name: string }[]
  idColumn: number
  matchMode: ImportMatchMode
  dataPreview: { row: number; cells: string[] }[]
  checking: boolean
}) {
  const byIndex = new Map(src.columns.map((c) => [c.index, c]))
  const warnings: string[] = []
  if (matchMode === 'replace') {
    warnings.push(
      `いまシートにある ${src.deleted_rows} 行を削除してから取り込みます（工数・◇・進捗も消えます）。`,
    )
  }
  if (matchMode !== 'id') {
    if (idColumn < 0) {
      warnings.push('すべての行が新しいタスクとして追加されます（IDは自動採番）。')
    } else {
      if (src.blank_ids > 0)
        warnings.push(`IDが空の行が ${src.blank_ids} 行あります（その行だけ自動採番されます）。`)
      if (src.duplicate_ids > 0)
        warnings.push(
          `同じIDの行が ${src.duplicate_ids} 行あります。まとめずに別々の行として追加し、IDもそのまま残します（参照(LOOKUP)や先行タスクは、同じIDのうち先頭の行に当たります）。`,
        )
    }
  } else if (idColumn < 0) {
    warnings.push('ID列を指定していないため、すべての行が新規タスクとして追加されます。')
  } else {
    if (src.blank_ids > 0)
      warnings.push(`IDが空の行が ${src.blank_ids} 行あります（新規として自動採番されます）。`)
    if (src.duplicate_ids > 0)
      warnings.push(`同じIDの行が ${src.duplicate_ids} 行あります（後の行で上書きされます）。`)
  }
  chosen.forEach((c) => {
    const i = byIndex.get(c.index)
    if (i && i.invalid > 0) {
      warnings.push(
        `「${c.name}」に${TYPE_LABEL[i.type] ?? i.type}として読めない値が ${i.invalid} 件あります（空欄で取り込まれます）：${i.invalid_samples.join('、')}`,
      )
    }
  })
  // 前回の設定が指していた列が、その後で改名・削除されたり計算列（参照・数式）に
  // 変わっていることがある。取り込みでは元々無視されるが、黙って減るのは困る。
  src.columns.forEach((c) => {
    if (c.lost_reason === 'computed') {
      warnings.push(
        `「${c.header}」→「${c.lost_target}」は計算列のため取り込みません（値は自動計算されます）。`,
      )
    } else if (c.lost_reason === 'missing') {
      warnings.push(
        `「${c.header}」の取り込み先「${c.lost_target}」が見つかりません（列名が変わった可能性があります）。この列は取り込まれません。`,
      )
    }
  })
  const skipped = src.columns.filter(
    (c) => !c.target && !c.lost_reason && c.index !== idColumn && c.header,
  )
  if (skipped.length) {
    warnings.push(`取り込まない列：${skipped.map((c) => c.header).join('、')}`)
  }

  const rows = dataPreview.slice(0, 8)
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px] text-[var(--ink2)]">
        <span className="rounded-[9px] bg-[#F2F6F3] px-2.5 py-1 text-[var(--green-d)]">
          新規 {src.new_rows} 行
        </span>
        {matchMode === 'replace' ? (
          <span className="rounded-[9px] bg-[#FAE6E0] px-2.5 py-1 text-[#A8442B]">
            削除 {src.deleted_rows} 行
          </span>
        ) : (
          <span className="rounded-[9px] bg-[#EEF2F5] px-2.5 py-1">
            更新 {src.updated_rows} 行
          </span>
        )}
        <span className="text-[var(--ink3)]">
          ワークシート「{src.sheet_name}」／見出し {src.header_row} 行目／取り込む列 {chosen.length} 列
        </span>
      </div>

      <div className="max-h-[260px] overflow-auto rounded-[10px] border border-[var(--line)]">
        <table className="w-max min-w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
            <tr>
              <th className="border-b border-r border-[var(--line)] px-2 py-1.5 text-left">
                {idColumn < 0 ? 'ID（自動）' : 'ID'}
              </th>
              {chosen.map((c) => (
                <th key={c.index} className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row}>
                <td className="border-b border-r border-[var(--line)] px-2 py-1 text-[var(--ink2)]">
                  {idColumn < 0 ? '—' : (r.cells[idColumn] ?? '')}
                </td>
                {chosen.map((c) => (
                  <td
                    key={c.index}
                    className="max-w-[180px] truncate border-b border-[var(--line)] px-2 py-1"
                    title={r.cells[c.index] ?? ''}
                  >
                    {r.cells[c.index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
        先頭 {rows.length} 行のプレビューです（実際には {src.total_rows} 行取り込みます）。
      </div>

      {checking && <div className="mt-3 text-[11.5px] text-[var(--ink3)]">値を確認しています…</div>}
      {!checking && warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-[10px] bg-[#FBF3EE] px-3 py-2 text-[11.5px] text-[#A8442B]">
          {warnings.map((w) => (
            <li key={w}>・{w}</li>
          ))}
        </ul>
      )}
      {!checking && warnings.length === 0 && (
        <div className="mt-3 text-[11.5px] text-[var(--green-d)]">そのまま取り込める内容です。</div>
      )}
    </div>
  )
}
