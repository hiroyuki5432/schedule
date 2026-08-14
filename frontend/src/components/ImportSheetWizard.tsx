// Excel取り込みウィザード — the confirm-as-you-go path for "シート追加 → Excelから
// 取り込む". Nothing is written until the last step: the file is analysed by
// POST /api/sheets/import.xlsx/inspect, and the user picks
//   1. どのワークシートか / 何行目が見出しか / どの列がID か
//   2. どの列を取り込むか（列名・型も変更できる）
//   3. プレビューと警告を確認してから取り込む
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import * as api from '@/api/client'
import type { ImportColumnInfo, ImportColumnRole, ImportMatchMode } from '@/api/client'
import type { ColumnType } from '@/types/api'
import { ApiError } from '@/lib/http'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { WizardShell, colLetter } from '@/components/import/WizardShell'
import { AUTO_ID, SourceStep } from '@/components/import/SourceStep'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/format'

interface Props {
  file: File
  /** シート名 typed in the 追加ダイアログ (blank → the worksheet's own name). */
  defaultName: string
  hasWeekGrid: boolean
  /** マスタシートとして作る（サイドバーの一覧には出さない）。 */
  isMaster?: boolean
  /** Back to the 追加ダイアログ. */
  onBack: () => void
  onClose: () => void
}

/** One column as edited in the wizard. */
interface Pick {
  index: number
  selected: boolean
  name: string
  type: ColumnType | ''
  /** 数式列のときの `[列名]` 式（Excelの数式から翻訳したもの）。 */
  expr?: string
}

const STEPS = ['シートと見出し行', '取り込む列', 'プレビュー']

const ROLE_LABEL: Record<ImportColumnRole, string> = {
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
  member: '担当者',
  formula: '数式（計算のまま）',
}

const TYPE_OPTIONS: ColumnType[] = ['text', 'number', 'date', 'dropdown', 'member']

