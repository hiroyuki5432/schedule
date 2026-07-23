// Simple tab strip. Used to break long settings pages into a few sections so
// people stop scrolling past the thing they came for.

import { cn } from '@/lib/format'

export interface TabDef<K extends string> {
  key: K
  label: string
  /** Optional one-line hint shown under the strip for the active tab. */
  hint?: string
}

export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: ReadonlyArray<TabDef<K>>
  active: K
  onChange: (key: K) => void
  className?: string
}) {
  const current = tabs.find((t) => t.key === active)
  return (
    <div className={className}>
      <div
        role="tablist"
        className="flex flex-wrap gap-1 border-b border-[var(--line)]"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px border-b-2 px-3.5 py-2 text-[13px] transition-colors',
              t.key === active
                ? 'border-[var(--green)] font-medium text-[var(--green-d)]'
                : 'border-transparent text-[var(--ink3)] hover:text-[var(--ink2)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current?.hint && (
        <p className="mt-2 text-[11.5px] text-[var(--ink3)]">{current.hint}</p>
      )}
    </div>
  )
}
