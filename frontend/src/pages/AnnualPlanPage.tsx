// 年間開発計画ビュー — カテゴリ・スイムレーン年表。
//
// こまごましたタスクを「カテゴリ（指定列の値）」で集約し、各カテゴリが年内の
// どの月に動くかを帯で俯瞰する（数値なし）。タスクの活動月は予定/実績工数の
// ある週から導出。親タスクは子タスク（子の工数）も含めて集計する。カテゴリ行
// はクリックで内訳（個別タスクの帯）にドリルダウンできる。

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers, useSheets } from '@/hooks/useSheets'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { ChevronDownIcon, ChevronUpIcon } from '@/components/ui/icons'
import { parseDate } from '@/lib/dates'
import type { Column, Effort, Member, Row } from '@/types/api'

const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
// Lane color palette (mirrors the phase-color feel of the gantt).
const PALETTE = [
  '#A7D0BE', '#CBD9EE', '#F1DBAC', '#E8B6A6',
  '#C7B8DE', '#BFE2D3', '#E0CDA9', '#9FC7D6',
  '#D8B8C8', '#B8C9A8',
]
const UNSET = '（未設定）'

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Contiguous active-month runs [startMonth, endMonth] from a 12-bool array. */
function runsOf(months: boolean[]): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let i = 0
  while (i < 12) {
    if (!months[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < 12 && months[j + 1]) j++
    runs.push([i, j])
    i = j + 1
  }
  return runs
}

interface TaskLane {
  key: string
  title: string
  months: boolean[]
}
interface SubLane {
  name: string
  months: boolean[]
  tasks: TaskLane[]
  firstMonth: number
}
interface CategoryLane {
  name: string
  color: string
  months: boolean[]
  /** 中分類サブレーン（中分類列が選ばれているとき）。 */
  subs: SubLane[]
  /** 中分類なしのときの直下タスク。 */
  tasks: TaskLane[]
  firstMonth: number
}

/** Separator for 大||中 expand keys (unit-separator char, unlikely in names). */
const SEP = '␟'
const m12 = () => new Array(12).fill(false) as boolean[]
const firstTrue = (b: boolean[]) => {
  const i = b.indexOf(true)
  return i < 0 ? 12 : i
}