export function ImportSheetWizard({
  file,
  defaultName,
  hasWeekGrid,
  isMaster = false,
  onBack,
  onClose,
}: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [name, setName] = useState(defaultName)
  const [sheetName, setSheetName] = useState('')
  const [headerRow, setHeaderRow] = useState(0) // 0 = 自動判定
  const [lastRow, setLastRow] = useState(0) // 0 = 最後まで
  const [tailFrom, setTailFrom] = useState(0) // 0 = 末尾から自動
  // 既定は「照合しない」＝ Excelの1行がそのまま1行。1列目が同じ行があってもまとめない
  // （要望）。ID列は既定どおり先頭列のまま — 照合に使わないだけで、**その値は行のIDと
  // して残す**（要望: もともとのIDで紐付けしたいので消さないでほしい）。IDの無い表だけ
  // 「自動採番」を選ぶ（そのとき1列目は普通の列として取り込める）。
  const [matchMode, setMatchMode] = useState<ImportMatchMode>('none')
  const [idColumn, setIdColumn] = useState(0)
  const [picks, setPicks] = useState<Pick[]>([])
  const [error, setError] = useState<string | null>(null)

  const fileKey = `${file.name}:${file.size}:${file.lastModified}`

  // Structure of the chosen worksheet: worksheets, 見出し行の候補, preview, 列の推定.
  const insp = useQuery({
    queryKey: [
      'xlsx-inspect',
      fileKey,
      sheetName,
      headerRow,
      lastRow,
      tailFrom,
      idColumn,
      hasWeekGrid,
    ],
    queryFn: () =>
      api.inspectImportXlsx(file, {
        sheetName,
        headerRow,
        lastRow,
        tailFrom,
        idColumn,
        hasWeekGrid,
      }),
    staleTime: Infinity,
    retry: false,
  })

  // Re-seed the column picks whenever the worksheet / 見出し行 / ID列 changes.
  useEffect(() => {
    if (!insp.data) return
    setPicks(
      insp.data.columns.map((c) => ({
        index: c.index,
        selected: c.selected,
        name: c.header,
        type: c.type,
        expr: c.formula?.expr ?? undefined,
      })),
    )
  }, [insp.data])

  const info = useMemo(() => {
    const m = new Map<number, ImportColumnInfo>()
    insp.data?.columns.forEach((c) => m.set(c.index, c))
    return m
  }, [insp.data])

  const chosen = useMemo(
    () =>
      picks
        .filter((p) => p.selected && p.name.trim() !== '' && p.index !== idColumn)
        .map((p) => ({
          index: p.index,
          name: p.name.trim(),
          type: p.type,
          ...(p.type === 'formula' && p.expr ? { expr: p.expr } : {}),
        })),
    [picks, idColumn],
  )

  // Final check against the user's own picks — counts values that would not convert.
  const check = useQuery({
    queryKey: [
      'xlsx-check',
      fileKey,
      sheetName,
      headerRow,
      lastRow,
      idColumn,
      hasWeekGrid,
      JSON.stringify(chosen),
    ],
    queryFn: () =>
      api.inspectImportXlsx(file, {
        sheetName,
        headerRow,
        lastRow,
        idColumn,
        hasWeekGrid,
        columns: chosen,
      }),
    enabled: step === 2 && chosen.length > 0,
    staleTime: Infinity,
    retry: false,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await api.importNewSheetXlsx(file, {
        name: name.trim(),
        hasWeekGrid,
        sheetName: insp.data?.sheet_name,
        headerRow: insp.data?.header_row,
        lastRow,
        idColumn,
        matchMode,
        columns: chosen,
      })
      // Save this as the worksheet's 取り込み設定, pointed at the sheet that was
      // just created — so the next load UPDATES it instead of making another
      // sheet, and the 一括取り込み can replay it without asking anything.
      // Best effort: the sheet exists either way.
      if (insp.data) {
        await api
          .saveImportPreset({
            worksheet_name: insp.data.sheet_name,
            name: r.name,
            workbook_name: file.name,
            target_sheet_id: r.sheet_id,
            target_sheet_name: r.name,
            has_week_grid: hasWeekGrid,
            header_row: insp.data.header_row,
            last_row: lastRow,
            id_column: idColumn,
            match_mode: matchMode,
            mapping: chosen,
          })
          .catch(() => {})
      }
      // 取り込みAPIは通常シートを作るので、マスタ指定はあとから立てる。
      if (isMaster) {
        await api.updateSheet(String(r.sheet_id), { is_master: true }).catch(() => {})
      }
      toast.show(
        `「${r.name}」を作成しました（列 ${r.columns} / 行 ${r.created}）`,
        'success',
      )
      // 選択肢を増やした／増やさなかった理由は黙らない（要望: 取込後のプルダウン）。
      for (const note of r.notes ?? []) toast.show(note, 'info', 7000)
      return String(r.sheet_id)
    },
    onSuccess: async (id) => {
      await qc.invalidateQueries({ queryKey: ['sheets'] })
      await qc.invalidateQueries({ queryKey: ['import-presets'] })
      onClose()
      navigate(`/sheets/${id}`)
    },
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : 'シートの取り込みに失敗しました。')
    },
  })

  const data = insp.data
  const dataPreview = (data?.preview ?? []).filter(
    (r) =>
      r.row > (data?.header_row ?? 0) && (!data?.last_row || r.row <= data.last_row),
  )

  const setPick = (index: number, patch: Partial<Pick>) =>
    setPicks((prev) => prev.map((p) => (p.index === index ? { ...p, ...patch } : p)))

  return (
    <WizardShell
      title="Excelから取り込む（新しいシート）"
      steps={STEPS}
      step={step}
      onStep={setStep}
      loading={insp.isPending}
      error={insp.isError ? insp.error : undefined}
      status={data && `${file.name} ／ データ ${data.total_rows} 行`}
      notice={error}
      canNext={!!data}
      runLabel="取り込んで作成"
      running={mutation.isPending}
      canRun={!!data && chosen.length > 0}
      onRun={() => {
        setError(null)
        mutation.mutate()
      }}
      onBack={onBack}
      onClose={onClose}
    >
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
          }}
          onHeaderRow={setHeaderRow}
          onLastRow={setLastRow}
          onTailFrom={setTailFrom}
          idColumn={idColumn}
          onIdColumn={setIdColumn}
          matchMode={matchMode}
          onMatchMode={(m) => {
            setMatchMode(m)
            // ID列の指定はそのまま残す（照合に使わないだけで、値は行のIDになる）。
            // 新しいシートなので「入れ替え」は無い。
            if (m === 'id') setIdColumn((cur) => (cur < 0 ? 0 : cur))
          }}
          matchModes={['none', 'id']}
          note={
            matchMode === 'id'
              ? 'ID列（薄い黄色）が同じ行は1行にまとまります。'
              : 'ID列（薄い黄色）の値がそのまま行のIDになります（空欄の行だけ自動採番）。'
          }
        />
      )}

      {data && step === 1 && (
        <StepColumns
          picks={picks}
          info={info}
          idColumn={idColumn}
          onPick={setPick}
          onAll={(selected) =>
            setPicks((prev) =>
              prev.map((p) =>
                p.index === idColumn || !p.name.trim() ? p : { ...p, selected },
              ),
            )
          }
        />
      )}

      {data && step === 2 && (
        <StepPreview
          data={data}
          check={check.data}
          checking={check.isFetching}
          chosen={chosen}
          idColumn={idColumn}
          matchMode={matchMode}
          dataPreview={dataPreview}
          name={name}
          onName={setName}
          hasWeekGrid={hasWeekGrid}
        />
      )}
    </WizardShell>
  )
}

