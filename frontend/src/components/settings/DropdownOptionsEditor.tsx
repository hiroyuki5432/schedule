// Editor for a dropdown column's options: { options: [{ id, value, color, frozen }] }.
// Add / bulk-import / reorder / freeze / remove options; color swatch per option.
// Each option carries a stable `id` so renaming a value follows through to the
// stored row data (the backend remaps on save). Frozen options stay in the data
// but are hidden from the picker. Saves into column.config.
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { TrashIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import { toast } from '@/lib/toast'
import type { Column, DropdownOption, Row } from '@/types/api'

const SWATCHES = [
  '#E3EFEA',
  '#EFEDE4',
  '#FAE6E0',
  '#E6F0DB',
  '#CBD9EE',
  '#F1DBAC',
  '#E7DDEA',
  '#DCE6EA',
]

function newId(): string {
  // crypto.randomUUID は「安全なコンテキスト」(https / localhost) にしか生えない。
  // 社内配布は http://<サーバーIP>:8080 で開くため undefined になり、選択肢の追加が
  // 例外で黙って死んでいた（ボタンが無反応）。フォールバックを持つ。
  const c = globalThis.crypto as Crypto | undefined
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const rand = () =>
    typeof c?.getRandomValues === 'function'
      ? c.getRandomValues(new Uint32Array(1))[0].toString(36)
      : Math.floor(Math.random() * 0xffffffff).toString(36)
  return `opt-${Date.now().toString(36)}-${rand()}${rand()}`
}

/** Ensure every option has a stable id (legacy options were saved without one). */
function withIds(options: DropdownOption[]): DropdownOption[] {
  return options.map((o) => ({ ...o, id: o.id ?? newId() }))
}

export function DropdownOptionsEditor({
  column,
  rows,
  onDone,
}: {
  column: Column
  /** This sheet's rows — used to find values that are IN the data but not in the
   *  option list (Excel 取り込みは row.data に直接書くので必ず起きる). */
  rows?: Row[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [options, setOptions] = useState<DropdownOption[]>(() =>
    withIds(column.config?.options ?? []),
  )
  const [newValue, setNewValue] = useState('')
  const [bulk, setBulk] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  // 「この値の行をどうするか」。選択肢を消すときに決めた行き先（null = 空にする）。
  // 保存と同時にサーバへ渡し、行の値もまとめて付け替える（要望: プルダウンを削るとき、
  // どこにあてがうかを選べるように）。
  const [remap, setRemap] = useState<Record<string, string | null>>({})
  // 削除の確認を出している選択肢（index）。使われていない選択肢はそのまま消える。
  const [deleting, setDeleting] = useState<number | null>(null)

  // 値ごとの使用件数。「消していいのか」はこれが分からないと判断できない。
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows ?? []) {
      const v = r.data?.[column.id]
      if (v == null) continue
      const s = String(v).trim()
      if (s === '') continue
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    return counts
  }, [rows, column.id])

  // 「データには入っているのに、選択肢には無い値」。取り込んだ直後はここが本番で、
  // 放っておくとセルが「選択肢に未登録」のまま並ぶ。件数と中身を見せて、そのまま
  // 選択肢にできるようにする。
  const orphans = useMemo(() => {
    if (!rows?.length) return []
    const known = new Set(options.map((o) => o.value))
    const seen = new Set<string>()
    for (const r of rows) {
      const v = r.data?.[column.id]
      if (v == null) continue
      const s = String(v).trim()
      if (s === '' || known.has(s) || seen.has(s)) continue
      seen.add(s)
    }
    return [...seen].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [rows, options, column.id])

  function addOrphans() {
    setOptions([
      ...options,
      ...orphans.map((v, i) => ({
        id: newId(),
        value: v,
        color: SWATCHES[(options.length + i) % SWATCHES.length],
      })),
    ])
  }

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, {
        config: { ...column.config, options },
        ...(Object.keys(remap).length ? { value_remap: remap } : {}),
      }),
    onSuccess: () => {
      // Renames / 付け替え may have rewritten stored values → refresh the rows.
      void qc.invalidateQueries({ queryKey: ['sheet'] })
      setRemap({})
      onDone()
      toast.show('選択肢を保存しました', 'success', 2000)
    },
    onError: () => toast.show('選択肢を保存できませんでした。', 'error'),
  })

  /** 選択肢を1つ消す。`to` は行き先（undefined＝値はそのまま残す / null＝空にする）。 */
  function removeOption(i: number, to?: string | null) {
    const gone = options[i]
    setOptions(options.filter((_, j) => j !== i))
    if (to !== undefined && gone?.value) {
      setRemap((prev) => ({ ...prev, [gone.value]: to }))
    }
    setDeleting(null)
  }

  function add() {
    const v = newValue.trim()
    if (!v) return
    setOptions([...options, { id: newId(), value: v, color: SWATCHES[0] }])
    setNewValue('')
  }

  function importBulk() {
    // One option per line; commas also split. Skip blanks and existing values.
    const existing = new Set(options.map((o) => o.value))
    const toAdd: DropdownOption[] = []
    for (const raw of bulk.split(/[\n,]/)) {
      const v = raw.trim()
      if (!v || existing.has(v)) continue
      existing.add(v)
      toAdd.push({ id: newId(), value: v, color: SWATCHES[0] })
    }
    if (toAdd.length) setOptions([...options, ...toAdd])
    setBulk('')
    setShowBulk(false)
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= options.length) return
    const next = [...options]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOptions(next)
  }

  function patch(i: number, p: Partial<DropdownOption>) {
    setOptions(options.map((x, j) => (j === i ? { ...x, ...p } : x)))
  }

  const dirty =
    JSON.stringify(options) !== JSON.stringify(withIds(column.config?.options ?? [])) ||
    Object.keys(remap).length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — 選択肢</CardTitle>
      </CardHeader>
      <CardBody>
        {orphans.length > 0 && (
          <div className="mb-3 rounded-[9px] border border-[#E4C9A8] bg-[#FBF3E6] px-3 py-2.5">
            <div className="text-[12px] font-medium text-[#8A5A1E]">
              選択肢に無い値が {orphans.length} 種類、データに入っています
            </div>
            <div className="mt-1 text-[11.5px] leading-relaxed text-[#8A5A1E]">
              Excel の取り込みは値をそのまま書き込むため、この列の選択肢には入っていません。
              一覧では「選択肢に未登録」と点線付きで表示されます。
              {orphans.length > 40 && (
                <>
                  {' '}
                  種類が多いので、この列は<b>「自由入力」</b>
                  のほうが合っているかもしれません（型を変えても値は消えません）。
                </>
              )}
            </div>
            <div className="mt-1.5 max-h-[64px] overflow-auto text-[11px] text-[#8A5A1E]/85">
              {orphans.slice(0, 30).join(' ・ ')}
              {orphans.length > 30 && ` …ほか ${orphans.length - 30} 種類`}
            </div>
            <Button size="sm" variant="outline" className="mt-2" onClick={addOrphans}>
              {orphans.length} 件すべてを選択肢に追加
            </Button>
          </div>
        )}

        <ul className="mb-3 flex flex-col gap-2">
          {options.map((o, i) => (
            <li key={o.id ?? i} className="flex flex-col gap-1.5">
            <div
              className={cn('flex items-center gap-2', o.frozen && 'opacity-55')}
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="上へ"
                  className="px-1 text-[10px] leading-none text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === options.length - 1}
                  title="下へ"
                  className="px-1 text-[10px] leading-none text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                >
                  ▼
                </button>
              </div>
              <ColorPicker
                value={o.color ?? SWATCHES[0]}
                onChange={(c) => patch(i, { color: c })}
              />
              <Input
                className="flex-1"
                value={o.value}
                onChange={(e) => patch(i, { value: e.target.value })}
              />
              {/* 使用件数。消していいかは、これが分からないと決められない。 */}
              <span
                className={cn(
                  'w-[52px] flex-shrink-0 text-right text-[11px] tabular-nums',
                  usage.get(o.value) ? 'text-[var(--ink2)]' : 'text-[var(--ink3)]',
                )}
                title={
                  rows
                    ? `この値が入っている行の数`
                    : '行を読み込んでいないため件数は出せません'
                }
              >
                {rows ? `${usage.get(o.value) ?? 0} 件` : ''}
              </span>
              <button
                type="button"
                onClick={() => patch(i, { frozen: !o.frozen })}
                title={
                  o.frozen
                    ? '凍結を解除（選択肢に表示）'
                    : '凍結（データは残すが選択肢から隠す）'
                }
                className={cn(
                  'rounded px-2 py-1 text-[11px] hover:bg-[var(--line2)]',
                  o.frozen ? 'text-[#A8442B]' : 'text-[var(--ink3)]',
                )}
              >
                {o.frozen ? '凍結中' : '凍結'}
              </button>
              <button
                className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                onClick={() =>
                  // 使われていない選択肢はそのまま消す。使われているなら、その行を
                  // どうするか（空にする／別の値へ／そのまま）を先に決めてもらう。
                  usage.get(o.value) ? setDeleting(i) : removeOption(i)
                }
                title="削除"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>

            {deleting === i && (
              <RemoveOptionPanel
                value={o.value}
                count={usage.get(o.value) ?? 0}
                others={options.filter((_, j) => j !== i).map((x) => x.value)}
                onCancel={() => setDeleting(null)}
                onChoose={(to) => removeOption(i, to)}
              />
            )}
            </li>
          ))}
          {options.length === 0 && (
            <li className="text-[12px] text-[var(--ink3)]">選択肢がありません。</li>
          )}
        </ul>

        {Object.keys(remap).length > 0 && (
          <ul className="mb-3 space-y-0.5 rounded-[9px] bg-[#F2F6F3] px-3 py-2 text-[11.5px] text-[var(--green-d)]">
            {Object.entries(remap).map(([from, to]) => (
              <li key={from}>
                「{from}」の行は{to === null ? '空になります' : `「${to}」になります`}（保存時）
              </li>
            ))}
          </ul>
        )}

        {showBulk ? (
          <div className="mb-3 flex flex-col gap-2">
            <textarea
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              rows={5}
              placeholder={'まとめて追加（1行に1つ、カンマ区切りも可）\n例：未着手\n進行中\n完了'}
              className="w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12.5px] text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none focus:ring-2 focus:ring-[var(--green-l)]"
            />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowBulk(false)}>
                キャンセル
              </Button>
              <Button onClick={importBulk}>取り込む</Button>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex gap-2">
            <Input
              placeholder="選択肢を追加"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => {
                // IME 変換確定の Enter を拾わない（拾うと変換途中の値が入る）。
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <Button variant="outline" onClick={add}>
              追加
            </Button>
            <Button variant="ghost" onClick={() => setShowBulk(true)}>
              まとめて追加
            </Button>
          </div>
        )}

        {/* 「追加」はまだ画面の中の話で、押すべきボタンは下の「保存」— そこを黙って
            いると "追加したのに反映されない" になる（要望）。 */}
        <div className="flex items-center justify-end gap-2">
          {dirty && (
            <span className="mr-auto text-[11.5px] text-[#A8442B]">
              未保存の変更があります。「保存」を押すまで表には反映されません。
            </span>
          )}
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !dirty}
          >
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** 使われている選択肢を消すときの確認（要望: プルダウンを削る場合、どこにあてがうか
 *  など選べるといい）。
 *
 *  黙って消すと、行の値だけが取り残されて「選択肢に未登録」の点線セルが並ぶ。かといって
 *  勝手に空にすると入力が消える。だから、消す前にここで行き先を決めてもらう。 */
