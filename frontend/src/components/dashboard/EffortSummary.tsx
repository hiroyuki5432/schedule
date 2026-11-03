// ダッシュボードの「工数の集計」タブ — 予定 vs 実績のカード、バーンアップ、
// 月別集計（締め期間ごと）、列でグループ化したピボット。
//
// グループ化は画面側の値で行う（ステータス・参照・数式は保存されない値なので、
// サーバの /aggregate で生の値を束ねると全部「空」に寄ってしまう）。
import { useMemo, useState } from 'react'
import { useOrg } from '@/hooks/useSheets'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Select } from '@/components/ui/Select'
import { fmtISO, fmtMD, MS_WEEK, parseDate } from '@/lib/dates'
import { monthPeriods, periodForDate } from '@/lib/period'
import type { MonthPeriod } from '@/lib/period'
import { shownValue } from '@/lib/dashboard'
import type { TaskInfo } from '@/lib/dashboard'
import type { ComputedResolver } from '@/lib/computed'
import type { AggregateRow, Column, Effort } from '@/types/api'

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}
// Hours are shown as whole numbers here (要望: 工数の表示は小数いらない). Only the
// display rounds — every total is still summed from the exact stored values.
const round1 = (x: number) => Math.round(x)

export function EffortSummary({
  columns,
  tasks,
  effort: allEffort,
  todayWeek,
  memberName,
  computedValue,
}: {
  columns: Column[]
  /** すべての行（親の行も含む。工数はその行そのものの分だけ）。 */
  tasks: TaskInfo[]
  effort: Effort[]
  todayWeek: string
  memberName: Map<string, string>
  computedValue: ComputedResolver
}) {
  const orgQ = useOrg()
  const closing = orgQ.data?.settings?.closing ?? {}

  // Group-by candidates: dropdown / member / status / text / 計算列.
  const groupable = useMemo(
    () =>
      columns.filter((c) =>
        ['dropdown', 'member', 'status', 'text', 'lookup', 'formula'].includes(c.type),
      ),
    [columns],
  )

  const [groupBy, setGroupBy] = useState<string>('')
  // Column ids are per sheet, so a remembered choice can't survive a sheet
  // switch — fall back to the first groupable column instead of querying a
  // column that doesn't exist here.
  const groupCol = groupable.find((c) => String(c.id) === groupBy) ?? groupable[0]

  // 行ごとの予定・実績を、グループ列の表示値で束ねる（以前のサーバ集計と同じく、
  // 件数は親の行も1件、工数はその行そのものの分）。
  const rows: AggregateRow[] = useMemo(() => {
    if (!groupCol) return []
    const groups = new Map<string, AggregateRow>()
    for (const t of tasks) {
      const key = shownValue(t.m, groupCol, memberName, computedValue)
      const g = groups.get(key) ?? { group: key, planned_sum: 0, actual_sum: 0, count: 0 }
      g.planned_sum += t.planned
      g.actual_sum += t.actual
      g.count += 1
      groups.set(key, g)
    }
    return [...groups.values()]
  }, [tasks, groupCol, memberName, computedValue])

  // Monthly close-periods spanning the effort data (要望: 月の集計をいつからいつまで).
  // Each week is assigned to the period containing its week_start.
  const periods = useMemo(() => {
    if (allEffort.length === 0) return []
    const weeks = allEffort.map((e) => e.week_start).sort()
    return monthPeriods(weeks[0], weeks[weeks.length - 1], closing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEffort, JSON.stringify(closing)])

  // Selected period ('' = 全期間).
  const [period, setPeriod] = useState<string>('')

  // Per-period planned/actual totals (for the monthly breakdown table).
  const periodTotals = useMemo(() => {
    const m = new Map<string, { p: number; a: number }>()
    for (const e of allEffort) {
      const lbl = periodForDate(e.week_start, closing).label
      const cur = m.get(lbl) ?? { p: 0, a: 0 }
      cur.p += num(e.planned_hours)
      cur.a += num(e.actual_hours)
      m.set(lbl, cur)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEffort, JSON.stringify(closing)])

  // Effort limited to the selected period (drives the summary + burn-up).
  const effort = useMemo(() => {
    if (!period) return allEffort
    return allEffort.filter((e) => periodForDate(e.week_start, closing).label === period)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allEffort, period, JSON.stringify(closing)])

  // Overall plan-vs-actual summary, derived from the (period-filtered) effort.
  const summary = useMemo(() => {
    let pAll = 0
    let aAll = 0
    let pToDate = 0
    let aToDate = 0
    for (const e of effort) {
      const p = num(e.planned_hours)
      const a = num(e.actual_hours)
      pAll += p
      aAll += a
      if (e.week_start <= todayWeek) {
        pToDate += p
        aToDate += a
      }
    }
    return {
      pAll,
      aAll,
      behind: pToDate - aToDate, // +: behind schedule, −: ahead
      progress: pAll > 0 ? aAll / pAll : 0,
    }
  }, [effort, todayWeek])

  return (
    <>
      {periods.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--ink2)]">
          集計期間（締め）:
          <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">全期間</option>
            {[...periods].reverse().map((p) => (
              <option key={p.label} value={p.label}>
                {periodLabel(p)}
              </option>
            ))}
          </Select>
          {period && (
            <span className="text-[11px] text-[var(--ink3)]">
              {(() => {
                const p = periods.find((x) => x.label === period)
                return p ? `${p.start} 〜 ${p.end}` : ''
              })()}
            </span>
          )}
        </div>
      )}

      <SummaryCards s={summary} />

      <Card>
        <CardHeader>
          <CardTitle>バーンアップ（累積 予定 vs 実績）</CardTitle>
        </CardHeader>
        <CardBody>
          <BurnUp effort={effort} todayWeek={todayWeek} />
        </CardBody>
      </Card>

      {periods.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>月別集計（締め期間ごと）</CardTitle>
          </CardHeader>
          <CardBody className="px-0 py-0">
            <MonthlyTable periods={periods} totals={periodTotals} />
          </CardBody>
        </Card>
      )}

      <div className="flex items-center gap-2 text-[12px] text-[var(--ink2)]">
        グループ化:
        <Select value={groupCol?.id ?? ''} onChange={(e) => setGroupBy(e.target.value)}>
          {groupable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>予定 vs 実績（グループ別）</CardTitle>
        </CardHeader>
        <CardBody>
          <BarChart rows={rows} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>ピボット表</CardTitle>
        </CardHeader>
        <CardBody className="px-0 py-0">
          <PivotTable rows={rows} />
        </CardBody>
      </Card>
    </>
  )
}

