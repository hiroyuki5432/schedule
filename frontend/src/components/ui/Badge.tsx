import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/format'

interface BadgeProps {
  children: ReactNode
  color?: string
  bg?: string
  className?: string
}

export function Badge({ children, color, bg, className }: BadgeProps) {
  const style: CSSProperties = {
    color: color ?? 'var(--ink2)',
    background: bg ?? 'var(--line2)',
  }
  return (
    <span
      className={cn(
        'inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium',
        className,
      )}
      style={style}
    >
      {children}
    </span>
  )
}
