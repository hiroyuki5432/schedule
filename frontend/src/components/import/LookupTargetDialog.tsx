// 取り込みウィザードで、XLOOKUP の参照先を **手で** 結びつけるダイアログ。
//
// 要望: テーブルと列名に微妙な名前の違いがあるから紐付けできない。
//
// 自動の結びつけは名前の一致でしか出来ない（「マスタ」というワークシート ↔ 「マスタ」
// というシート、「品番」という見出し ↔ 「品番」という列）。実際のブックは、Excel 側が
// 「部品マスター」でアプリ側が「部品マスタ」、Excel 側が「品番」でアプリ側が「品目番号」
// といった具合に、少しずつずれている。ずれた瞬間に参照列を作れなくなるのは不便なので、
// **Excel がどう書いていたか** を見せたうえで、その場で選び直せるようにする。
//
// 名前のずれだけでなく、**式の形が想定外で自動では読み取れなかった** 列もここに来る
// （要望: XLOOKUP も参照が選べるものと選べないものがある。なぜ？）。読み取れた分は初期値
// として使い、読み取れなければ空のまま選んでもらう。分かっていない項目を「？」で埋めない
// のが方針 — 読めているふりをすると、選び直す手がかりにならない。
//
// ここで選ぶのは「参照先」だけで、列を作るのは取り込みの実行時。列IDがまだ無いので、
// このシート側のキーは列IDではなく **Excel の列位置** で持つ（サーバが作成後に結び直す）。
import { useEffect, useState } from 'react'
import type { ImportColumnInfo, ImportColumnPick } from '@/api/client'
import { useColumns, useSheets } from '@/hooks/useSheets'
import { ID_KEY } from '@/lib/lookup'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import type { Column } from '@/types/api'

type LookupPick = NonNullable<ImportColumnPick['lookup']>

interface Props {
  /** 設定する列（Excel の見出し・数式と、読み取れていれば XLOOKUP の中身）。 */
  info: ImportColumnInfo
  /** キーに選べる、このシート側の列（Excel の列位置 → 見出し）。 */
  localOptions: { index: number; label: string }[]
  /** いま設定されている参照先（未設定なら undefined）。 */
  value: LookupPick | undefined
  onSave: (next: LookupPick) => void
  onClose: () => void
}

