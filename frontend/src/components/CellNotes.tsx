// セルのメモ（要望: Excel のコメントのように、セルに一言残したい）。
//
//  * NoteMark   … メモのあるセルの右上に出す赤い三角（Excel と同じ目印）
//  * NoteTipHost / noteTip … セルにマウスを当てたときに横へ出すメモの吹き出し。
//                 1画面に1つだけ置き（main.tsx）、どのセルからでも呼べるようにする。
//  * NoteEditor … メモを書く・直す・消すダイアログ
//  * useSheetNotes … シートのメモを「行ID|セル」で引ける形にして持つ
//
// セルの指定（cell_key）は 列ID / '__id__'（ID）/ 'w:YYYY-MM-DD'（週次工数）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import type { CellNote } from '@/types/api'

export const noteKey = (rowId: string | number, cellKey: string) => `${rowId}|${cellKey}`
export const weekCellKey = (weekIso: string) => `w:${weekIso}`

/** シートのメモ一覧と、書き込み。 */
export function useSheetNotes(sheetId: string) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['notes', sheetId],
    queryFn: () => api.getNotes(sheetId),
  })
  const byCell = useMemo(() => {
    const m = new Map<string, CellNote>()
    for (const n of q.data ?? []) m.set(noteKey(n.row_id, n.cell_key), n)
    return m
  }, [q.data])
  const save = useMutation({
    mutationFn: (v: { rowId: string; cellKey: string; text: string }) =>
      api.putNote(v.rowId, v.cellKey, v.text),
    onSuccess: (_res, v) => {
      void qc.invalidateQueries({ queryKey: ['notes', sheetId] })
      toast.show(v.text.trim() ? 'メモを保存しました' : 'メモを削除しました', 'success', 2000)
    },
    onError: (e) =>
      toast.show(`メモを保存できませんでした：${e instanceof Error ? e.message : ''}`, 'error'),
  })
  return { byCell, save }
}

// ---- 目印 -------------------------------------------------------------------

/** 親（position: relative）の右上に出す三角。 */
export function NoteMark() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-0 top-0 z-[3] h-0 w-0"
      style={{
        borderTop: '7px solid #D9534F',
        borderLeft: '7px solid transparent',
      }}
    />
  )
}

// ---- 吹き出し ---------------------------------------------------------------

interface TipState {
  note: CellNote
  rect: { left: number; right: number; top: number; bottom: number }
}
let tipState: TipState | null = null
let hideTimer: number | undefined
const tipListeners = new Set<(s: TipState | null) => void>()
function emitTip(s: TipState | null) {
  tipState = s
  for (const l of tipListeners) l(s)
}

export const noteTip = {
  /** セル（要素）の右横にメモを出す。 */
  show(el: Element, note: CellNote) {
    window.clearTimeout(hideTimer)
    if (tipState?.note.id === note.id && tipState.note.updated_at === note.updated_at) return
    const r = el.getBoundingClientRect()
    emitTip({ note, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
  },
  hide() {
    window.clearTimeout(hideTimer)
    // セルから吹き出しへマウスを動かす間に消えないよう、少しだけ待つ。
    hideTimer = window.setTimeout(() => emitTip(null), 120)
  },
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function NoteTipHost() {
  const [s, setS] = useState<TipState | null>(tipState)
  useEffect(() => {
    tipListeners.add(setS)
    return () => {
      tipListeners.delete(setS)
    }
  }, [])
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!s) {
      setPos(null)
      return
    }
    const w = ref.current?.offsetWidth ?? 260
    const h = ref.current?.offsetHeight ?? 60
    // 右に出す。入らなければ左。下にはみ出すなら上へずらす。
    let x = s.rect.right + 6
    if (x + w > window.innerWidth - 8) x = Math.max(8, s.rect.left - w - 6)
    const y = Math.min(s.rect.top, window.innerHeight - h - 8)
    setPos({ x, y: Math.max(8, y) })
  }, [s])
  if (!s) return null
  return (
    <div
      ref={ref}
      onMouseEnter={() => window.clearTimeout(hideTimer)}
      onMouseLeave={() => noteTip.hide()}
      className="fixed z-[60] max-w-[300px] whitespace-pre-wrap break-words rounded-[8px] border border-[#E7D9A8] bg-[#FFF9E0] px-2.5 py-2 text-[12px] leading-relaxed text-[#3a382f] shadow-[0_6px_18px_rgba(0,0,0,0.14)]"
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {s.note.text}
      <div className="mt-1 text-[10.5px] text-[#8a8466]">
        {s.note.updated_by_name} ・ {fmtWhen(s.note.updated_at)}
      </div>
    </div>
  )
}

/** セルの要素に付けるハンドラ（メモがあるときだけ吹き出しを出す）。
 *  onMouseEnter は範囲選択（useCellRange.cellProps）が使うので、重ならない
 *  onMouseOver を使う（同じメモなら show は何もしない）。 */
export function noteHoverProps(note: CellNote | undefined) {
  if (!note) return {}
  return {
    onMouseOver: (e: React.MouseEvent) => noteTip.show(e.currentTarget, note),
    onMouseLeave: () => noteTip.hide(),
  }
}

// ---- 編集 -------------------------------------------------------------------

export function NoteEditor({
  title,
  note,
  onSave,
  onClose,
}: {
  /** どのセルのメモか（例: 「P26-001 ・ 担当」）。 */
  title: string
  note: CellNote | undefined
  onSave: (text: string) => void
  onClose: () => void
}) {
  const [val, setVal] = useState(note?.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const save = () => {
    onSave(val)
    onClose()
  }
  return (
    <Modal title={`メモ — ${title}`} onClose={onClose} widthClass="w-[440px]">
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            save()
          }
        }}
        rows={5}
        maxLength={2000}
        placeholder="例: 客先の回答待ち（10/10 予定）"
        className="w-full resize-y rounded-[8px] border border-[var(--line)] bg-[var(--surface)] p-2.5 text-[13px] leading-relaxed outline-none focus:border-[var(--green-l)]"
      />
      {note && (
        <div className="mt-1 text-[11px] text-[var(--ink3)]">
          最終更新: {note.updated_by_name} ・ {fmtWhen(note.updated_at)}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-[var(--ink3)]">Ctrl/⌘+Enter で保存 ・ Esc で取消</span>
        <div className="flex gap-2">
          {note && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onSave('')
                onClose()
              }}
            >
              メモを削除
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            キャンセル
          </Button>
          <Button size="sm" onClick={save}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}
