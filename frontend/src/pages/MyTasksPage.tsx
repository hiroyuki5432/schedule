// マイタスク — 担当タスクの一覧。担当者・シートに加えて「完了を隠す」「年度」
// 「ステータス」の絞り込みと並べ替えを持ち、選んだ表示はブラウザに保存して次に
// 開いたときも同じ状態から始まる（要望: 表示を決めれる／継続できる）。
import { useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useSelectedSheet } from '@/hooks/useSelectedSheet'
import { useScheduleData } from '@/hooks/useScheduleData'
import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import { useAuth } from '@/hooks/useAuth'
import { usePersistentState } from '@/hooks/usePersistentState'
import { PageHeader } from '@/components/PageHeader'
import { SheetPicker } from '@/components/SheetPicker'
import { Select } from '@/components/ui/Select'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { fmtHours, cn } from '@/lib/format'
import { fiscalYearOf, fmtMD } from '@/lib/dates'
import { makeIsRowDone } from '@/lib/status'

/** Member picker value meaning "everyone's tasks, not just one person's". */
const ALL = '__all__'
/** 絞り込みの「すべて」. */
const ANY = ''

type SortKey = 'id' | 'title' | 'finish' | 'planned' | 'status'
type SortDir = 'asc' | 'desc'

/** Header cell pinned to the top of the scrolling card (見出しは常に表示). The rule
 *  under it is an inset shadow — a border on a stuck cell scrolls away when the
 *  table uses border-collapse. */
const TH =
  'sticky top-0 z-20 bg-[var(--surface)] px-5 py-2.5 shadow-[inset_0_-1px_0_var(--line)]'

/** Column widths: ID / 件名 / 担当 / ステータス / 終了週 / 予定計.
 *
 *  Used with `table-fixed` + `w-max`. Without them this table had no width control
 *  at all: it stretched to fill any monitor (要望: 画面いっぱいでスカスカ) and one
 *  long 件名 pushed the columns out without limit (要望: 幅が永遠に広がる). 件名 is
 *  the only one that ever runs long, so it gets the room; past that it is clipped
 *  with the full text on hover. */
const COL_W = [140, 420, 180, 120, 120, 110]

const SORT_LABEL: Record<SortKey, string> = {
  id: 'ID',
  title: '件名',
  finish: '終了週',
  planned: '予定計',
  status: 'ステータス',
}