// --------------------------------------------------------------------------- //
// Step 2 — which columns to take
// --------------------------------------------------------------------------- //
function StepColumns({
  picks,
  info,
  idColumn,
  onPick,
  onAll,
}: {
  picks: Pick[]
  info: Map<number, ImportColumnInfo>
  idColumn: number
  onPick: (index: number, patch: Partial<Pick>) => void
  onAll: (selected: boolean) => void
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] text-[var(--ink2)]">
          取り込む列にチェックを入れてください。列名と型はここで変更できます。
        </span>
        <span className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onAll(true)}>
            すべて選択
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onAll(false)}>
            すべて解除
          </Button>
        </span>
      </div>

      <div className="max-h-[380px] overflow-auto rounded-[10px] border border-[var(--line)]">
        <table className="w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
            <tr>
              <th className="w-9 border-b border-[var(--line)] px-2 py-1.5" />
              <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">Excelの見出し</th>
              <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">列名</th>
              <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">型</th>
              <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">値の例</th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => {
              const c = info.get(p.index)
              const role = c?.role ?? 'attr'
              const isId = p.index === idColumn
              const reserved = role === 'week' || role === 'progress' || role === 'deps'
              return (
                <tr key={p.index} className={cn(isId && 'bg-[#FBF6EC]')}>
                  <td className="border-b border-[var(--line)] px-2 py-1.5 text-center align-top">
                    <input
                      type="checkbox"
                      checked={p.selected && !isId}
                      disabled={isId || !c?.header}
                      onChange={(e) => onPick(p.index, { selected: e.target.checked })}
                      className="accent-[var(--green)]"
                    />
                  </td>
                  <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                    <span className="text-[var(--ink3)]">{colLetter(p.index)}: </span>
                    {c?.header || <span className="text-[var(--ink3)]">（見出しなし）</span>}
                    {isId && <span className="ml-1 text-[var(--ink3)]">→ ID列</span>}
                    {ROLE_LABEL[role] && !isId && (
                      <span className="ml-1 rounded-[6px] bg-[#EEF2F5] px-1.5 py-0.5 text-[10.5px] text-[var(--ink2)]">
                        {ROLE_LABEL[role]}
                      </span>
                    )}
                  </td>
                  <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                    {isId || reserved ? (
                      <span className="text-[var(--ink3)]">—</span>
                    ) : (
                      <Input
                        value={p.name}
                        onChange={(e) => onPick(p.index, { name: e.target.value })}
                        className="h-7 w-[150px] px-2 py-1 text-[11.5px]"
                      />
                    )}
                  </td>
                  <td className="border-b border-[var(--line)] px-2 py-1.5 align-top">
                    {isId ? (
                      <span className="text-[var(--ink3)]">—</span>
                    ) : reserved ? (
                      <span className="text-[var(--ink3)]">{ROLE_LABEL[role]}として取り込み</span>
                    ) : (
                      <Select
                        value={p.type || 'text'}
                        onChange={(e) =>
                          onPick(p.index, { type: e.target.value as ColumnType })
                        }
                        className="h-7 px-2 py-0 text-[11.5px]"
                      >
                        {/* 「数式」は、Excel の式をこのアプリの式に翻訳できた列だけに
                            出す。翻訳できない式を数式列にしても計算できないので。 */}
                        {c?.formula?.expr && <option value="formula">{TYPE_LABEL.formula}</option>}
                        {TYPE_OPTIONS.map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABEL[t]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </td>
                  <td className="border-b border-[var(--line)] px-2 py-1.5 align-top text-[var(--ink2)]">
                    <span className="line-clamp-2 block max-w-[280px]">
                      {c?.samples.join(' / ') || '（空）'}
                    </span>
                    {c && c.filled === 0 && (
                      <span className="text-[var(--ink3)]">値が入っていません</span>
                    )}
                    {c?.formula && <FormulaNote formula={c.formula} asFormula={p.type === 'formula'} />}
                    {role === 'milestone' && (
                      <span className="block text-[var(--ink3)]">
                        マイルストン列。取り込むと通常の列になります
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Excel の数式が入っていた列に添える説明。
 *
 *  取り込みは既定で「計算結果」を値として書き込むので、何も言わないと、元の列を直しても
 *  動かない“焼き付いた数字”になる。翻訳できたときは何の式になるかを見せ、できなかった
 *  ときは理由を出して、値のまま入ることを納得してもらう。 */
function FormulaNote({
  formula,
  asFormula,
}: {
  formula: NonNullable<ImportColumnInfo['formula']>
  asFormula: boolean
}) {
  if (formula.expr) {
    return (
      <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[var(--ink3)]">
        Excelの数式 <code className="text-[var(--ink2)]">{formula.sample}</code>（
        {formula.cells}セル）
        {asFormula ? (
          <>
            {' → '}
            <code className="text-[var(--green-d)]">{formula.expr}</code>{' '}
            として計算し続けます。
          </>
        ) : (
          <> → いまの計算結果を値として取り込みます（元の列を直しても変わりません）。</>
        )}
      </span>
    )
  }
  return (
    <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[#8A5A1E]">
      Excelの数式 <code>{formula.sample}</code>（{formula.cells}セル）は、この列の式に
      できません（{formula.reason}）。計算結果を値として取り込みます。
    </span>
  )
}

// --------------------------------------------------------------------------- //
// Step 3 — preview + warnings
// --------------------------------------------------------------------------- //
function StepPreview({
  data,
  check,
  checking,
  chosen,
  idColumn,
  matchMode,
  dataPreview,
  name,
  onName,
  hasWeekGrid,
}: {
  data: api.ImportInspection
  check: api.ImportInspection | undefined
  checking: boolean
  chosen: { index: number; name: string; type: ColumnType | '' }[]
  idColumn: number
  matchMode: ImportMatchMode
  dataPreview: { row: number; cells: string[] }[]
  name: string
  onName: (v: string) => void
  hasWeekGrid: boolean
}) {
  const src = check ?? data
  const warnings: string[] = []
  if (idColumn === AUTO_ID) {
    warnings.push('ID列を指定していないため、行のIDは自動採番されます。')
  } else if (matchMode === 'none') {
    if (src.blank_ids > 0)
      warnings.push(`IDが空の行が ${src.blank_ids} 行あります（その行だけ自動採番されます）。`)
    if (src.duplicate_ids > 0)
      warnings.push(
        `同じIDの行が ${src.duplicate_ids} 行あります。まとめずに別々の行として取り込み、IDもそのまま残します（参照(LOOKUP)や先行タスクは、同じIDのうち先頭の行に当たります）。`,
      )
  } else {
    if (src.blank_ids > 0)
      warnings.push(`IDが空の行が ${src.blank_ids} 行あります（自動採番されます）。`)
    if (src.duplicate_ids > 0)
      warnings.push(
        `同じIDの行が ${src.duplicate_ids} 行あります（後の行で上書きされ、1行にまとまります）。`,
      )
  }
  const byIndex = new Map(src.columns.map((c) => [c.index, c]))
  chosen.forEach((c) => {
    const info = byIndex.get(c.index)
    if (info && info.invalid > 0) {
      warnings.push(
        `「${c.name}」に${TYPE_LABEL[c.type || 'text'] ?? ''}として読めない値が ${info.invalid} 件あります（空欄で取り込まれます）：${info.invalid_samples.join('、')}`,
      )
    }
  })
  const dupNames = chosen
    .map((c) => c.name)
    .filter((n, i, all) => all.indexOf(n) !== i)
  if (dupNames.length) warnings.push(`列名が重複しています：${[...new Set(dupNames)].join('、')}`)
  if (chosen.some((c) => c.name === 'ID')) {
    warnings.push('列名「ID」はID列の予約名です。別の名前に変えないとその列は取り込まれません。')
  }

  const rows = dataPreview.slice(0, 8)

  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[12px] text-[var(--ink2)]">シート名</span>
        <Input
          value={name}
          placeholder={data.sheet_name}
          onChange={(e) => onName(e.target.value)}
          className="w-[260px]"
        />
      </label>

      <div className="mt-3 text-[11.5px] text-[var(--ink2)]">
        {hasWeekGrid ? 'スケジュール（週次グリッド）' : 'テーブル（集計・参照）'}／ワークシート「
        {data.sheet_name}」／見出し {data.header_row} 行目／取り込む列 {chosen.length} 列／
        {data.total_rows} 行
      </div>

      <div className="mt-3 max-h-[260px] overflow-auto rounded-[10px] border border-[var(--line)]">
        <table className="w-max min-w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
            <tr>
              <th className="border-b border-r border-[var(--line)] px-2 py-1.5 text-left">
                {idColumn === AUTO_ID ? 'ID（自動）' : 'ID'}
              </th>
              {chosen.map((c) => (
                <th key={c.index} className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                  {c.name}
                  <span className="ml-1 font-normal text-[var(--ink3)]">
                    {byIndex.get(c.index)?.role && ROLE_LABEL[byIndex.get(c.index)!.role]
                      ? ROLE_LABEL[byIndex.get(c.index)!.role]
                      : TYPE_LABEL[c.type || 'text']}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row}>
                <td className="border-b border-r border-[var(--line)] px-2 py-1 text-[var(--ink2)]">
                  {idColumn === AUTO_ID ? '—' : (r.cells[idColumn] ?? '')}
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
        先頭 {rows.length} 行のプレビューです（実際には {data.total_rows} 行取り込みます）。
      </div>

      {checking && (
        <div className="mt-3 text-[11.5px] text-[var(--ink3)]">値を確認しています…</div>
      )}
      {!checking && warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-[10px] bg-[#FBF3EE] px-3 py-2 text-[11.5px] text-[#A8442B]">
          {warnings.map((w) => (
            <li key={w}>・{w}</li>
          ))}
        </ul>
      )}
      {!checking && warnings.length === 0 && (
        <div className="mt-3 text-[11.5px] text-[var(--green-d)]">
          そのまま取り込める内容です。
        </div>
      )}
    </div>
  )
}
