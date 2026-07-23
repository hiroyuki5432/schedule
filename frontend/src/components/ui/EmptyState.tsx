// "Nothing here yet" panel.
//
// A brand-new sheet used to show an empty grid with no hint about what to do
// next. This says what the screen is for and offers the one or two actions that
// actually move things forward.

import type { ReactNode } from 'react'
import { cn } from '@/lib/format'

export function EmptyState({
  title,
  body,
  actions,
  compact,
  className,
}: {
  title: string
  /** One or two plain sentences — what this screen is for and what to do next. */
  body?: string
  actions?: ReactNode
  /** Inline variant for cards/tables (no border, no min height). */
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact
          ? 'px-5 py-8'
          : 'flex-1 rounded-[14px] border border-dashed border-[var(--line)] bg-[var(--surface)] px-6 py-14',
        className,
      )}
    >
      <div className="text-[14px] font-semibold text-[var(--ink)]">{title}</div>
      {body && (
        <p className="max-w-[460px] text-[12.5px] leading-relaxed text-[var(--ink3)]">{body}</p>
      )}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  )
}
