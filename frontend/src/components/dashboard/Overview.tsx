// ダッシュボードの「概要」タブ — 件数のカード、カテゴリ別の件数（状態の内訳）、
// 担当者別の負荷（件数と週ごとの予定工数）、案件の一覧。
//
// カードを押すと、下のグラフと一覧がその範囲（開発中／期限超過／開始前／完了）に
// 切り替わる。負荷の表は範囲に関係なく、未完了の行で出す。
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn, fmtHours } from '@/lib/format'
import { fmtISO, fmtMD, parseDate } from '@/lib/dates'
import { shortDate, WEEKLY_CAPACITY_H } from '@/lib/dashboard'
import type { Lane, LoadRow, TaskInfo } from '@/lib/dashboard'

export type Scope = 'active' | 'overdue' | 'upcoming' | 'done' | 'all'

const SCOPE_LABEL: Record<Scope, string> = {
  active: '開発中',
  overdue: '期限超過',
  upcoming: '開始前',
  done: '完了',
  all: 'すべて',
}

export function inScope(t: TaskInfo, scope: Scope): boolean {
  switch (scope) {
    case 'active':
      return t.phase === 'active'
    case 'overdue':
      return t.overdue
    case 'upcoming':
      return t.phase === 'upcoming'
    case 'done':
      return t.phase === 'done'
    default:
      return true
  }
}

/** 色の無い選択肢に、並び順で当てる色（アプリのフェーズ色から）。 */
const FALLBACK_FILLS = [
  'var(--p-impl)',
  'var(--p-review)',
  'var(--p-test)',
  'var(--p-design)',
  'var(--p-late)',
  'var(--p-done)',
]

/** 状態ごとの塗り。未設定は中立の灰色。 */
export function laneFill(lanes: Lane[], value: string): string {
  if (value === '') return 'var(--p-neutral)'
  const i = lanes.findIndex((l) => l.value === value)
  const l = lanes[i]
  if (l?.bg) return l.bg
  const colored = lanes.slice(0, Math.max(0, i)).filter((x) => !x.bg && x.value !== '').length
  return FALLBACK_FILLS[colored % FALLBACK_FILLS.length]
}

export function StateBadge({ lanes, value }: { lanes: Lane[]; value: string }) {
  if (!value) return <span className="text-[var(--ink3)]">—</span>
  const l = lanes.find((x) => x.value === value)
  return (
    <Badge color={l?.color ?? 'var(--ink)'} bg={laneFill(lanes, value)}>
      {value}
    </Badge>
  )
}

