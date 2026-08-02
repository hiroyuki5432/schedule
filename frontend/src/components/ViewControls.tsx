// Toolbar controls shared by the schedule and the table view, so 検索 and
// 既定の表示 behave identically on both (要望: テーブルも検索やフィルタの既定ボタン).
import { useEffect, useRef, useState } from 'react'
import { SearchIcon, XIcon } from '@/components/ui/icons'

/** Full-text search box over every column. */
export function SearchBox({
  value,
  onChange,
  placeholder = '検索（全列）',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-1 rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2">
      <SearchIcon className="h-[14px] w-[14px] flex-shrink-0 text-[var(--ink3)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-[150px] bg-transparent py-1.5 text-[12px] outline-none"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="flex-shrink-0 text-[var(--ink3)] hover:text-[var(--ink)]"
          title="検索クリア"
        >
          <XIcon className="h-[14px] w-[14px]" />
        </button>
      )}
    </div>
  )
}

/** 既定の表示 control: the main button restores the saved filter/sort (or clears
 *  everything when none is saved); the ▾ half saves the current view as the
 *  default or deletes it. Saved per sheet, in this browser. */
export function DefaultViewButton({
  hasDefault,
  onReset,
  onSave,
  onClear,
}: {
  hasDefault: boolean
  onReset: () => void
  onSave: () => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const item =
    'block w-full whitespace-nowrap px-3 py-1.5 text-left text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)] disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center overflow-hidden rounded-[9px] border border-[var(--line)] bg-[var(--surface)]">
        <button
          onClick={onReset}
          title={
            hasDefault
              ? 'この画面の絞り込み・並べ替えを、保存した既定に戻す'
              : '絞り込み・並べ替えをすべて解除（「今の表示を既定にする」で既定を登録できます）'
          }
          className="px-3 py-1.5 text-[12px] text-[var(--ink2)] hover:bg-[var(--line2)]"
        >
          既定に戻す
        </button>
        <button
          onClick={() => setOpen((o) => !o)}
          title="既定の表示を設定"
          aria-label="既定の表示メニュー"
          className="border-l border-[var(--line)] px-2 py-1.5 text-[10px] leading-none text-[var(--ink3)] hover:bg-[var(--line2)]"
        >
          ▾
        </button>
      </div>
      {open && (
        <div className="absolute right-0 z-50 mt-1 overflow-hidden rounded-[10px] border border-[var(--line)] bg-[var(--surface)] py-1 shadow-lg">
          <button
            className={item}
            onClick={() => {
              setOpen(false)
              onSave()
            }}
          >
            今の表示を既定にする
          </button>
          <button
            className={item}
            disabled={!hasDefault}
            onClick={() => {
              setOpen(false)
              onClear()
            }}
          >
            既定を削除
          </button>
        </div>
      )}
    </div>
  )
}
