// "保存中… / 保存しました ✓" indicator.
//
// Cell edits save silently in the background, which leaves the user unsure
// whether anything happened. This watches every in-flight mutation (React
// Query's global counter) and confirms the write landed. Failures are not shown
// here — those already raise a toast from the mutation cache.

import { useEffect, useRef, useState } from 'react'
import { useIsMutating } from '@tanstack/react-query'
import { cn } from '@/lib/format'

/** How long the "saved" confirmation stays up after the last write settles. */
const FLASH_MS = 2200

export function SaveStatus({ className }: { className?: string }) {
  const pending = useIsMutating()
  const [saved, setSaved] = useState(false)
  const prevPending = useRef(0)

  useEffect(() => {
    const wasBusy = prevPending.current > 0
    prevPending.current = pending
    if (!wasBusy || pending !== 0) return
    setSaved(true)
    const t = window.setTimeout(() => setSaved(false), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [pending])

  if (pending === 0 && !saved) {
    // Reserve no space when idle — the toolbar shouldn't jump around.
    return null
  }

  return (
    <span
      aria-live="polite"
      className={cn(
        'flex items-center gap-1 whitespace-nowrap text-[11.5px]',
        pending > 0 ? 'text-[var(--ink3)]' : 'text-[var(--green-d)]',
        className,
      )}
    >
      {pending > 0 ? (
        <>
          <span className="h-[9px] w-[9px] animate-spin rounded-full border-[1.5px] border-[var(--line)] border-t-[var(--ink3)]" />
          保存中…
        </>
      ) : (
        <>✓ 保存しました</>
      )}
    </span>
  )
}
