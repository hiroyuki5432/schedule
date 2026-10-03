// 属性セルの範囲選択（要望: Excel のように、範囲でコピペ・Delete・フィルしたい）。
//
// テーブル型シートとスケジュールの属性列の両方で使う。中身の変換（TSV・値の読み取り・
// フィルの数列）は lib/cellRange.ts、ここは「どのセルを選んでいるか」と操作だけ。
//
// 操作（Excel と同じ）:
//   ドラッグ … 範囲を選ぶ          Shift+クリック／Shift+矢印 … 範囲を広げる
//   クリック … そのセルを編集（従来どおり）  矢印 … 選択を動かす
//   Enter / F2 … 編集を始める      文字を打つ … 打った文字で編集を始める（文字・数値の列）
//   Ctrl+C / Ctrl+V … コピー・貼り付け（Excel と相互に。1セルを広い範囲に貼ると全部に入る）
//   Delete … まとめて空に          Ctrl+D … 先頭の行を下へコピー
//   右下の■をドラッグ … フィル（数値・日付・末尾が数字の文字は続きの値、他はコピー）
//   Esc … 選択を外す
//
// 書き込みは consumer の apply() に「前の値つき」でまとめて渡す（1回の取り消しで戻せる）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { fillSeries, parseTsv, toTsv } from '@/lib/cellRange'
import type { ParseResult } from '@/lib/cellRange'
import { toast } from '@/lib/toast'
import type { CellValue } from '@/types/api'

export interface CellAddr {
  rowId: string
  colKey: string
}

/** 1セルの書き換え（前の値つき — 元に戻すため）。 */
export interface CellEdit {
  rowId: string
  colKey: string
  before: CellValue
  after: CellValue
}

export interface RangeRect {
  r0: number
  r1: number
  c0: number
  c1: number
}

export interface CellRangeOptions {
  /** 画面に並んでいる順の行ID。 */
  rowIds: string[]
  /** 画面に並んでいる順の列キー（ID は lib/cellRange の ID_CELL）。 */
  colKeys: string[]
  containerRef: RefObject<HTMLElement | null>
  enabled: boolean
  /** コピーするときの文字（画面に見えているとおり）。 */
  getText: (rowId: string, colKey: string) => string
  /** 保存されている値（フィルの元・取り消し用の「前の値」）。 */
  getValue: (rowId: string, colKey: string) => CellValue
  /** 書き込める列なら null、書けないなら理由（「計算列」など）。 */
  readonlyReason: (colKey: string) => string | null
  /** 貼り付けた文字 → 保存する値。 */
  parse: (colKey: string, text: string) => ParseResult
  /** 'series' なら数値・日付・末尾の数字を続ける。'copy' は繰り返すだけ。 */
  fillMode: (colKey: string) => 'series' | 'copy'
  /** 打った文字で編集を始められる列か（文字・数値）。 */
  seedable: (colKey: string) => boolean
  /** まとめて書き込む。label は取り消しの表示に使う。 */
  apply: (edits: CellEdit[], label: string) => void
  /** キーボードで動かしたとき、その行が見えるようにする（仮想化されている一覧向け）。 */
  scrollToRow?: (rowIndex: number) => void
  /** 範囲を選び始めたとき（スケジュールでは週セルの選択を外すのに使う）。 */
  onActivate?: () => void
}

const cellAttr = (rowId: string, colKey: string) => `${rowId}|${colKey}`

/** コピー・貼り付けを受けた要素が何か。
 *  - 'text'   … 文字を選んで編集できる入力欄（文字・数値・ID・複数行）
 *  - 'opaque' … 文字を選べない編集欄（プルダウンの select・日付の input）
 *  - 'none'   … 編集欄ではない（選択中のセル・入れ物） */
function editorKind(t: EventTarget | null): 'text' | 'opaque' | 'none' {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return 'none'
  if (el.tagName === 'SELECT') return 'opaque'
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return type === 'date' || type === 'datetime-local' || type === 'month' ? 'opaque' : 'text'
  }
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'text'
  return 'none'
}

/** 開いている編集欄を、値を確定せずに閉じる（セルとしてコピー・貼り付けした後）。
 *  Esc（＝取消。入力欄は閉じるときに古い値で上書き保存しない。select は選んだ時点で
 *  保存する作りなので閉じるだけ）。select は念のため blur も。 */
