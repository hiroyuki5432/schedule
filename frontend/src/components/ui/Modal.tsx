// Lightweight centered modal, matching CellEditor's overlay look. Click the
// backdrop or press Escape to close.
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/format'

interface Props {
  title?: ReactNode
  onClose: () => void
  children: ReactNode
  /** Tailwind width class, default w-[320px]. */
  widthClass?: string
}

export function Modal({ title, onClose, children, widthClass = 'w-[320px]' }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'max-h-[88vh] overflow-auto rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-5',
          widthClass,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="mb-3 text-[14px] font-semibold text-[var(--ink)]">{title}</div>
        )}
        {children}
      </div>
    </div>
  )
}
