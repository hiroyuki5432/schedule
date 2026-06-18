import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle?: string
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <div className="flex items-start justify-between gap-3 px-[22px] pb-3 pt-4">
      <div>
        <div className="text-[18px] font-semibold">{title}</div>
        {subtitle && (
          <div className="mt-0.5 text-[12px] text-[var(--ink3)]">{subtitle}</div>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