export function Overview({
  sheetId,
  tasks,
  load,
  loadWeekIsos,
  lanes,
  categoryOrder,
  hasCategory,
  hasState,
  scope,
  onScope,
  onPickAssignee,
}: {
  sheetId: string
  /** 絞り込み済みの行（親の行も含む）。 */
  tasks: TaskInfo[]
  load: LoadRow[]
  loadWeekIsos: string[]
  lanes: Lane[]
  /** カテゴリの並び（設定の選択肢順）。 */
  categoryOrder: string[]
  hasCategory: boolean
  hasState: boolean
  scope: Scope
  onScope: (s: Scope) => void
  onPickAssignee: (key: string) => void
}) {
  const leaves = useMemo(() => tasks.filter((t) => !t.isParent), [tasks])
  const parents = tasks.length - leaves.length
  const count = (s: Scope) => leaves.filter((t) => inScope(t, s)).length
  const nostart = leaves.filter((t) => t.phase === 'nostart').length
  const scoped = useMemo(() => leaves.filter((t) => inScope(t, scope)), [leaves, scope])

  const thisWeek = load.reduce((s, r) => s + (r.hours[0] ?? 0), 0)

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(['active', 'overdue', 'upcoming', 'done'] as Scope[]).map((s) => (
          <ScopeCard
            key={s}
            label={SCOPE_LABEL[s]}
            value={count(s)}
            unit="件"
            hint={HINT[s]}
            selected={scope === s}
            alert={s === 'overdue' && count(s) > 0}
            onClick={() => onScope(scope === s ? 'all' : s)}
          />
        ))}
        <Card>
          <CardBody className="px-4 py-3">
            <div className="text-[11px] text-[var(--ink3)]">今週の予定工数</div>
            <div className="mt-1 text-[22px] font-semibold">
              {fmtHours(thisWeek)}
              <span className="ml-0.5 text-[13px] font-normal text-[var(--ink2)]">h</span>
            </div>
            <div className="text-[11px] text-[var(--ink3)]">未完了の行の合計</div>
          </CardBody>
        </Card>
      </div>
      {(nostart > 0 || parents > 0) && (
        <p className="-mt-2 text-[11.5px] text-[var(--ink3)]">
          {nostart > 0 &&
            `開始日も予定工数も無い行 ${nostart} 件は、開発中・開始前のどちらにも入りません（「すべて」で表示）。`}
          {parents > 0 && `子タスクを持つ行 ${parents} 件は数えず、子タスクで数えています。`}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader className="flex items-baseline justify-between gap-2">
            <CardTitle>カテゴリ別の件数</CardTitle>
            <span className="text-[11.5px] text-[var(--ink3)]">{SCOPE_LABEL[scope]}・状態の内訳</span>
          </CardHeader>
          <CardBody>
            <CategoryChart
              tasks={scoped}
              lanes={lanes}
              order={categoryOrder}
              hasCategory={hasCategory}
              hasState={hasState}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex items-baseline justify-between gap-2">
            <CardTitle>担当者別の負荷</CardTitle>
            <span className="text-[11.5px] text-[var(--ink3)]">
              件数＝未完了の行／工数＝週ごとの予定（上限 {WEEKLY_CAPACITY_H}h）
            </span>
          </CardHeader>
          <CardBody className="px-0 py-0">
            <LoadTable rows={load} weekIsos={loadWeekIsos} onPick={onPickAssignee} />
          </CardBody>
        </Card>
      </div>

      <Card className="flex min-h-[240px] flex-col">
        <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle>
            {SCOPE_LABEL[scope]}の案件 <span className="ml-1 text-[12px] font-normal text-[var(--ink3)]">{scoped.length} 件</span>
          </CardTitle>
          <div className="flex gap-1 text-[12px]">
            {(['active', 'overdue', 'upcoming', 'done', 'all'] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onScope(s)}
                className={cn(
                  'rounded-[8px] px-2.5 py-1',
                  scope === s
                    ? 'bg-[var(--green)] text-white'
                    : 'text-[var(--ink2)] hover:bg-[var(--line2)]',
                )}
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardBody className="max-h-[560px] overflow-auto px-0 py-0">
          <TaskTable sheetId={sheetId} tasks={scoped} lanes={lanes} scope={scope} hasCategory={hasCategory} />
        </CardBody>
      </Card>
    </>
  )
}

const HINT: Record<Scope, string> = {
  active: '開始日を過ぎて未完了',
  overdue: '期限を過ぎて未完了',
  upcoming: '開始日が先',
  done: '完了と判定された行',
  all: '',
}

function ScopeCard({
  label,
  value,
  unit,
  hint,
  selected,
  alert,
  onClick,
}: {
  label: string
  value: number
  unit: string
  hint: string
  selected: boolean
  alert: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      title={selected ? '押すと「すべて」に戻ります' : `下のグラフと一覧を「${label}」に絞ります`}
      className={cn(
        'rounded-[14px] border bg-[var(--surface)] px-4 py-3 text-left transition-colors',
        selected
          ? 'border-[var(--green)] shadow-[inset_0_0_0_1px_var(--green)]'
          : 'border-[var(--line)] hover:border-[var(--green-l)]',
      )}
    >
      <div className="text-[11px] text-[var(--ink3)]">{label}</div>
      <div className={cn('mt-1 text-[22px] font-semibold', alert && 'text-[#A8442B]')}>
        {value}
        <span className="ml-0.5 text-[13px] font-normal text-[var(--ink2)]">{unit}</span>
      </div>
      <div className="text-[11px] text-[var(--ink3)]">{hint}</div>
    </button>
  )
}

// カテゴリ × 状態の積み上げ横棒。棒の長さは最大のカテゴリを基準にそろえる。
function CategoryChart({
  tasks,
  lanes,
  order,
  hasCategory,
  hasState,
}: {
  tasks: TaskInfo[]
  lanes: Lane[]
  order: string[]
  hasCategory: boolean
  hasState: boolean
}) {
  const groups = useMemo(() => {
    const byCat = new Map<string, Map<string, number>>()
    for (const t of tasks) {
      const c = hasCategory ? t.category : ''
      const m = byCat.get(c) ?? new Map<string, number>()
      const s = hasState ? t.state : ''
      m.set(s, (m.get(s) ?? 0) + 1)
      byCat.set(c, m)
    }
    const rank = (c: string) => {
      const i = order.indexOf(c)
      return i < 0 ? order.length : i
    }
    return [...byCat.entries()]
      .map(([cat, m]) => ({
        cat,
        total: [...m.values()].reduce((a, b) => a + b, 0),
        segs: lanes.filter((l) => m.has(l.value)).map((l) => ({ value: l.value, n: m.get(l.value)! })),
      }))
      .sort((a, b) => rank(a.cat) - rank(b.cat) || b.total - a.total)
  }, [tasks, lanes, order, hasCategory, hasState])

  if (tasks.length === 0) return <div className="py-6 text-center text-[12.5px] text-[var(--ink3)]">該当する行はありません。</div>

  const max = Math.max(1, ...groups.map((g) => g.total))
  const used = lanes.filter((l) => groups.some((g) => g.segs.some((s) => s.value === l.value)))

  return (
    <div className="flex flex-col gap-3">
      {hasState && used.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[var(--ink2)]">
          {used.map((l) => (
            <span key={l.value} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-[3px] shadow-[inset_0_0_0_1px_rgba(35,33,29,0.14)]"
                style={{ background: laneFill(lanes, l.value) }}
              />
              {l.value || '（未設定）'}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <div key={g.cat} className="grid grid-cols-[minmax(0,110px)_minmax(0,1fr)_36px] items-center gap-2 text-[12.5px]">
            <span className="truncate text-[var(--ink2)]" title={g.cat}>
              {hasCategory ? g.cat || '（未設定）' : '全体'}
            </span>
            <div className="flex h-[20px] gap-[2px]" style={{ width: `${(g.total / max) * 100}%` }}>
              {/* 状態の色は利用者がシート設定で決めた淡い色のことが多いので、縁取りと
                  件数を重ねて、色だけに頼らずに読めるようにする。 */}
              {g.segs.map((s, i) => (
                <div
                  key={s.value}
                  className={cn(
                    'flex h-full min-w-[3px] items-center justify-center overflow-hidden text-[10.5px] tabular-nums text-[var(--ink2)] shadow-[inset_0_0_0_1px_rgba(35,33,29,0.14)]',
                    i === 0 && 'rounded-l-[4px]',
                    i === g.segs.length - 1 && 'rounded-r-[4px]',
                  )}
                  style={{ flexGrow: s.n, flexBasis: 0, background: laneFill(lanes, s.value) }}
                  title={`${hasCategory ? g.cat || '（未設定）' : '全体'}・${s.value || '（状態未設定）'}：${s.n} 件`}
                >
                  {s.n}
                </div>
              ))}
            </div>
            <span className="text-right font-medium tabular-nums">{g.total}</span>
          </div>
        ))}
      </div>
      {!hasCategory && (
        <p className="text-[11.5px] text-[var(--ink3)]">上の「カテゴリの列」を選ぶと、カテゴリごとに分かれます。</p>
      )}
    </div>
  )
}

/** 予定工数のセルの塗り。上限を超えた週だけ警告色（数字も出すので色だけに頼らない）。 */
function loadStyle(h: number): { bg: string; ink: string; over: boolean } {
  const r = h / WEEKLY_CAPACITY_H
  if (h <= 0) return { bg: 'transparent', ink: 'var(--ink3)', over: false }
  if (r > 1) return { bg: '#FAE6E0', ink: '#A8442B', over: true }
  if (r > 0.8) return { bg: '#A7D0BE', ink: 'var(--ink)', over: false }
  if (r > 0.5) return { bg: '#CFE5DA', ink: 'var(--ink)', over: false }
  return { bg: '#EAF3EE', ink: 'var(--ink2)', over: false }
}

function LoadTable({
  rows,
  weekIsos,
  onPick,
}: {
  rows: LoadRow[]
  weekIsos: string[]
  onPick: (key: string) => void
}) {
  if (rows.length === 0)
    return <EmptyState compact title="未完了の担当タスクはありません" body="担当者が入った未完了の行があると、ここに件数と予定工数が出ます。" />
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="whitespace-nowrap text-[var(--ink3)]">
            <th className="px-3 py-2 text-left font-medium">担当</th>
            <th className="px-1.5 py-2 text-right font-medium" title="開始日を過ぎて未完了">開発中</th>
            <th className="px-1.5 py-2 text-right font-medium">超過</th>
            <th className="px-1.5 py-2 text-right font-medium">開始前</th>
            {weekIsos.map((w, i) => (
              <th key={w} className="w-[44px] px-0.5 py-2 text-center font-medium" title={`${w} の週`}>
                {i === 0 ? '今週' : fmtMD(parseDate(w))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[var(--line2)]">
              <td className="px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => onPick(r.key)}
                  className="flex max-w-[150px] items-center gap-1.5 hover:text-[var(--green-d)]"
                  title={`${r.name} で絞り込む`}
                >
                  <Avatar name={r.name} seed={r.key || null} />
                  <span className="truncate">{r.name}</span>
                </button>
              </td>
              <td className="px-1.5 py-1.5 text-right font-medium tabular-nums">{r.active || '·'}</td>
              <td className={cn('px-1.5 py-1.5 text-right tabular-nums', r.overdue ? 'font-semibold text-[#A8442B]' : 'text-[var(--ink3)]')}>
                {r.overdue || '·'}
              </td>
              <td className="px-1.5 py-1.5 text-right tabular-nums text-[var(--ink2)]">{r.upcoming || '·'}</td>
              {r.hours.map((h, i) => {
                const st = loadStyle(h)
                return (
                  <td key={i} className="px-[1px] py-[2px]">
                    <div
                      className={cn('rounded-[4px] py-1 text-center tabular-nums', st.over && 'font-semibold')}
                      style={{ background: st.bg, color: st.ink }}
                      title={
                        st.over
                          ? `${weekIsos[i]} の週：予定 ${fmtHours(h)}h（上限 ${WEEKLY_CAPACITY_H}h を ${fmtHours(h - WEEKLY_CAPACITY_H)}h 超過）`
                          : `${weekIsos[i]} の週：予定 ${fmtHours(h)}h`
                      }
                    >
                      {h > 0 ? fmtHours(h) : '·'}
                    </div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[11px] text-[var(--ink3)]">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#EAF3EE]" />〜{WEEKLY_CAPACITY_H / 2}h
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#CFE5DA]" />〜{WEEKLY_CAPACITY_H * 0.8}h
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#A7D0BE]" />〜{WEEKLY_CAPACITY_H}h
        </span>
        <span className="flex items-center gap-1 text-[#A8442B]">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#FAE6E0]" />{WEEKLY_CAPACITY_H}h 超
        </span>
        <span>名前を押すと、その人で絞り込みます</span>
      </div>
    </div>
  )
}

const TH = 'sticky top-0 z-10 bg-[var(--surface)] px-3 py-2 font-medium shadow-[inset_0_-1px_0_var(--line)]'

function TaskTable({
  sheetId,
  tasks,
  lanes,
  scope,
  hasCategory,
}: {
  sheetId: string
  tasks: TaskInfo[]
  lanes: Lane[]
  scope: Scope
  hasCategory: boolean
}) {
  // 期限の近い順（完了は新しい順）。期限の無い行は最後。
  const sorted = useMemo(() => {
    const dir = scope === 'done' ? -1 : 1
    return [...tasks].sort((a, b) => {
      if (!a.due && !b.due) return a.m.keyValue.localeCompare(b.m.keyValue, 'ja', { numeric: true })
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due.localeCompare(b.due) * dir
    })
  }, [tasks, scope])

  if (sorted.length === 0)
    return <div className="py-8 text-center text-[12.5px] text-[var(--ink3)]">該当する行はありません。</div>

  const today = fmtISO(new Date())
  const md = (iso: string | null) => shortDate(iso, today)
  return (
    <table className="w-full min-w-[860px] border-collapse text-[12.5px]">
      <thead>
        <tr className="text-left text-[var(--ink3)]">
          <th className={TH}>ID</th>
          <th className={TH}>件名</th>
          {hasCategory && <th className={TH}>カテゴリ</th>}
          <th className={TH}>担当</th>
          <th className={TH}>状態</th>
          <th className={TH}>開始</th>
          <th className={TH}>期限</th>
          <th className={cn(TH, 'text-right')}>予定計</th>
          <th className={cn(TH, 'text-right')}>実績計</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => (
          <tr key={t.m.row.id} className={cn('border-b border-[var(--line2)]', t.done && 'text-[var(--ink3)]')}>
            <td className="whitespace-nowrap px-3 py-2 font-semibold">
              <Link
                to={`/sheets/${sheetId}?focus=${t.m.row.id}&t=${Date.now()}`}
                className="hover:text-[var(--green-d)] hover:underline"
                title="スケジュールでこの行を表示"
              >
                {t.m.keyValue}
              </Link>
            </td>
            <td className="max-w-[360px] truncate px-3 py-2" title={t.m.title}>
              {t.m.title}
            </td>
            {hasCategory && (
              <td className="max-w-[140px] truncate px-3 py-2 text-[var(--ink2)]" title={t.category}>
                {t.category || '—'}
              </td>
            )}
            <td className="px-3 py-2">
              {t.m.assigneeName ? (
                <span className="flex items-center gap-1.5">
                  <Avatar name={t.m.assigneeName} seed={t.m.assigneeId} />
                  <span className="max-w-[110px] truncate">{t.m.assigneeName}</span>
                </span>
              ) : (
                <span className="text-[var(--ink3)]">—</span>
              )}
            </td>
            <td className="px-3 py-2">
              <StateBadge lanes={lanes} value={t.state} />
            </td>
            <td
              className={cn('whitespace-nowrap px-3 py-2', t.startFrom === 'effort' && 'text-[var(--ink3)]')}
              title={t.startFrom === 'effort' ? '開始日の列が空なので、予定工数の最初の週を使っています' : undefined}
            >
              {md(t.start)}
            </td>
            <td
              className={cn(
                'whitespace-nowrap px-3 py-2',
                t.overdue ? 'font-semibold text-[#A8442B]' : t.dueFrom === 'effort' && 'text-[var(--ink3)]',
              )}
              title={
                t.dueFrom === 'effort' ? '完了日の列が空なので、予定工数の最後の週を使っています' : undefined
              }
            >
              {md(t.due)}
              {t.overdue && <span className="ml-1 text-[10.5px]">超過</span>}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtHours(t.planned)}h</td>
            <td className="px-3 py-2 text-right tabular-nums text-[var(--ink2)]">{fmtHours(t.actual)}h</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
