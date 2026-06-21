// Phase color legend + markers. DYNAMIC: shows the sheet's default milestone
// phases (configured in settings) plus any distinct milestone {name,color}
// actually present across the rows, plus the computed 遅延 (late) state. Includes
// a small "?" help tooltip explaining where the colors come from.

import { useMemo, useState } from 'react'
import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import { LATE_FILL } from '@/lib/gantt'
import { HelpIcon } from '@/components/ui/icons'
import type { DefaultMilestone } from '@/types/api'

interface Props {
  rows: ScheduleRowModel[]
  /** Sheet-level default phases (shown so colors are visible before assigning). */
  defaultMilestones?: DefaultMilestone[]
}

interface Phase {
  label: string
  color: string
}

const LATE_COLOR = LATE_FILL

export function Legend({ rows, defaultMilestones = [] }: Props) {
  const phases = useMemo<Phase[]>(() => {
    // Show ONLY the sheet's default phases (configured in settings). Per-row
    // milestones inherit these colors by name, so the legend stays the single
    // source of truth for what each color means.
    const seen = new Map<string, string>()
    for (const d of defaultMilestones) {
      const label = d.name?.trim()
      if (label && !seen.has(label)) seen.set(label, d.color || 'var(--p-neutral)')
    }
    const out: Phase[] = [...seen.entries()].map(([label, color]) => ({ label, color }))
    // Only surface 遅延 when a row actually overshot a not-done boundary today.
    const hasLate = rows.some((r) => r.gantt.cells.some((c) => c?.late))
    if (hasLate) out.push({ label: '遅延（節目超過）', color: LATE_COLOR })
    return out
  }, [rows, defaultMilestones])

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[22px] pb-2.5 text-[12px] text-[var(--ink2)]">
      {phases.length === 0 ? (
        <Item>
          <span className="text-[var(--ink3)]">
            凡例の色は設定画面の「既定マイルストン（フェーズ）」で定義します。
          </span>
        </Item>
      ) : (
        phases.map((p) => (
          <Item key={p.label}>
            <Sw color={p.color} />
            {p.label}
          </Item>
        ))
      )}
      <Item>
        <span className="flex flex-col items-center leading-none">
          <span className="text-[8px] text-[#8a8778]">8</span>
          <span className="h-px w-3" style={{ background: 'rgba(51,50,44,.14)' }} />
          <span className="text-[8px] font-semibold text-[#33322c]">10</span>
        </span>
        週セル：上＝予定 / 下＝実績（実績が予定超過＝赤）
      </Item>
      <Item>
        <span
          className="h-[9px] w-[9px] border-[1.6px] border-[var(--ink)] bg-white"
          style={{ transform: 'rotate(45deg)' }}
        />
        予定（中空）
        <span
          className="ml-1.5 h-[9px] w-[9px] border-[1.6px] border-[var(--ink)] bg-[var(--ink)]"
          style={{ transform: 'rotate(45deg)' }}
        />
        実績（塗り）＝マイルストン
      </Item>
      <Item>
        <span className="font-semibold text-[var(--accent)]">20</span>
        変化点（今週の断面から変更＝文字色）
      </Item>
      <HelpButton />
    </div>
  )
}

function Sw({ color }: { color: string }) {
  return <span className="h-3 w-3 rounded-[3px]" style={{ background: color }} />
}

function Item({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1.5">{children}</div>
}

function HelpButton() {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label="フェーズの色について"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--ink3)] hover:bg-[var(--line2)] hover:text-[var(--ink2)]"
      >
        <HelpIcon className="h-[15px] w-[15px]" />
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-40 w-[240px] rounded-[10px] border border-[var(--line)] bg-[var(--ink)] px-3 py-2 text-[11.5px] leading-relaxed text-white shadow-lg">
          色は設定画面の「既定マイルストン」で定義し、各行はその色を引き継ぎます（◇で日付・達成を設定）。遅延=最後の節目を過ぎて未達成。変化点=今週の断面（週初に自動取得）から工数を変えた所＝編集した週だけ赤。
        </div>
      )}
    </div>
  )
}