function periodLabel(p: MonthPeriod): string {
  return `${p.year}年${p.month}月度`
}

/** Per-period planned/actual breakdown (締め期間ごとの月別集計). */
function MonthlyTable({
  periods,
  totals,
}: {
  periods: MonthPeriod[]
  totals: Map<string, { p: number; a: number }>
}) {
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
          <th className="px-5 py-2.5 font-medium">月度</th>
          <th className="px-5 py-2.5 font-medium">期間</th>
          <th className="px-5 py-2.5 text-right font-medium">予定計</th>
          <th className="px-5 py-2.5 text-right font-medium">実績計</th>
          <th className="px-5 py-2.5 text-right font-medium">差（予定−実績）</th>
          <th className="px-5 py-2.5 text-right font-medium">消化率</th>
        </tr>
      </thead>
      <tbody>
        {[...periods].reverse().map((p) => {
          const t = totals.get(p.label) ?? { p: 0, a: 0 }
          const diff = round1(t.p - t.a)
          const rate = t.p > 0 ? t.a / t.p : 0
          return (
            <tr key={p.label} className="border-b border-[var(--line2)]">
              <td className="px-5 py-2.5">{periodLabel(p)}</td>
              <td className="px-5 py-2.5 text-[var(--ink3)]">
                {p.start} 〜 {p.end}
              </td>
              <td className="px-5 py-2.5 text-right">{round1(t.p)}h</td>
              <td className="px-5 py-2.5 text-right">{round1(t.a)}h</td>
              <td
                className="px-5 py-2.5 text-right"
                style={{ color: diff < 0 ? '#A8442B' : 'var(--ink2)' }}
              >
                {diff > 0 ? '+' : ''}
                {diff}h
              </td>
              <td className="px-5 py-2.5 text-right">{Math.round(rate * 100)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function SummaryCards({
  s,
}: {
  s: { pAll: number; aAll: number; behind: number; progress: number }
}) {
  const behindColor = s.behind > 0.05 ? '#A8442B' : '#266B53'
  const behindHint = s.behind > 0.05 ? '遅れ' : s.behind < -0.05 ? '前倒し' : '予定通り'
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="予定計（全期間）" value={`${round1(s.pAll)}h`} />
      <Stat label="実績計（これまで）" value={`${round1(s.aAll)}h`} />
      <Stat
        label="ビハインド（今日まで 予定−実績）"
        value={`${s.behind > 0 ? '+' : ''}${round1(s.behind)}h`}
        color={behindColor}
        hint={behindHint}
      />
      <Stat label="進捗率（実績/予定）" value={`${Math.round(s.progress * 100)}%`} />
    </div>
  )
}

function Stat({
  label,
  value,
  color,
  hint,
}: {
  label: string
  value: string
  color?: string
  hint?: string
}) {
  return (
    <Card>
      <CardBody className="px-4 py-3">
        <div className="text-[11px] leading-snug text-[var(--ink3)]">{label}</div>
        <div className="mt-1 text-[22px] font-semibold" style={color ? { color } : undefined}>
          {value}
        </div>
        {hint && <div className="text-[11px]" style={color ? { color } : undefined}>{hint}</div>}
      </CardBody>
    </Card>
  )
}

// Cumulative planned vs actual over weeks. Planned spans the whole range; actual
// stops at the current week (future actual is unknown). The gap at 今日 = behind.
function BurnUp({ effort, todayWeek }: { effort: Effort[]; todayWeek: string }) {
  const data = useMemo(() => {
    if (effort.length === 0) return null
    const byWeek = new Map<string, { p: number; a: number }>()
    for (const e of effort) {
      const cur = byWeek.get(e.week_start) ?? { p: 0, a: 0 }
      cur.p += num(e.planned_hours)
      cur.a += num(e.actual_hours)
      byWeek.set(e.week_start, cur)
    }
    const keys = [...byWeek.keys()].sort()
    const start = parseDate(keys[0]).getTime()
    const end = parseDate(keys[keys.length - 1]).getTime()
    const pts: Array<{ week: string; cumP: number; cumA: number | null }> = []
    let cumP = 0
    let cumA = 0
    for (let t = start; t <= end + 1; t += MS_WEEK) {
      const w = fmtISO(new Date(t))
      const d = byWeek.get(w) ?? { p: 0, a: 0 }
      cumP += d.p
      const future = w > todayWeek
      if (!future) cumA += d.a
      pts.push({ week: w, cumP, cumA: future ? null : cumA })
    }
    return { pts, max: Math.max(1, cumP) }
  }, [effort, todayWeek])

  if (!data) return <div className="text-[var(--ink3)]">データがありません。</div>

  const { pts, max } = data
  const W = Math.max(pts.length * 16 + 60, 360)
  const H = 220
  const padL = 44
  const padB = 28
  const padT = 10
  const plotW = W - padL - 12
  const plotH = H - padT - padB
  const x = (i: number) => padL + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * plotW)
  const y = (v: number) => padT + plotH - (v / max) * plotH

  const plannedLine = pts.map((p, i) => `${x(i)},${y(p.cumP)}`).join(' ')
  const actualPts = pts.map((p, i) => ({ i, v: p.cumA })).filter((p) => p.v != null)
  const actualLine = actualPts.map((p) => `${x(p.i)},${y(p.v as number)}`).join(' ')
  const todayIdx = pts.findIndex((p) => p.week === todayWeek)

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img">
        {/* y gridlines */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} y1={y(max * f)} x2={W - 12} y2={y(max * f)} stroke="var(--line2)" />
            <text x={padL - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="var(--ink3)">
              {round1(max * f)}
            </text>
          </g>
        ))}
        {/* today marker */}
        {todayIdx >= 0 && (
          <g>
            <line
              x1={x(todayIdx)}
              y1={padT}
              x2={x(todayIdx)}
              y2={padT + plotH}
              stroke="var(--today)"
              strokeDasharray="3 3"
            />
            <text x={x(todayIdx)} y={padT + plotH + 18} textAnchor="middle" fontSize={10} fill="var(--today)">
              今日
            </text>
          </g>
        )}
        {/* planned + actual polylines */}
        <polyline points={plannedLine} fill="none" stroke="var(--p-review)" strokeWidth={2} />
        {actualPts.length > 0 && (
          <polyline points={actualLine} fill="none" stroke="var(--p-impl)" strokeWidth={2} />
        )}
        {/* x labels: first, today, last */}
        {[0, pts.length - 1].concat(todayIdx >= 0 ? [todayIdx] : []).map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--ink3)">
            {fmtMD(parseDate(pts[i].week))}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex gap-4 text-[12px] text-[var(--ink2)]">
        <span className="flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded bg-[var(--p-review)]" />予定（累積）
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded bg-[var(--p-impl)]" />実績（累積・今日まで）
        </span>
      </div>
    </div>
  )
}

function PivotTable({ rows }: { rows: AggregateRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="集計できるデータがありません"
        body="週ごとの予定または実績の工数を入れると、グループごとの合計がここに出ます。"
      />
    )
  }
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
          <th className="px-5 py-2.5 font-medium">グループ</th>
          <th className="px-5 py-2.5 text-right font-medium">予定計</th>
          <th className="px-5 py-2.5 text-right font-medium">実績計</th>
          <th className="px-5 py-2.5 text-right font-medium">差（予定−実績）</th>
          <th className="px-5 py-2.5 text-right font-medium">件数</th>
          <th className="px-5 py-2.5 text-right font-medium">消化率</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const rate = r.planned_sum > 0 ? r.actual_sum / r.planned_sum : 0
          const diff = round1(r.planned_sum - r.actual_sum)
          return (
            <tr key={r.group} className="border-b border-[var(--line2)]">
              <td className="px-5 py-2.5">{r.group || '（未設定）'}</td>
              <td className="px-5 py-2.5 text-right">{round1(r.planned_sum)}h</td>
              <td className="px-5 py-2.5 text-right">{round1(r.actual_sum)}h</td>
              <td
                className="px-5 py-2.5 text-right"
                style={{ color: diff < 0 ? '#A8442B' : 'var(--ink2)' }}
              >
                {diff > 0 ? '+' : ''}
                {diff}h
              </td>
              <td className="px-5 py-2.5 text-right">{r.count}</td>
              <td className="px-5 py-2.5 text-right">{Math.round(rate * 100)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Tiny inline-SVG grouped bar chart (planned vs actual). No chart library.
function BarChart({ rows }: { rows: AggregateRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[var(--ink3)]">データがありません。</div>
  }
  const max = Math.max(1, ...rows.flatMap((r) => [r.planned_sum, r.actual_sum]))
  const barH = 200
  const groupW = 84
  const W = Math.max(rows.length * groupW + 40, 320)
  const H = barH + 48

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img">
        <line x1={0} y1={barH + 8} x2={W} y2={barH + 8} stroke="var(--line)" />
        {rows.map((r, i) => {
          const x = 20 + i * groupW
          const ph = (r.planned_sum / max) * barH
          const ah = (r.actual_sum / max) * barH
          return (
            <g key={r.group}>
              <rect x={x} y={barH + 8 - ph} width={26} height={ph} rx={3} fill="var(--p-review)" />
              <rect x={x + 30} y={barH + 8 - ah} width={26} height={ah} rx={3} fill="var(--p-impl)" />
              <text x={x + 28} y={barH + 26} textAnchor="middle" fontSize={11} fill="var(--ink2)">
                {(r.group || '—').slice(0, 6)}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="mt-2 flex gap-4 text-[12px] text-[var(--ink2)]">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] bg-[var(--p-review)]" />予定
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] bg-[var(--p-impl)]" />実績
        </span>
      </div>
    </div>
  )
}
