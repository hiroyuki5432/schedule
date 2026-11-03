// ダッシュボードの「期間」タブ — 絞り込んだ行だけを、今日の前後の数週間で横棒にする。
//
// スケジュール画面のガント（全行・約3年・工数の入力）とは別物で、こちらは見るだけ。
// バーを押すとスケジュールの該当行へ移動して、そこで直す（編集の入口を1つに保つ）。
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { cn } from '@/lib/format'
import { addWeeks, fmtMD, parseDate } from '@/lib/dates'
import { shortDate } from '@/lib/dashboard'
import type { Lane, TaskInfo } from '@/lib/dashboard'
import { inScope, laneFill } from '@/components/dashboard/Overview'
import type { Scope } from '@/components/dashboard/Overview'

/** 今週より前に見せる週数／後ろに見せる週数。 */
const WEEKS_BEFORE = 4
const WEEKS_AFTER = 8
const MS_DAY = 24 * 60 * 60 * 1000

const SCOPES: Array<[Scope, string]> = [
  ['active', '開発中'],
  ['overdue', '期限超過'],
  ['upcoming', '開始前'],
  ['done', '完了'],
  ['all', 'すべて'],
]

export function Timeline({
  sheetId,
  tasks,
  lanes,
  today,
  currentWeek,
  scope,
  onScope,
}: {
  sheetId: string
  /** 絞り込み済み・親の行を除いた行。 */
  tasks: TaskInfo[]
  lanes: Lane[]
  today: string
  currentWeek: string
  scope: Scope
  onScope: (s: Scope) => void
}) {
  // 表示の窓を4週ずつ前後へずらせる（保存はしない — 開くたびに今日の前後から）。
  const [shift, setShift] = useState(0)
  const from = addWeeks(currentWeek, -WEEKS_BEFORE + shift)
  const to = addWeeks(currentWeek, WEEKS_AFTER + shift)
  const t0 = parseDate(from).getTime()
  const span = parseDate(to).getTime() - t0
  const pct = (iso: string, plusDays = 0) =>
    ((parseDate(iso).getTime() + plusDays * MS_DAY - t0) / span) * 100
  const weeks = Array.from({ length: WEEKS_BEFORE + WEEKS_AFTER }, (_, i) =>
    addWeeks(from, i),
  )

  const scoped = useMemo(() => tasks.filter((t) => inScope(t, scope)), [tasks, scope])
  // 期間が決まらない行（開始日・期限のどちらかが無い）は棒にできないので、数だけ出す。
  const undated = scoped.filter((t) => !t.start || !t.due).length
  // 窓の外（すべて前、すべて後）の行も数だけ出す。
  const rows = useMemo(
    () =>
      scoped
        .filter((t) => t.start && t.due)
        .sort(
          (a, b) =>
            a.start!.localeCompare(b.start!) ||
            a.due!.localeCompare(b.due!) ||
            a.m.keyValue.localeCompare(b.m.keyValue, 'ja', { numeric: true }),
        ),
    [scoped],
  )
  // 期限超過は「期限から今日まで」も続いているものとして描くので、期限が窓より前でも出す。
  const visible = rows.filter((t) => t.start! < to && (t.due! >= from || t.overdue))
  const outside = rows.length - visible.length
  const todayPct = pct(today)

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          期間{' '}
          <span className="ml-1 text-[12px] font-normal text-[var(--ink3)]">{visible.length} 件</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <div className="flex gap-1">
            {SCOPES.map(([s, label]) => (
              <button
                key={s}
                type="button"
                onClick={() => onScope(s)}
                className={cn(
                  'rounded-[8px] px-2.5 py-1',
                  scope === s ? 'bg-[var(--green)] text-white' : 'text-[var(--ink2)] hover:bg-[var(--line2)]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[var(--ink2)]">
            <button
              type="button"
              onClick={() => setShift(shift - 4)}
              className="rounded-[8px] px-2 py-1 hover:bg-[var(--line2)]"
              title="4週前へ"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setShift(0)}
              disabled={shift === 0}
              className="rounded-[8px] px-2 py-1 hover:bg-[var(--line2)] disabled:opacity-40"
            >
              今日
            </button>
            <button
              type="button"
              onClick={() => setShift(shift + 4)}
              className="rounded-[8px] px-2 py-1 hover:bg-[var(--line2)]"
              title="4週後へ"
            >
              ›
            </button>
          </div>
        </div>
      </CardHeader>
      <CardBody className="overflow-x-auto px-0 py-0">
        <div className="min-w-[860px]">
          {/* 週の見出し */}
          <div className="grid grid-cols-[280px_minmax(0,1fr)] border-b border-[var(--line)] text-[11px] text-[var(--ink3)]">
            <div className="px-4 py-2">案件 / 担当</div>
            <div className="relative h-[30px]">
              {weeks.map((w) => (
                <span
                  key={w}
                  className="absolute top-2 -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${pct(w)}%` }}
                >
                  {w === currentWeek ? '今週' : fmtMD(parseDate(w))}
                </span>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="py-10 text-center text-[12.5px] text-[var(--ink3)]">
              この期間に該当する行はありません。
            </div>
          ) : (
            visible.map((t) => {
              const left = Math.max(0, pct(t.start!))
              const right = Math.min(100, pct(t.due!, 1))
              const cutL = pct(t.start!) < 0
              const cutR = pct(t.due!, 1) > 100
              const label = [t.state, t.m.assigneeName].filter(Boolean).join('・')
              return (
                <div
                  key={t.m.row.id}
                  className="grid grid-cols-[280px_minmax(0,1fr)] border-b border-[var(--line2)] text-[12.5px]"
                >
                  <div className="flex min-w-0 items-center gap-2 px-4 py-2">
                    <span className="flex-shrink-0 text-[11px] font-semibold text-[var(--ink3)]">
                      {t.m.keyValue}
                    </span>
                    <span className="truncate" title={t.m.title}>
                      {t.m.title}
                    </span>
                    {t.m.assigneeName && (
                      <span className="flex-shrink-0 text-[11.5px] text-[var(--ink3)]">· {t.m.assigneeName}</span>
                    )}
                  </div>
                  <div className="relative h-[36px]">
                    <WeekLines weeks={weeks} pct={pct} />
                    {todayPct >= 0 && todayPct <= 100 && (
                      <div
                        className="absolute inset-y-0 border-l border-dashed border-[var(--today)]"
                        style={{ left: `${todayPct}%` }}
                      />
                    )}
                    {/* 期限超過: 期限の翌日から今日までを「超過分」として赤で続ける。 */}
                    {t.overdue && (
                      <div
                        className="absolute top-[6px] h-[24px] rounded-r-[6px] bg-[#FAE6E0] shadow-[inset_0_0_0_1px_rgba(168,68,43,0.35),inset_-3px_0_0_#A8442B]"
                        style={{
                          left: `${Math.max(0, right)}%`,
                          width: `${Math.max(0, Math.min(100, pct(today, 1)) - Math.max(0, right))}%`,
                        }}
                        title={`期限 ${shortDate(t.due, today)} を過ぎて未完了`}
                      />
                    )}
                    <Link
                      to={`/sheets/${sheetId}?focus=${t.m.row.id}&t=${Date.now()}`}
                      className={cn(
                        'absolute top-[6px] flex h-[24px] items-center justify-center overflow-hidden whitespace-nowrap px-2 text-[11px] text-[var(--ink2)] shadow-[inset_0_0_0_1px_rgba(35,33,29,0.14)] hover:brightness-95',
                        !cutL && 'rounded-l-[6px]',
                        !cutR && !t.overdue && 'rounded-r-[6px]',
                        t.done && 'opacity-60',
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(0.6, right - left)}%`,
                        background: laneFill(lanes, t.state),
                        // 期限が窓より前なら本体は見えないので、超過分の上に名札だけ出す。
                        ...(right <= 0 ? { left: 0, width: `${Math.max(8, pct(today, 1))}%`, background: 'transparent', boxShadow: 'none', color: '#A8442B' } : {}),
                      }}
                      title={[
                        `${t.m.keyValue} ${t.m.title}`,
                        `${shortDate(t.start, today)} 〜 ${shortDate(t.due, today)}${t.overdue ? '（期限超過）' : ''}`,
                        label,
                        t.startFrom === 'effort' || t.dueFrom === 'effort'
                          ? '※ 開始日・完了日の列が空の分は、予定工数の週から求めています'
                          : '',
                        'クリックでスケジュールのこの行へ',
                      ]
                        .filter(Boolean)
                        .join('\n')}
                    >
                      {cutL && '‹ '}
                      {label || '—'}
                      {right <= 0 && `（期限 ${shortDate(t.due, today)} 超過）`}
                      {cutR && ' ›'}
                    </Link>
                  </div>
                </div>
              )
            })
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-[11px] text-[var(--ink3)]">
            <span>破線：今日（{shortDate(today, today)}）</span>
            <span>赤：期限を過ぎて今日まで未完了の分</span>
            <span>バーを押すとスケジュールの該当行へ移動します（編集はスケジュールで）</span>
            {outside > 0 && <span>この期間の外に {outside} 件（‹ › で移動）</span>}
            {undated > 0 && <span>開始日・期限が決まらない {undated} 件は表示していません</span>}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function WeekLines({ weeks, pct }: { weeks: string[]; pct: (iso: string) => number }) {
  return (
    <>
      {weeks.map((w) => (
        <div
          key={w}
          className="absolute inset-y-0 border-l border-[var(--line2)]"
          style={{ left: `${pct(w)}%` }}
        />
      ))}
    </>
  )
}