function RemoveOptionPanel({
  value,
  count,
  others,
  onCancel,
  onChoose,
}: {
  value: string
  count: number
  others: string[]
  onCancel: () => void
  /** null = 空にする / 文字列 = その値に付け替える / undefined = 値はそのまま残す。 */
  onChoose: (to: string | null | undefined) => void
}) {
  const [to, setTo] = useState<string>(others[0] ?? '')
  return (
    <div className="ml-9 rounded-[9px] border border-[#E4C9A8] bg-[#FBF3E6] px-3 py-2.5">
      <div className="text-[12px] font-medium text-[#8A5A1E]">
        「{value}」は {count} 行で使われています。その行をどうしますか？
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {others.length > 0 && (
          <>
            <Select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-7 min-w-[140px] px-2 py-0 text-[11.5px]"
            >
              {others.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
            <Button size="sm" onClick={() => onChoose(to)} disabled={!to}>
              この値に付け替えて削除
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => onChoose(null)}>
          空にして削除
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="行の値はそのまま残ります（一覧では「選択肢に未登録」と点線で表示されます）"
          onClick={() => onChoose(undefined)}
        >
          値は残して削除
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          やめる
        </Button>
      </div>
    </div>
  )
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        className="h-7 w-7 rounded-[7px] border border-[var(--line)]"
        style={{ background: value }}
        onClick={() => setOpen((o) => !o)}
        title="色"
      />
      {open && (
        <div className="absolute left-0 z-10 mt-1 flex w-[136px] flex-wrap gap-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-lg">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              className="h-6 w-6 rounded-[6px] border border-[var(--line)]"
              style={{ background: c }}
              onClick={() => {
                onChange(c)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