export function MyTasksPage() {
  const { user } = useAuth()
  const weekStartWeekday = useWeekStartWeekday()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])
  const { sheets, sheetId, setSheetId, loading: sheetsLoading } = useSelectedSheet(
    'view:myTasks:sheetId',
    true,
  )
  // Whose tasks to show. Defaults to the signed-in user, but any member (or
  // everyone) can be selected — the same page doubles as a team view
  // (要望: マイタスクは他の人も見れるように).
  const [who, setWho] = usePersistentState<string>('view:myTasks:userId', '')
  useEffect(() => {
    if (!who && user?.id) setWho(String(user.id))
  }, [who, user?.id, setWho])

  // Persisted view settings (要望: 一度決めた表示を次も継続).
  const [hideDone, setHideDone] = usePersistentState('view:myTasks:hideDone', false)
  const [yearSel, setYearSel] = usePersistentState<string>('view:myTasks:year', ANY)
  const [statusSel, setStatusSel] = usePersistentState<string>('view:myTasks:status', ANY)
  const [sortKey, setSortKey] = usePersistentState<SortKey>('view:myTasks:sortKey', 'id')
  const [sortDir, setSortDir] = usePersistentState<SortDir>('view:myTasks:sortDir', 'asc')

  const grid = useScheduleData({
    sheetId,
    weekStartWeekday,
    members,
    asOfWeek: null,
  })

  // 完了判定はスケジュール画面と同じルール（シート設定の done_filter → status列）。
  const memberName = useMemo(
    () => new Map(members.map((m) => [String(m.id), m.name])),
    [members],
  )
  const isDone = useMemo(
    () =>
      makeIsRowDone(
        grid.columns,
        memberName,
        grid.detail?.sheet?.settings?.done_filter,
      ),
    [grid.columns, memberName, grid.detail],
  )

  const assigned = useMemo(() => {
    if (who === ALL) return grid.rows.filter((r) => !!r.assigneeId)
    const target = who || String(user?.id ?? '')
    return grid.rows.filter((r) => r.assigneeId && String(r.assigneeId) === target)
  }, [grid.rows, who, user?.id])

  /** Fiscal years a task touches (from its planned/actual week span). */
  const yearsOf = useMemo(() => {
    const weeks = grid.weeks
    return (r: ScheduleRowModel): number[] => {
      if (r.startIdx == null || r.finishIdx == null) return []
      const from = fiscalYearOf(weeks[Math.max(0, r.startIdx)] ?? new Date())
      const to = fiscalYearOf(weeks[Math.min(weeks.length - 1, r.finishIdx)] ?? new Date())
      const out: number[] = []
      for (let y = from; y <= to; y++) out.push(y)
      return out
    }
  }, [grid.weeks])

  // Options come from the tasks in view, so the pickers never offer dead choices.
  const yearOptions = useMemo(() => {
    const set = new Set<number>()
    for (const r of assigned) for (const y of yearsOf(r)) set.add(y)
    return [...set].sort()
  }, [assigned, yearsOf])
  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of assigned) if (r.status?.label) set.add(r.status.label)
    return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [assigned])

  const mine = useMemo(() => {
    const year = yearSel === ANY ? null : Number(yearSel)
    const filtered = assigned.filter((r) => {
      if (hideDone && isDone(r)) return false
      if (statusSel !== ANY && (r.status?.label ?? '') !== statusSel) return false
      if (year != null && !yearsOf(r).includes(year)) return false
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    const val = (r: ScheduleRowModel): string | number => {
      switch (sortKey) {
        case 'title':
          return r.title || ''
        case 'finish':
          return r.finishIdx ?? Number.MAX_SAFE_INTEGER
        case 'planned':
          return r.gantt.plannedSum
        case 'status':
          return r.status?.label ?? ''
        default:
          return r.keyValue || ''
      }
    }
    return [...filtered].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c =
        typeof x === 'number' && typeof y === 'number'
          ? x - y
          : String(x).localeCompare(String(y), 'ja', { numeric: true })
      return c * dir
    })
  }, [assigned, hideDone, isDone, statusSel, yearSel, yearsOf, sortKey, sortDir])

  const isMe = who === '' || who === String(user?.id ?? '')
  const whoName =
    who === ALL
      ? '全メンバー'
      : (members.find((m) => String(m.id) === who)?.name ?? user?.name ?? '')

  const hiddenCount = assigned.length - mine.length
  const weekLabel = (idx: number | null) =>
    idx == null || !grid.weeks[idx] ? '' : fmtMD(grid.weeks[idx])

  /** Clicking a header sorts by it (same key toggles direction). */
  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }
  const Th = ({ k, className }: { k: SortKey; className?: string }) => (
    <th className={cn(TH, 'font-medium', className)}>
      <button
        type="button"
        onClick={() => sortBy(k)}
        className="inline-flex items-center gap-1 hover:text-[var(--ink)]"
        title="この列で並べ替え"
      >
        {SORT_LABEL[k]}
        <span className={cn('text-[10px]', sortKey === k ? 'text-[var(--green)]' : 'opacity-0')}>
          {sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  )

  return (
    <>
      <PageHeader
        title="マイタスク"
        subtitle={isMe ? '自分が担当しているタスク' : `${whoName} が担当しているタスク`}
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={who || String(user?.id ?? '')}
              onChange={(e) => setWho(e.target.value)}
              title="表示する担当者"
              className="w-[160px]"
            >
              {members.map((m) => (
                <option key={m.id} value={String(m.id)}>
                  {String(m.id) === String(user?.id) ? `${m.name}（自分）` : m.name}
                </option>
              ))}
              <option value={ALL}>全メンバー</option>
            </Select>
            <SheetPicker sheets={sheets} sheetId={sheetId} onChange={setSheetId} />
          </div>
        }
      />

      {/* The card is the scroller, so the filters stay put and the table's
          header row stays pinned while scrolling (スケジュールと同じ挙動). */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-[22px] pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--ink2)]">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={hideDone}
              onChange={(e) => setHideDone(e.target.checked)}
              className="accent-[var(--green)]"
            />
            完了を隠す
          </label>
          <label className="flex items-center gap-2">
            年度
            <Select value={yearSel} onChange={(e) => setYearSel(e.target.value)}>
              <option value={ANY}>すべて</option>
              {yearOptions.map((y) => (
                <option key={y} value={String(y)}>
                  {y}年度（{y}/4〜{y + 1}/3）
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            ステータス
            <Select value={statusSel} onChange={(e) => setStatusSel(e.target.value)}>
              <option value={ANY}>すべて</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            並べ替え
            <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
              title={sortDir === 'asc' ? '昇順' : '降順'}
              className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-[11px] text-[var(--ink2)] hover:bg-[var(--line2)]"
            >
              {sortDir === 'asc' ? '▲ 昇順' : '▼ 降順'}
            </button>
          </label>
          <span className="text-[11.5px] text-[var(--ink3)]">
            {mine.length} 件{hiddenCount > 0 && `（${hiddenCount} 件を非表示）`}／表示設定は保存されます
          </span>
        </div>

        <Card className="min-h-0 overflow-auto">
          <CardBody className="px-0 py-0">
            {sheetsLoading || grid.loading ? (
              <TableSkeleton rows={5} cols={5} />
            ) : !sheetId ? (
              <EmptyState
                compact
                title="スケジュールのシートがありません"
                body="左のサイドバーから「シート追加」でスケジュールを作ると、担当タスクがここに並びます。"
              />
            ) : mine.length === 0 ? (
              <EmptyState
                compact
                title={
                  assigned.length > 0
                    ? '絞り込みに一致するタスクがありません'
                    : isMe
                      ? 'このシートで担当しているタスクはありません'
                      : `このシートで ${whoName} が担当しているタスクはありません`
                }
                body={
                  assigned.length > 0
                    ? '上の「完了を隠す」「年度」「ステータス」を緩めると表示されます。'
                    : '担当者の列に設定されたタスクがここに出ます。別のシートや担当者を見るには右上で切り替えてください。'
                }
              />
            ) : (
              <table className="w-max table-fixed border-collapse text-[12.5px]">
                <colgroup>
                  {COL_W.map((w, i) => (
                    <col key={i} style={{ width: w }} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="text-left text-[var(--ink3)]">
                    <Th k="id" />
                    <Th k="title" />
                    <th className={`${TH} font-medium`}>担当</th>
                    <Th k="status" />
                    <Th k="finish" />
                    <Th k="planned" className="text-right" />
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr
                      key={r.row.id}
                      className={cn(
                        'border-b border-[var(--line2)]',
                        isDone(r) && 'text-[var(--ink3)]',
                      )}
                    >
                      <td className="px-5 py-2.5 font-semibold">
                        {/* Jump straight to the task in the schedule (scrolls + flashes). */}
                        <Link
                          to={`/sheets/${sheetId}?focus=${r.row.id}&t=${Date.now()}`}
                          className="hover:text-[var(--green-d)] hover:underline"
                          title="スケジュールでこのタスクを表示"
                        >
                          {r.keyValue}
                        </Link>
                      </td>
                      <td className="truncate px-5 py-2.5" title={r.title}>
                        {r.title}
                      </td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={r.assigneeName} seed={r.assigneeId} />
                          <span className="truncate" title={r.assigneeName ?? undefined}>
                            {r.assigneeName}
                          </span>
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        {r.status && (
                          <Badge color={r.status.color} bg={r.status.bg}>
                            {r.status.label}
                          </Badge>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-[var(--ink2)]">
                        {weekLabel(r.finishIdx)}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[var(--ink2)]">
                        {fmtHours(r.gantt.plannedSum)}h
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  )
}