function closeEditor(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  if (el.tagName === 'SELECT') el.blur()
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useCellRange(o: CellRangeOptions) {
  const optsRef = useRef(o)
  optsRef.current = o

  const [sel, setSel] = useState<{ anchor: CellAddr; focus: CellAddr } | null>(null)
  const selRef = useRef(sel)
  selRef.current = sel
  // ドラッグ中（範囲選択）/ フィルハンドルのドラッグ中。
  const dragRef = useRef<{ start: CellAddr; moved: boolean } | null>(null)
  const [fill, setFill] = useState<{ targetRow: number } | null>(null)
  const fillRef = useRef(fill)
  fillRef.current = fill
  // ドラッグや Shift+クリックの直後に、セルの「クリックで編集」を開かせないための印。
  const suppressClickRef = useRef(false)

  const rowIndex = useMemo(() => {
    const m = new Map<string, number>()
    o.rowIds.forEach((id, i) => m.set(String(id), i))
    return m
  }, [o.rowIds])
  const colIndex = useMemo(() => {
    const m = new Map<string, number>()
    o.colKeys.forEach((k, i) => m.set(String(k), i))
    return m
  }, [o.colKeys])

  const rect: RangeRect | null = useMemo(() => {
    if (!sel) return null
    const a = rowIndex.get(sel.anchor.rowId)
    const b = rowIndex.get(sel.focus.rowId)
    const ca = colIndex.get(sel.anchor.colKey)
    const cb = colIndex.get(sel.focus.colKey)
    if (a == null || b == null || ca == null || cb == null) return null
    return { r0: Math.min(a, b), r1: Math.max(a, b), c0: Math.min(ca, cb), c1: Math.max(ca, cb) }
  }, [sel, rowIndex, colIndex])
  const rectRef = useRef(rect)
  rectRef.current = rect

  const clear = useCallback(() => setSel(null), [])

  const focusContainer = useCallback(() => {
    optsRef.current.containerRef.current?.focus({ preventScroll: true })
  }, [])

  /** そのセルの「クリックで編集」を呼び出す（InlineCell のボタンを押す）。 */
  const openEditor = useCallback((addr: CellAddr, seed?: string) => {
    const root = optsRef.current.containerRef.current
    if (!root) return
    const cell = root.querySelector(`[data-cell="${CSS.escape(cellAttr(addr.rowId, addr.colKey))}"]`)
    // セルの中にボタンが複数あるとき（スケジュールの ID 欄など）は、編集のボタンに
    // data-cell-editor を付けておく。
    const btn = (cell?.querySelector('[data-cell-editor]') ??
      cell?.querySelector('button')) as HTMLButtonElement | null
    if (!btn) return
    suppressClickRef.current = false
    btn.click()
    if (seed == null) return
    // 開いた入力欄に、打った文字を入れる（Excel の「打ったら上書き」）。React の
    // 制御された input なので、値の setter を直接呼んでから input イベントを送る。
    requestAnimationFrame(() => {
      const input = cell?.querySelector('input') as HTMLInputElement | null
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, seed)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.setSelectionRange?.(seed.length, seed.length)
    })
  }, [])

  const scrollCellIntoView = useCallback((addr: CellAddr) => {
    const o2 = optsRef.current
    const ri = rowIndex.get(addr.rowId)
    if (ri != null) o2.scrollToRow?.(ri)
    requestAnimationFrame(() => {
      const root = o2.containerRef.current
      const cell = root?.querySelector(`[data-cell="${CSS.escape(cellAttr(addr.rowId, addr.colKey))}"]`)
      ;(cell as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [rowIndex])

  // ---- 書き込み ---------------------------------------------------------------

  /** 範囲の書き込みをまとめて、件数と飛ばした理由をトーストに出す。 */
  const commit = useCallback(
    (edits: CellEdit[], skipped: string[], label: string, verb: string) => {
      const real = edits.filter((e) => e.before !== e.after && !(e.before == null && e.after == null))
      if (real.length > 0) optsRef.current.apply(real, label)
      const reasons = [...new Set(skipped)]
      if (real.length === 0 && reasons.length === 0) return
      const head = real.length > 0 ? `${real.length}セルを${verb}（Ctrl+Z で元に戻せます）` : `${verb}セルはありませんでした`
      if (reasons.length > 0) {
        toast.show(
          `${head}。${skipped.length}セルは入れられないため飛ばしました：${reasons.slice(0, 3).join('、')}${reasons.length > 3 ? ' など' : ''}`,
          'warn',
          7000,
        )
      } else {
        toast.show(head, 'info', 3000)
      }
    },
    [],
  )

  const clearCells = useCallback(() => {
    const r = rectRef.current
    const o2 = optsRef.current
    if (!r) return
    const edits: CellEdit[] = []
    const skipped: string[] = []
    for (let ri = r.r0; ri <= r.r1; ri++) {
      for (let ci = r.c0; ci <= r.c1; ci++) {
        const rowId = o2.rowIds[ri]
        const colKey = o2.colKeys[ci]
        const ro = o2.readonlyReason(colKey)
        const before = o2.getValue(rowId, colKey)
        if (before == null || before === '') continue
        if (ro) {
          skipped.push(ro)
          continue
        }
        // 「空にする」は「空文字を貼る」と同じ扱い（ID のように空にできない列は断る）。
        const p = o2.parse(colKey, '')
        if (!p.ok) {
          skipped.push(p.reason)
          continue
        }
        edits.push({ rowId, colKey, before, after: p.value })
      }
    }
    commit(edits, skipped, `${edits.length}セルを空に`, '空にしました')
  }, [commit])

  /** 範囲の先頭行を、範囲の残りの行へコピー（Ctrl+D）。 */
  const fillDownCopy = useCallback(() => {
    const r = rectRef.current
    const o2 = optsRef.current
    if (!r || r.r1 === r.r0) return
    const edits: CellEdit[] = []
    const skipped: string[] = []
    for (let ci = r.c0; ci <= r.c1; ci++) {
      const colKey = o2.colKeys[ci]
      const ro = o2.readonlyReason(colKey)
      const v = o2.getValue(o2.rowIds[r.r0], colKey)
      for (let ri = r.r0 + 1; ri <= r.r1; ri++) {
        if (ro) {
          skipped.push(ro)
          continue
        }
        const rowId = o2.rowIds[ri]
        edits.push({ rowId, colKey, before: o2.getValue(rowId, colKey), after: v })
      }
    }
    commit(edits, skipped, '下方向へコピー', '埋めました')
  }, [commit])

  /** フィルハンドルを target 行まで伸ばしたときの書き込み。 */
  const fillTo = useCallback(
    (targetRow: number) => {
      const r = rectRef.current
      const o2 = optsRef.current
      if (!r) return
      const down = targetRow > r.r1
      const up = targetRow < r.r0
      if (!down && !up) return
      const count = down ? targetRow - r.r1 : r.r0 - targetRow
      const edits: CellEdit[] = []
      const skipped: string[] = []
      for (let ci = r.c0; ci <= r.c1; ci++) {
        const colKey = o2.colKeys[ci]
        const ro = o2.readonlyReason(colKey)
        const source: CellValue[] = []
        for (let ri = r.r0; ri <= r.r1; ri++) source.push(o2.getValue(o2.rowIds[ri], colKey))
        const values =
          o2.fillMode(colKey) === 'series'
            ? fillSeries(source, count, up)
            : // コピーは元の並びを繰り返す（上へ伸ばすときは下から遡って繰り返す）。
              Array.from({ length: count }, (_, i) =>
                up ? source[source.length - 1 - (i % source.length)] : source[i % source.length],
              )
        for (let i = 0; i < count; i++) {
          const ri = down ? r.r1 + 1 + i : r.r0 - 1 - i
          if (ri < 0 || ri >= o2.rowIds.length) break
          if (ro) {
            skipped.push(ro)
            continue
          }
          const rowId = o2.rowIds[ri]
          edits.push({ rowId, colKey, before: o2.getValue(rowId, colKey), after: values[i] })
        }
      }
      // 伸ばした先まで選択を広げる（Excel と同じ）。
      const s = selRef.current
      if (s) {
        const edgeRow = o2.rowIds[Math.max(0, Math.min(o2.rowIds.length - 1, targetRow))]
        const a = { rowId: o2.rowIds[down ? r.r0 : r.r1], colKey: o2.colKeys[r.c0] }
        setSel({ anchor: a, focus: { rowId: edgeRow, colKey: o2.colKeys[r.c1] } })
      }
      commit(edits, skipped, 'フィル', '埋めました')
    },
    [commit],
  )

  // ---- マウス -----------------------------------------------------------------

  useEffect(() => {
    const onUp = () => {
      const d = dragRef.current
      dragRef.current = null
      if (d?.moved) {
        // 動かして離した場所が元のセルだと click が来る。それを編集にしない。
        suppressClickRef.current = true
        window.setTimeout(() => (suppressClickRef.current = false), 0)
      }
      const f = fillRef.current
      if (f) {
        setFill(null)
        fillTo(f.targetRow)
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [fillTo])

  /** セルの外枠に付ける属性とハンドラ。 */
  const cellProps = useCallback(
    (rowId: string, colKey: string) => ({
      'data-cell': cellAttr(rowId, colKey),
      onMouseDownCapture: (e: React.MouseEvent) => {
        const o2 = optsRef.current
        if (!o2.enabled || e.button !== 0) return
        if (isEditableTarget(e.target)) return // 編集中の入力欄は触らない
        // フィルハンドル（■）を掴んだときは選択し直さない。セル側のこの処理は capture で
        // ■より先に走るので、ここで外しておかないと選択が1セルに縮んでしまう。
        if ((e.target as HTMLElement).closest?.('[data-fill-handle]')) return
        const addr = { rowId: String(rowId), colKey: String(colKey) }
        o2.onActivate?.()
        if (e.shiftKey && selRef.current) {
          e.preventDefault()
          suppressClickRef.current = true
          setSel({ anchor: selRef.current.anchor, focus: addr })
          focusContainer()
          return
        }
        // 文字の選択（青い反転）が範囲ドラッグに重ならないように。
        e.preventDefault()
        setSel({ anchor: addr, focus: addr })
        dragRef.current = { start: addr, moved: false }
        focusContainer()
      },
      onMouseEnter: () => {
        const addr = { rowId: String(rowId), colKey: String(colKey) }
        const f = fillRef.current
        if (f) {
          const ri = rowIndex.get(addr.rowId)
          if (ri != null && ri !== f.targetRow) setFill({ targetRow: ri })
          return
        }
        const d = dragRef.current
        if (!d) return
        if (d.start.rowId !== addr.rowId || d.start.colKey !== addr.colKey) d.moved = true
        setSel((prev) => (prev ? { anchor: prev.anchor, focus: addr } : prev))
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          e.stopPropagation()
          e.preventDefault()
        }
      },
    }),
    [focusContainer, rowIndex],
  )

  /** 選択範囲の右下の■（フィルハンドル）に付けるハンドラ。 */
  const fillHandleProps = useMemo(
    () => ({
      onMouseDown: (e: React.MouseEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const r = rectRef.current
        if (r) setFill({ targetRow: r.r1 })
      },
      title: 'ドラッグで上下に埋める（数値・日付・末尾が数字の文字は続きの値）',
      'data-fill-handle': true,
    }),
    [],
  )

  // ---- キーボード・クリップボード（入れ物の要素に付ける） -----------------------

  const move = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const s = selRef.current
      const o2 = optsRef.current
      if (!s) return
      const ri = rowIndex.get(s.focus.rowId)
      const ci = colIndex.get(s.focus.colKey)
      if (ri == null || ci == null) return
      const nr = Math.max(0, Math.min(o2.rowIds.length - 1, ri + dr))
      const nc = Math.max(0, Math.min(o2.colKeys.length - 1, ci + dc))
      const focus = { rowId: o2.rowIds[nr], colKey: o2.colKeys[nc] }
      setSel(extend ? { anchor: s.anchor, focus } : { anchor: focus, focus })
      scrollCellIntoView(focus)
    },
    [rowIndex, colIndex, scrollCellIntoView],
  )

  /** 編集を Enter で確定したあと: 1つ下のセルへ移って、続けて編集する。 */
  const enterNext = useCallback(
    (from: CellAddr) => {
      const o2 = optsRef.current
      const ri = rowIndex.get(String(from.rowId))
      if (ri == null) return
      const next = ri + 1
      if (next >= o2.rowIds.length) {
        setSel({ anchor: from, focus: from })
        focusContainer()
        return
      }
      const addr = { rowId: o2.rowIds[next], colKey: String(from.colKey) }
      setSel({ anchor: addr, focus: addr })
      scrollCellIntoView(addr)
      // 描画（仮想化で行が出てくる）を待ってから開く。
      window.setTimeout(() => {
        if (o2.readonlyReason(addr.colKey)) {
          focusContainer()
          return
        }
        openEditor(addr)
      }, 30)
    },
    [rowIndex, scrollCellIntoView, openEditor, focusContainer],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const s = selRef.current
      const o2 = optsRef.current
      if (!s || !o2.enabled || isEditableTarget(e.target)) return false
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        fillDownCopy()
        return true
      }
      if (ctrl || e.altKey) return false
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          move(-1, 0, e.shiftKey)
          return true
        case 'ArrowDown':
          e.preventDefault()
          move(1, 0, e.shiftKey)
          return true
        case 'ArrowLeft':
          e.preventDefault()
          move(0, -1, e.shiftKey)
          return true
        case 'ArrowRight':
        case 'Tab':
          e.preventDefault()
          move(0, e.key === 'Tab' && e.shiftKey ? -1 : 1, e.key !== 'Tab' && e.shiftKey)
          return true
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          clearCells()
          return true
        case 'Escape':
          e.preventDefault()
          setSel(null)
          return true
        case 'Enter':
        case 'F2':
          e.preventDefault()
          if (!o2.readonlyReason(s.focus.colKey)) openEditor(s.focus)
          return true
      }
      if (e.key.length === 1 && o2.seedable(s.focus.colKey) && !o2.readonlyReason(s.focus.colKey)) {
        e.preventDefault()
        setSel({ anchor: s.focus, focus: s.focus })
        openEditor(s.focus, e.key)
        return true
      }
      return false
    },
    [fillDownCopy, move, clearCells, openEditor],
  )

  const onCopy = useCallback((e: React.ClipboardEvent): boolean => {
    const r = rectRef.current
    const o2 = optsRef.current
    if (!r || !o2.enabled) return false
    // 文字の入力欄の中なら、その文字のコピー（ブラウザに任せる）。プルダウン・日付の
    // 編集欄は文字を選べないので、セルのコピーとして扱う（クリックすると編集欄が
    // 開く作りなので、ここで拾わないと「担当や日付はコピーできない」ことになる）。
    const kind = editorKind(e.target)
    if (kind === 'text') return false
    if (kind === 'opaque') closeEditor(e.target as HTMLElement)
    const m: string[][] = []
    for (let ri = r.r0; ri <= r.r1; ri++) {
      const line: string[] = []
      for (let ci = r.c0; ci <= r.c1; ci++) line.push(o2.getText(o2.rowIds[ri], o2.colKeys[ci]))
      m.push(line)
    }
    e.clipboardData.setData('text/plain', toTsv(m))
    e.preventDefault()
    const n = (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1)
    toast.show(`${n}セルをコピーしました`, 'info', 2000)
    return true
  }, [])

  const onPaste = useCallback(
    (e: React.ClipboardEvent): boolean => {
      const r = rectRef.current
      const o2 = optsRef.current
      if (!r || !o2.enabled) return false
      const target = e.target as HTMLElement | null
      const text = e.clipboardData.getData('text/plain')
      if (!text) return false
      const matrix = parseTsv(text)
      // 文字の入力欄（編集中）に1つの値を貼るのは、文字の編集なのでブラウザに任せる。
      // ただし Excel から複数セルを貼ったときは、編集中のセルを起点にした範囲の貼り付け
      // にする（1セルにタブ入りの文字が入っても意味が無い）。プルダウン・日付の編集欄は
      // 文字を受け取れないので、いつでもセルへの貼り付け。
      const kind = editorKind(target)
      const multi = matrix.length > 1 || (matrix[0]?.length ?? 0) > 1
      if (kind === 'text' && (!multi || target?.tagName === 'TEXTAREA')) return false
      e.preventDefault()
      if (kind !== 'none' && target) closeEditor(target)
      if (matrix.length === 0) return true
      // 1セルを広い範囲に貼ると、範囲の全部に入る（Excel と同じ）。
      const single = matrix.length === 1 && matrix[0].length === 1
      const rows = single ? r.r1 - r.r0 + 1 : matrix.length
      const cols = single ? r.c1 - r.c0 + 1 : Math.max(...matrix.map((l) => l.length))
      const edits: CellEdit[] = []
      const skipped: string[] = []
      let unlisted = 0
      let lastRow = r.r0
      let lastCol = r.c0
      for (let dr = 0; dr < rows; dr++) {
        const ri = r.r0 + dr
        if (ri >= o2.rowIds.length) break
        for (let dc = 0; dc < cols; dc++) {
          const ci = r.c0 + dc
          if (ci >= o2.colKeys.length) break
          const raw = single ? matrix[0][0] : (matrix[dr]?.[dc] ?? '')
          const rowId = o2.rowIds[ri]
          const colKey = o2.colKeys[ci]
          lastRow = Math.max(lastRow, ri)
          lastCol = Math.max(lastCol, ci)
          const ro = o2.readonlyReason(colKey)
          if (ro) {
            if (raw.trim() !== '') skipped.push(ro)
            continue
          }
          const p = o2.parse(colKey, raw)
          if (!p.ok) {
            skipped.push(p.reason)
            continue
          }
          if (p.unlisted) unlisted++
          edits.push({ rowId, colKey, before: o2.getValue(rowId, colKey), after: p.value })
        }
      }
      setSel({
        anchor: { rowId: o2.rowIds[r.r0], colKey: o2.colKeys[r.c0] },
        focus: { rowId: o2.rowIds[lastRow], colKey: o2.colKeys[lastCol] },
      })
      commit(edits, skipped, '貼り付け', '貼り付けました')
      if (unlisted > 0)
        toast.show(
          `プルダウンの選択肢に無い値が ${unlisted} セルあります（「選択肢に未登録」と点線で表示されます。列の設定から選択肢に追加できます）`,
          'warn',
          7000,
        )
      return true
    },
    [commit],
  )

  // 編集を Esc／Enter で閉じると、入力欄が消えてキーボードの行き先が無くなる。
  // 選択が残っていれば、入れ物にフォーカスを戻して矢印キー等を効かせ続ける。
  // 入力欄が DOM から消えるときは focusout が来ないブラウザがあるので、編集を閉じる
  // キー（Esc/Enter/Tab）とプルダウンの選択（change）の直後にも確かめる。
  // 入れ物の要素は後から現れる（読み込み後）ので、要素そのものを依存にする。
  const rootEl = o.containerRef.current
  useEffect(() => {
    const root = rootEl
    if (!root) return
    const restoreSoon = () => {
      window.setTimeout(() => {
        if (!selRef.current) return
        const a = document.activeElement
        if (!a || a === document.body) root.focus({ preventScroll: true })
      }, 0)
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'Enter' || e.key === 'Tab') && isEditableTarget(e.target))
        restoreSoon()
    }
    root.addEventListener('focusout', restoreSoon)
    root.addEventListener('keydown', onKey, true)
    root.addEventListener('change', restoreSoon, true)
    return () => {
      root.removeEventListener('focusout', restoreSoon)
      root.removeEventListener('keydown', onKey, true)
      root.removeEventListener('change', restoreSoon, true)
    }
  }, [rootEl])

  /** 描画用: そのセルが選択範囲のどこにあるか。 */
  const cellState = useCallback(
    (ri: number, ci: number) => {
      const r = rect
      if (!r) return null
      const inSel = ri >= r.r0 && ri <= r.r1 && ci >= r.c0 && ci <= r.c1
      const f = fill
      const inFill =
        !!f &&
        ci >= r.c0 &&
        ci <= r.c1 &&
        ((f.targetRow > r.r1 && ri > r.r1 && ri <= f.targetRow) ||
          (f.targetRow < r.r0 && ri < r.r0 && ri >= f.targetRow))
      if (!inSel && !inFill) return null
      return {
        inSel,
        inFill,
        top: ri === r.r0,
        bottom: ri === r.r1,
        left: ci === r.c0,
        right: ci === r.c1,
        /** フィルハンドルを置くセル（右下）。 */
        handle: inSel && ri === r.r1 && ci === r.c1,
      }
    },
    [rect, fill],
  )

  return {
    sel,
    rect,
    clear,
    setSel,
    cellProps,
    fillHandleProps,
    cellState,
    onKeyDown,
    onCopy,
    onPaste,
    enterNext,
    filling: fill != null,
  }
}

/** 選択の見た目（背景＋外周の線）。cellState の結果から box-shadow を作る。 */
export function selectionStyle(
  st: ReturnType<ReturnType<typeof useCellRange>['cellState']>,
): React.CSSProperties | undefined {
  if (!st) return undefined
  const c = 'var(--green)'
  const parts: string[] = []
  if (st.inSel) {
    if (st.top) parts.push(`inset 0 2px 0 ${c}`)
    if (st.bottom) parts.push(`inset 0 -2px 0 ${c}`)
    if (st.left) parts.push(`inset 2px 0 0 ${c}`)
    if (st.right) parts.push(`inset -2px 0 0 ${c}`)
  }
  return {
    boxShadow: parts.join(', ') || undefined,
    background: st.inFill ? 'rgba(38,107,83,0.06)' : 'rgba(38,107,83,0.09)',
    outline: st.inFill ? '1px dashed var(--green)' : undefined,
    outlineOffset: st.inFill ? -1 : undefined,
  }
}