export function LookupTargetDialog({ info, localOptions, value, onSave, onClose }: Props) {
  const lk = info.formula?.lookup
  const sheetsQ = useSheets()
  const sheets = sheetsQ.data ?? []

  const [sheetId, setSheetId] = useState<string>(() =>
    value?.sheet_id != null
      ? String(value.sheet_id)
      : lk?.sheet_id != null
        ? String(lk.sheet_id)
        : '',
  )
  // 読み取れなかった列では、キーを **既定で埋めない**。localOptions[0]（多くの場合ID列）
  // を初期値にしていると、ID列で引くのが正しくないブックで、気づかないまま「この設定に
  // する」を押せてしまう。空にしておけば必ず一度は目を通すことになる。
  const [localIndex, setLocalIndex] = useState<number | null>(
    value?.local_index ?? lk?.local_index ?? null,
  )
  const [matchId, setMatchId] = useState<string>(
    value?.match_key_column_id ?? lk?.match_key_column_id ?? '',
  )
  const [returnId, setReturnId] = useState<string>(
    value?.return_column_id ?? lk?.return_column_id ?? '',
  )

  const colsQ = useColumns(sheetId || undefined)
  const targetCols = [...(colsQ.data ?? [])].sort((a, b) => a.order - b.order)

  // 対象シートを選んだ（変えた）ら、Excel が書いていた列名と同じ名前の列を当てておく。
  // ぴったり合わなければ空のまま — 適当に埋めて気づかれないより、選んでもらうほうがいい。
  useEffect(() => {
    if (!sheetId || colsQ.data === undefined) return
    const byName = (name: string | undefined) => {
      if (!name) return ''
      const hit = (colsQ.data ?? []).find(
        (c: Column) => c.name.trim().toLowerCase() === name.trim().toLowerCase(),
      )
      return hit ? String(hit.id) : ''
    }
    setMatchId((cur) => (cur ? cur : byName(lk?.match_column)))
    setReturnId((cur) => (cur ? cur : byName(lk?.return_column)))
  }, [sheetId, colsQ.data, lk?.match_column, lk?.return_column])

  const ready = !!sheetId && !!matchId && !!returnId && localIndex !== null
  const localLabel =
    localOptions.find((o) => o.index === localIndex)?.label ?? '（未選択）'
  const nameOf = (id: string) =>
    id === ID_KEY ? 'ID' : targetCols.find((c) => String(c.id) === id)?.name ?? '？'

  return (
    <Modal title={`「${info.header}」の参照先`} onClose={onClose} widthClass="w-[440px]">
      {/* Excel 側が何と書いていたか。名前がずれているとき、どこを直せばいいかの手がかり。
          ただし式の形が想定外だと、読み取れているのは数式そのものだけ、ということがある
          （`=[@数量]*XLOOKUP(…)`、一部の行だけ XLOOKUP、キーが `A2&B2` など）。その場合に
          「「？」で照合し「？」を取得」と出すのは、読めているふりでしかない — 素の数式を
          見せて「ここからは読み取れなかった」と言うほうが、次に何をすればいいか分かる。 */}
      <div className="mb-3 rounded-[10px] bg-[var(--line2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--ink2)]">
        Excelの数式 <code className="text-[var(--ink)]">{info.formula?.sample}</code>
        <br />
        {lk && lk.target_worksheet && lk.match_column && lk.return_column ? (
          <>
            ワークシート「{lk.target_worksheet}」の「{lk.match_column}」で照合し、「
            {lk.return_column}」を取得しています。
            {!lk.ready && (
              <span className="mt-1 block text-[#8A5A1E]">
                自動では結びつけられませんでした（{lk.reason}）。下で選んでください。
              </span>
            )}
          </>
        ) : (
          <>
            {lk?.target_worksheet && <>ワークシート「{lk.target_worksheet}」を参照しています。</>}
            <span className="mt-1 block text-[#8A5A1E]">
              この数式からは、どの列で照合してどの列を取得するのかを読み取れませんでした
              {info.formula?.reason ? `（${info.formula.reason}）` : ''}。下で選んでください。
            </span>
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <label className="text-[12px] text-[var(--ink2)]">
          このシートのキー（Excelのどの列で引くか）
          <Select
            className="mt-1 w-full"
            value={localIndex === null ? '' : String(localIndex)}
            onChange={(e) =>
              setLocalIndex(e.target.value === '' ? null : Number(e.target.value))
            }
          >
            <option value="">（未選択）</option>
            {localOptions.map((o) => (
              <option key={o.index} value={o.index}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-[12px] text-[var(--ink2)]">
          対象シート
          <Select
            className="mt-1 w-full"
            value={sheetId}
            onChange={(e) => {
              setSheetId(e.target.value)
              // シートを変えたら、前のシートの列IDは意味を持たない。
              setMatchId('')
              setReturnId('')
            }}
          >
            <option value="">（未選択）</option>
            {sheets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.is_master ? '（マスタ）' : ''}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-[12px] text-[var(--ink2)]">
          照合する対象列
          <Select
            className="mt-1 w-full"
            value={matchId}
            onChange={(e) => setMatchId(e.target.value)}
            disabled={!sheetId}
          >
            <option value="">（未選択）</option>
            <option value={ID_KEY}>ID（対象行のキー値）</option>
            {targetCols.map((c: Column) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-[12px] text-[var(--ink2)]">
          取得する対象列
          <Select
            className="mt-1 w-full"
            value={returnId}
            onChange={(e) => setReturnId(e.target.value)}
            disabled={!sheetId}
          >
            <option value="">（未選択）</option>
            <option value={ID_KEY}>ID（対象行のキー値）</option>
            {targetCols.map((c: Column) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>

        {/* 選んだ内容を1行の日本語で読み返せるように。選び違いはここで気づく。 */}
        <div className="rounded-[10px] border border-[var(--line)] px-3 py-2 text-[11.5px] text-[var(--ink2)]">
          {ready && localIndex !== null ? (
            <>
              <span className="text-[var(--ink)]">{localLabel}</span> の値で「
              {sheets.find((s) => String(s.id) === sheetId)?.name}」の{' '}
              <span className="text-[var(--ink)]">{nameOf(matchId)}</span> を探し、その行の{' '}
              <span className="text-[var(--ink)]">{nameOf(returnId)}</span> を表示します。
            </>
          ) : (
            <span className="text-[var(--ink3)]">
              キーの列・対象シート・2つの対象列を選んでください。
            </span>
          )}
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          キャンセル
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => {
            if (localIndex === null) return
            onSave({
              sheet_id: Number(sheetId),
              local_index: localIndex,
              match_key_column_id: matchId,
              return_column_id: returnId,
            })
          }}
        >
          この設定にする
        </Button>
      </div>
    </Modal>
  )
}
