// Renders the global toast stack (top-right). Subscribes to the module-level
// toast store so any code path (incl. the query client's conflict handler) can
// surface a message. Mounted once in main.tsx.

import { useEffect, useState } from 'react'
import { toast, type Toast } from '@/lib/toast'
import { cn } from '@/lib/format'
import { XIcon } from '@/components/ui/icons'

const KIND_STYLE: Record<Toast['kind'], string> = {
  info: 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink)]',
  success: 'border-[#BcD9C8] bg-[#E6F0DB] text-[#266B53]',
  warn: 'border-[#E7C9A8] bg-[#FBF0E2] text-[#8A5A20]',
  error: 'border-[#E7B6A8] bg-[#FAE6E0] text-[#A8442B]',
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([])
  useEffect(() => toast.subscribe(setItems), [])

  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[10000] flex w-[340px] max-w-[calc(100vw-32px)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-[11px] border px-3.5 py-2.5 text-[12.5px] shadow-lg',
            KIND_STYLE[t.kind],
          )}
        >
          <span className="min-w-0 flex-1 leading-snug">{t.message}</span>
          <button
            onClick={() => toast.dismiss(t.id)}
            className="flex-shrink-0 opacity-60 hover:opacity-100"
            aria-label="閉じる"
          >
            <XIcon className="h-[14px] w-[14px]" />
          </button>
        </div>
      ))}
    </div>
  )
}
