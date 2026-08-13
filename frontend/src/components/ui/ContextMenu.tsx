// 右クリックメニュー（要望: 行削除が右クリックでできない）。
//
// Excel を触っている人は、行の上で右クリックすれば「削除」が出るものと思っている。
// 行の端に出るアイコンを探させるより、そこに置くほうが速い。
//
// 画面の端でも切れないように、開いた後に実寸を測って内側へ寄せる。
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/format'

export interface MenuItem {
  key: string
  label: ReactNode
  onClick: () => void
  /** 赤字（削除など、取り消せない操作）。 */
  danger?: boolean
  disabled?: boolean
  /** この項目の上に区切り線を引く。 */
  separatorBefore?: boolean
  /** 右端に出す補足（ショートカットなど）。 */
  hint?: string
}

export interface MenuAnchor {
  x: number
  y: number
}

export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: MenuAnchor
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuAnchor>(at)

  // 実寸が分かってから、はみ出したぶんだけ内側へ。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4))
    const y = Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4))
    setPos({ x, y })
  }, [at])

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // capture: メニューの外の onClick より先に閉じる。
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    // スクロールで置いていかれると、行と関係ない場所に浮いたままになる。
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[60] min-w-[190px] rounded-[10px] border border-[var(--line)] bg-[var(--surface)] py-1 shadow-[0_8px_24px_rgba(0,0,0,0.14)]"
    >
      {items.map((it) => (
        <div key={it.key}>
          {it.separatorBefore && <div className="my-1 border-t border-[var(--line2)]" />}
          <button
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick()
            }}
            className={cn(
              'flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12.5px]',
              it.disabled
                ? 'cursor-default text-[var(--line)]'
                : it.danger
                  ? 'text-[#A8442B] hover:bg-[#FAE6E0]'
                  : 'text-[var(--ink)] hover:bg-[var(--line2)]',
            )}
          >
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-[10.5px] text-[var(--ink3)]">{it.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  )
}
