// Loading placeholders.
//
// A blank panel with 読み込み中… reads as "nothing here"; a greyed-out shape of
// the thing that's coming reads as "almost ready", which is what people expect
// from a spreadsheet-like screen.

import { cn } from '@/lib/format'

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-[5px] bg-[var(--line2)]', className)}
      aria-hidden
    />
  )
}

/** Placeholder shaped like the weekly grid: frozen columns plus week cells. */
export function GridSkeleton({ rows = 9 }: { rows?: number }) {
  return (
    <div
      className="flex flex-1 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)]"
      role="status"
      aria-label="読み込み中"
    >
      <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[#F4F1E8] px-3 py-2.5">
        <Skeleton className="h-3 w-[120px]" />
        <Skeleton className="h-3 w-[80px]" />
        <Skeleton className="h-3 w-[64px]" />
        <div className="ml-auto flex gap-1.5">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-3.5" />
          ))}
        </div>
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="flex items-center gap-3 border-b border-[var(--line2)] px-3 py-2.5"
          style={{ opacity: 1 - r * 0.07 }}
        >
          <Skeleton className="h-3 w-[120px]" />
          <Skeleton className="h-3 w-[80px]" />
          <Skeleton className="h-3 w-[64px]" />
          <div className="ml-auto flex gap-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-3.5 w-3.5"
                /* Vary which cells are "filled" so it reads as a gantt, not a grid. */
              />
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">読み込み中…</span>
    </div>
  )
}

/** Placeholder for a plain table (dashboard, my tasks, table sheets). */
export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="px-5 py-3" role="status" aria-label="読み込み中">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 py-2.5" style={{ opacity: 1 - r * 0.1 }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-[90px]' : 'flex-1')} />
          ))}
        </div>
      ))}
      <span className="sr-only">読み込み中…</span>
    </div>
  )
}