export function AnnualPlanPage() {
  const sheetsQ = useSheets()
  const sheets = useMemo(
    () => [...(sheetsQ.data ?? [])].sort((a, b) => a.order - b.order),
    [sheetsQ.data],
  )
  const [sheetIdState, setSheetIdState] = useState<string>('')
  const sheetId = sheetIdState || sheets[0]?.id || ''

  const membersQ = useMembers()
  const detailQ = useQuery({
    queryKey: ['sheet', sheetId],
    queryFn: () => api.getSheet(sheetId),
    enabled: !!sheetId,
  })
  const effortQ = useQuery({
    queryKey: ['effort', sheetId],
    queryFn: () => api.getEffort(sheetId),
    enabled: !!sheetId,
  })

  const columns = detailQ.data?.columns ?? []
  const rows = useMemo(() => detailQ.data?.rows ?? [], [detailQ.data])
  const effort: Effort[] = useMemo(() => effortQ.data ?? [], [effortQ.data])

  // Group-by candidates (same as the dashboard): dropdown / status / member / text.
  const groupable = useMemo(
    () => columns.filter((c) => ['dropdown', 'status', 'member', 'text'].includes(c.type)),
    [columns],
  )
  // Default to the most "category-like" column: a dropdown, else 担当(member),
  // else status, else text. The user can switch to any groupable column.
  const defaultGroupId = useMemo(() => {
    const prio = ['dropdown', 'member', 'status', 'text']
    return [...groupable].sort(
      (a, b) => prio.indexOf(a.type) - prio.indexOf(b.type),
    )[0]?.id
  }, [groupable])
  const [groupByState, setGroupByState] = useState<string>('')
  const groupBy = groupByState || (defaultGroupId != null ? String(defaultGroupId) : '')
  // Column ids are numbers at runtime but the <select> emits strings — compare
  // as strings so a user-picked group column still resolves.
  const groupCol = columns.find((c) => String(c.id) === String(groupBy))

  // Optional 2nd level (中分類). Empty = single level.
  const [subGroupBy, setSubGroupBy] = useState<string>('')
  const subCol =
    subGroupBy && String(subGroupBy) !== String(groupBy)
      ? columns.find((c) => String(c.id) === String(subGroupBy))
      : undefined

  // Weeks (ISO) with any effort, per row.
  const effortWeeksByRow = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of effort) {
      if (num(e.planned_hours) <= 0 && num(e.actual_hours) <= 0) continue
      const s = m.get(e.row_id) ?? new Set<string>()
      s.add(e.week_start)
      m.set(e.row_id, s)
    }
    return m
  }, [effort])

  // Children grouped by parent (a parent task's activity includes its subtasks).
  const childrenByParent = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows)
      if (r.parent_row_id != null) {
        const pid = String(r.parent_row_id)
        const arr = m.get(pid) ?? []
        arr.push(r)
        m.set(pid, arr)
      }
    return m
  }, [rows])

  // Years that have any activity (for the year selector).
  const years = useMemo(() => {
    const set = new Set<number>()
    for (const e of effort) {
      if (num(e.planned_hours) <= 0 && num(e.actual_hours) <= 0) continue
      set.add(parseDate(e.week_start).getFullYear())
    }
    return [...set].sort()
  }, [effort])
  const thisYear = new Date().getFullYear()
  const [yearState, setYearState] = useState<number | null>(null)
  const year =
    yearState ?? (years.includes(thisYear) ? thisYear : years[0] ?? thisYear)

  const membersById = useMemo(() => {
    const m = new Map<string, Member>()
    for (const x of membersQ.data ?? []) m.set(String(x.id), x)
    return m
  }, [membersQ.data])

  function valueOf(row: Row, col: Column | undefined): string {
    if (!col) return UNSET
    const v = row.data[col.id]
    if (v == null || v === '') return UNSET
    if (col.type === 'member') return membersById.get(String(v))?.name ?? UNSET
    return String(v)
  }
  const categoryOf = (row: Row) => valueOf(row, groupCol)
  const subCategoryOf = (row: Row) => valueOf(row, subCol)

  /** A top-level task's active months in `year` (own effort ∪ subtasks' effort). */
  function taskMonths(row: Row): boolean[] {
    const out = new Array(12).fill(false)
    const add = (rowId: string) => {
      for (const w of effortWeeksByRow.get(rowId) ?? []) {
        const d = parseDate(w)
        if (d.getFullYear() === year) out[d.getMonth()] = true
      }
    }
    add(row.id)
    for (const c of childrenByParent.get(String(row.id)) ?? []) add(c.id)
    return out
  }

  // Color per category: reuse dropdown/status option colors when available,
  // else cycle the palette.
  const colorFor = useMemo(() => {
    const optionColors = new Map<string, string>()
    for (const o of groupCol?.config?.options ?? [])
      if (o.color) optionColors.set(o.value, o.color)
    const assigned = new Map<string, string>()
    let next = 0
    return (cat: string): string => {
      if (optionColors.has(cat)) return optionColors.get(cat)!
      if (!assigned.has(cat)) assigned.set(cat, PALETTE[next++ % PALETTE.length])
      return assigned.get(cat)!
    }
  }, [groupCol])

  // Build the (optionally 2-level) category lanes for the selected year.
  const lanes = useMemo<CategoryLane[]>(() => {
    const titleCol = columns.find((c) => c.type === 'text' && !c.is_key)
    const byCat = new Map<
      string,
      { name: string; color: string; months: boolean[]; firstMonth: number; tasks: TaskLane[]; subMap: Map<string, SubLane> }
    >()
    for (const row of rows) {
      if (row.parent_row_id != null) continue // top-level tasks only
      const months = taskMonths(row)
      if (!months.some(Boolean)) continue // not active this year
      const catName = categoryOf(row)
      let cat = byCat.get(catName)
      if (!cat) {
        cat = {
          name: catName,
          color: colorFor(catName),
          months: m12(),
          firstMonth: 12,
          tasks: [],
          subMap: new Map(),
        }
        byCat.set(catName, cat)
      }
      for (let m = 0; m < 12; m++) if (months[m]) cat.months[m] = true
      cat.firstMonth = Math.min(cat.firstMonth, firstTrue(months))
      const task: TaskLane = {
        key: row.key_value,
        title: titleCol ? String(row.data[titleCol.id] ?? '') : '',
        months,
      }
      if (subCol) {
        const subName = subCategoryOf(row)
        let sl = cat.subMap.get(subName)
        if (!sl) {
          sl = { name: subName, months: m12(), tasks: [], firstMonth: 12 }
          cat.subMap.set(subName, sl)
        }
        for (let m = 0; m < 12; m++) if (months[m]) sl.months[m] = true
        sl.firstMonth = Math.min(sl.firstMonth, firstTrue(months))
        sl.tasks.push(task)
      } else {
        cat.tasks.push(task)
      }
    }
    const bySpan = <T extends { firstMonth: number; name: string }>(a: T, b: T) =>
      a.firstMonth - b.firstMonth || a.name.localeCompare(b.name, 'ja')
    return [...byCat.values()]
      .map((c) => ({
        name: c.name,
        color: c.color,
        months: c.months,
        firstMonth: c.firstMonth,
        tasks: c.tasks,
        subs: [...c.subMap.values()].sort(bySpan),
      }))
      .sort(bySpan)
  }, [rows, columns, groupBy, subGroupBy, year, membersById, childrenByParent, effortWeeksByRow])

  /** Total task count under a category (across sub-lanes or direct tasks). */
  const catCount = (lane: CategoryLane) =>
    subCol ? lane.subs.reduce((s, sub) => s + sub.tasks.length, 0) : lane.tasks.length

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const currentMonth = year === thisYear ? new Date().getMonth() : -1
  const loading = detailQ.isLoading || effortQ.isLoading

  return (
    <>
      <PageHeader
        title="年間開発計画"
        subtitle="カテゴリで集約した年間の俯瞰（こまごましたタスクは1本の帯に集約／数値なし）"
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        {/* controls */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--ink2)]">
          {sheets.length > 1 && (
            <label className="flex items-center gap-2">
              シート
              <Select value={sheetId} onChange={(e) => setSheetIdState(e.target.value)}>
                {sheets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="flex items-center gap-2">
            年
            <Select
              value={String(year)}
              onChange={(e) => setYearState(Number(e.target.value))}
            >
              {(years.length ? years : [thisYear]).map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            大分類
            <Select value={groupBy} onChange={(e) => setGroupByState(e.target.value)}>
              {groupable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            中分類
            <Select value={subGroupBy} onChange={(e) => setSubGroupBy(e.target.value)}>
              <option value="">（なし）</option>
              {groupable
                .filter((c) => String(c.id) !== String(groupBy))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </label>
        </div>

        <Card>
          <CardBody className="px-0 py-0">
            {loading ? (
              <div className="px-5 py-8 text-center text-[var(--ink3)]">読み込み中…</div>
            ) : lanes.length === 0 ? (
              <div className="px-5 py-8 text-center text-[var(--ink3)]">
                {year}年に予定のあるタスクがありません。
              </div>
            ) : (
              <div className="min-w-[680px]">
                <MonthHeader currentMonth={currentMonth} />
                {lanes.map((lane) => (
                  <div key={lane.name}>
                    {/* 大分類 lane */}
                    <LaneRow
                      label={
                        <button
                          type="button"
                          onClick={() => toggle(lane.name)}
                          className="flex w-full items-center gap-1 overflow-hidden text-left text-[12.5px] font-medium text-[var(--ink)] hover:text-[var(--green-d)]"
                          title="クリックで内訳を表示"
                        >
                          <Chevron open={expanded.has(lane.name)} />
                          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: lane.color }} />
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                            {lane.name}
                          </span>
                          <span className="flex-shrink-0 text-[10.5px] text-[var(--ink3)]">
                            {catCount(lane)}
                          </span>
                        </button>
                      }
                      months={lane.months}
                      color={lane.color}
                      currentMonth={currentMonth}
                      tier="cat"
                    />
                    {expanded.has(lane.name) &&
                      (subCol
                        ? lane.subs.map((sub) => {
                            const subKey = lane.name + SEP + sub.name
                            return (
                              <div key={subKey}>
                                {/* 中分類 sub-lane */}
                                <LaneRow
                                  label={
                                    <button
                                      type="button"
                                      onClick={() => toggle(subKey)}
                                      className="flex w-full items-center gap-1 overflow-hidden pl-4 text-left text-[12px] text-[var(--ink2)] hover:text-[var(--green-d)]"
                                      title="クリックでタスクを表示"
                                    >
                                      <Chevron open={expanded.has(subKey)} />
                                      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                        {sub.name}
                                      </span>
                                      <span className="flex-shrink-0 text-[10.5px] text-[var(--ink3)]">
                                        {sub.tasks.length}
                                      </span>
                                    </button>
                                  }
                                  months={sub.months}
                                  color={lane.color}
                                  currentMonth={currentMonth}
                                  tier="sub"
                                />
                                {expanded.has(subKey) &&
                                  sub.tasks.map((t, i) => (
                                    <LaneRow
                                      key={`${t.key}-${i}`}
                                      label={<TaskLabel t={t} pad="pl-9" />}
                                      months={t.months}
                                      color={lane.color}
                                      currentMonth={currentMonth}
                                      tier="task"
                                    />
                                  ))}
                              </div>
                            )
                          })
                        : lane.tasks.map((t, i) => (
                            <LaneRow
                              key={`${t.key}-${i}`}
                              label={<TaskLabel t={t} pad="pl-5" />}
                              months={t.months}
                              color={lane.color}
                              currentMonth={currentMonth}
                              tier="task"
                            />
                          )))}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <p className="px-1 text-[11.5px] text-[var(--ink3)]">
          帯＝そのカテゴリに属するタスク（子タスク含む）が動く月。予定/実績の入って
          いる週から算出（数値は表示しない）。大分類クリックで中分類／タスクの内訳を
          表示。「大分類・中分類」で集約軸の列を切り替え（中分類は任意）。
        </p>
      </div>
    </>
  )
}

/** Sticky-ish month label header aligned with the lane tracks. */
function MonthHeader({ currentMonth }: { currentMonth: number }) {
  return (
    <div className="flex items-center border-b border-[var(--line)] bg-[#F7F5EE]">
      <div className="w-[200px] flex-shrink-0 px-3 py-2 text-[11px] font-semibold text-[var(--ink3)]">
        カテゴリ
      </div>
      <div className="grid flex-1" style={{ gridTemplateColumns: 'repeat(12, 1fr)' }}>
        {MONTHS.map((m, i) => (
          <div
            key={m}
            className={cnMonth(i === currentMonth)}
          >
            {m}
          </div>
        ))}
      </div>
    </div>
  )
}

function cnMonth(isCurrent: boolean): string {
  return [
    'border-l border-[var(--line2)] py-2 text-center text-[11px]',
    isCurrent ? 'bg-[var(--green-l)]/15 font-semibold text-[var(--green-d)]' : 'text-[var(--ink3)]',
  ].join(' ')
}

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronUpIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ink3)]" />
  ) : (
    <ChevronDownIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--ink3)]" />
  )
}

function TaskLabel({ t, pad }: { t: TaskLane; pad: string }) {
  return (
    <div
      className={`flex items-center gap-1.5 overflow-hidden ${pad} text-[11.5px] text-[var(--ink2)]`}
    >
      <span className="flex-shrink-0 font-medium text-[var(--ink3)]">{t.key}</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t.title}</span>
    </div>
  )
}

