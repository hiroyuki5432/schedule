import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/format'

type Variant = 'primary' | 'outline' | 'ghost'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--green-l)]'

const variants: Record<Variant, string> = {
  primary: 'bg-[var(--green)] text-white hover:bg-[var(--green-d)]',
  outline:
    'bg-[var(--surface)] text-[var(--ink2)] border border-[var(--line)] hover:bg-[var(--line2)]',
  ghost: 'bg-transparent text-[var(--ink2)] hover:bg-[var(--line2)]',
}

const sizes: Record<Size, string> = {
  sm: 'text-xs px-3 py-1.5',
  md: 'text-[12px] px-3.5 py-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