/** One swimlane row: a label cell + a 12-month track with rounded activity bars.
 *  tier controls bar weight/indent: 大(cat) > 中(sub) > タスク(task). */
function LaneRow({
  label,
  months,
  color,
  currentMonth,
  tier,
}: {
  label: React.ReactNode
  months: boolean[]
  color: string
  currentMonth: number
  tier: 'cat' | 'sub' | 'task'
}) {
  const runs = runsOf(months)
  const barH = tier === 'cat' ? 13 : tier === 'sub' ? 11 : 9
  const barOpacity = tier === 'cat' ? 1 : tier === 'sub' ? 0.82 : 0.5
  return (
    <div
      className={[
        'flex items-stretch border-b border-[var(--line2)]',
        tier === 'cat' ? 'bg-[var(--surface)]' : 'bg-[#FCFBF7]',
      ].join(' ')}
    >
      <div className="flex w-[200px] flex-shrink-0 items-center px-3 py-2">{label}</div>
      <div className="relative flex-1">
        {/* month gridlines */}
        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: 'repeat(12, 1fr)' }}
        >
          {MONTHS.map((_m, i) => (
            <div
              key={i}
              className={
                i === currentMonth
                  ? 'border-l border-[var(--line2)] bg-[var(--green-l)]/10'
                  : 'border-l border-[var(--line2)]'
              }
            />
          ))}
        </div>
        {/* activity bars */}
        {runs.map(([s, e]) => (
          <div
            key={s}
            className="absolute top-1/2 -translate-y-1/2 rounded-full"
            style={{
              left: `calc(${(s / 12) * 100}% + 3px)`,
              width: `calc(${((e - s + 1) / 12) * 100}% - 6px)`,
              height: barH,
              background: color,
              opacity: barOpacity,
            }}
            title={`${MONTHS[s]}月〜${MONTHS[e]}月`}
          />
        ))}
      </div>
    </div>
  )
}
