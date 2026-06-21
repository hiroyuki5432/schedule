// 年間開発計画ビュー — カテゴリ・スイムレーン年表。
//
// 最大3段のカテゴリ（大→中→小、いずれもシートの列で指定）でタスクを集約し、
// 各カテゴリが年内のどの月に動くかを帯で俯瞰する（数値なし）。大分類は左の
// グループ見出し（帯なし）、中分類・小分類は集約した1本の帯。個別タスク（件名）は
// 既定では出さず、件名を見たい場合は分類に件名列を指定する。活動月は予定/実績
// 工数のある週から算出。親タスクは子タスク（子の工数）も含めて集計する。

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers, useSheets } from '@/hooks/useSheets'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { parseDate } from '@/lib/dates'
import { cn } from '@/lib/format'
import type { Column, Effort, Member, Row } from '@/types/api'

// Fiscal year: April(4) through next March(3).
const MONTHS = ['4', '5', '6', '7', '8', '9', '10', '11', '12', '1', '2', '3']
/** Fiscal year a date belongs to (Apr–Dec → that year; Jan–Mar → prev year). */
const fiscalYearOf = (d: Date) => (d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1)
/** Column index 0..11 for a date within the fiscal year (April = 0). */
const fiscalCol = (d: Date) => (d.getMonth() - 3 + 12) % 12
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

const m12 = () => new Array(12).fill(false) as boolean[]
const firstTrue = (b: boolean[]) => {
  const i = b.indexOf(true)
  return i < 0 ? 12 : i
}
const orInto = (t: boolean[], s: boolean[]) => {
  for (let i = 0; i < 12; i++) if (s[i]) t[i] = true
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

/** One node in the 大→中→小 grouping tree. */
interface CatNode {
  name: string
  color: string
  months: boolean[]
  count: number
  firstMonth: number
  children: CatNode[]
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

  // Group-by candidates: dropdown / status / member / text (件名 is text, so it
  // can be chosen as a level to get task-title granularity).
  const groupable = useMemo(
    () => columns.filter((c) => ['dropdown', 'status', 'member', 'text'].includes(c.type)),
    [columns],
  )
  const defaultBigId = useMemo(() => {
    const prio = ['dropdown', 'member', 'status', 'text']
    return [...groupable].sort((a, b) => prio.indexOf(a.type) - prio.indexOf(b.type))[0]?.id
  }, [groupable])

  const [bigState, setBigState] = useState('')
  const [midState, setMidState] = useState('')
  const [smallState, setSmallState] = useState('')
  const big = bigState || (defaultBigId != null ? String(defaultBigId) : '')
  const mid = midState
  const small = smallState

  const findCol = (id: string) => columns.find((c) => String(c.id) === String(id))
  const bigCol = findCol(big)
  const midCol = mid && String(mid) !== String(big) ? findCol(mid) : undefined
  const smallCol =
    midCol && small && String(small) !== String(big) && String(small) !== String(mid)
      ? findCol(small)
      : undefined
  const levelCols = [bigCol, midCol, smallCol].filter(Boolean) as Column[]

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

  const years = useMemo(() => {
    const set = new Set<number>()
    for (const e of effort) {
      if (num(e.planned_hours) <= 0 && num(e.actual_hours) <= 0) continue
      set.add(fiscalYearOf(parseDate(e.week_start)))
    }
    return [...set].sort()
  }, [effort])
  const thisYear = fiscalYearOf(new Date())
  const [yearState, setYearState] = useState<number | null>(null)
  const year = yearState ?? (years.includes(thisYear) ? thisYear : years[0] ?? thisYear)

  const membersById = useMemo(() => {
    const m = new Map<string, Member>()
    for (const x of membersQ.data ?? []) m.set(String(x.id), x)
    return m
  }, [membersQ.data])

  function valueOf(row: Row, col: Column): string {
    const v = row.data[col.id]
    if (v == null || v === '') return UNSET
    if (col.type === 'member') return membersById.get(String(v))?.name ?? UNSET
    return String(v)
  }

  /** A top-level task's active months in `year` (own effort ∪ subtasks' effort). */
  function taskMonths(row: Row): boolean[] {
    const out = m12()
    const add = (rowId: string) => {
      for (const w of effortWeeksByRow.get(rowId) ?? []) {
        const d = parseDate(w)
        if (fiscalYearOf(d) === year) out[fiscalCol(d)] = true
      }
    }
    add(row.id)
    for (const c of childrenByParent.get(String(row.id)) ?? []) add(c.id)
    return out
  }

  const colorFor = useMemo(() => {
    const optionColors = new Map<string, string>()
    for (const o of bigCol?.config?.options ?? []) if (o.color) optionColors.set(o.value, o.color)
    const assigned = new Map<string, string>()
    let next = 0
    return (cat: string): string => {
      if (optionColors.has(cat)) return optionColors.get(cat)!
      if (!assigned.has(cat)) assigned.set(cat, PALETTE[next++ % PALETTE.length])
      return assigned.get(cat)!
    }
  }, [bigCol])

  // Build the 大→中→小 tree for the selected year.
  const tree = useMemo<CatNode[]>(() => {
    if (levelCols.length === 0) return []
    const rootChildren: CatNode[] = []
    const rootMap = new Map<string, CatNode>()
    for (const row of rows) {
      if (row.parent_row_id != null) continue // top-level tasks only
      const months = taskMonths(row)
      if (!months.some(Boolean)) continue // not active this year
      let children = rootChildren
      let map = rootMap
      let color = ''
      for (let d = 0; d < levelCols.length; d++) {
        const val = valueOf(row, levelCols[d])
        let node = map.get(val)
        if (!node) {
          color = d === 0 ? colorFor(val) : color
          node = { name: val, color, months: m12(), count: 0, firstMonth: 12, children: [] }
          map.set(val, node)
          children.push(node)
        } else if (d === 0) {
          color = node.color
        }
        orInto(node.months, months)
        node.firstMonth = Math.min(node.firstMonth, firstTrue(months))
        node.count += 1
        children = node.children
        // Each node keeps its own child map keyed by name via a side table.
        map = childMapOf(node)
      }
    }
    const sortRec = (arr: CatNode[]) => {
      arr.sort((a, b) => a.firstMonth - b.firstMonth || a.name.localeCompare(b.name, 'ja'))
      for (const n of arr) sortRec(n.children)
    }
    sortRec(rootChildren)
    return rootChildren
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, big, mid, small, year, membersById, childrenByParent, effortWeeksByRow])

  const currentMonth = year === thisYear ? fiscalCol(new Date()) : -1
  const loading = detailQ.isLoading || effortQ.isLoading

  const midOptions = groupable.filter((c) => String(c.id) !== String(big))
  const smallOptions = groupable.filter(
    (c) => String(c.id) !== String(big) && String(c.id) !== String(mid),
  )

  return (
    <>
      <PageHeader
        title="年間開発計画"
        subtitle="カテゴリ（最大3段）で集約した年間の俯瞰。大分類は見出し、中・小分類は1本の帯（数値なし）"
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
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
            年度
            <Select value={String(year)} onChange={(e) => setYearState(Number(e.target.value))}>
              {(years.length ? years : [thisYear]).map((y) => (
                <option key={y} value={y}>
                  {y}年度（{y}/4〜{y + 1}/3）
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            大分類
            <Select value={big} onChange={(e) => setBigState(e.target.value)}>
              {groupable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2">
            中分類
            <Select value={mid} onChange={(e) => setMidState(e.target.value)}>
              <option value="">（なし）</option>
              {midOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className={cn('flex items-center gap-2', !midCol && 'opacity-40')}>
            小分類
            <Select
              value={small}
              disabled={!midCol}
              onChange={(e) => setSmallState(e.target.value)}
            >
              <option value="">（なし）</option>
              {smallOptions.map((c) => (
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
            ) : tree.length === 0 ? (
              <div className="px-5 py-8 text-center text-[var(--ink3)]">
                {year}年度に予定のあるタスクがありません。
              </div>
            ) : (
              <div className="min-w-[680px]">
                <MonthHeader currentMonth={currentMonth} />
                {tree.map((node) => (
                  <NodeRows
                    key={node.name}
                    node={node}
                    depth={0}
                    levels={levelCols.length}
                    color={node.color}
                    currentMonth={currentMonth}
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <p className="px-1 text-[11.5px] text-[var(--ink3)]">
          帯＝そのカテゴリのタスク（子タスク含む）が動く月。予定/実績の入っている週から
          算出（数値なし）。大分類は左の見出し（帯なし）、中・中分類/小分類は集約した1本の帯。
          件名を出したい場合は分類に件名列を指定してください。
        </p>
      </div>
    </>
  )
}

// Per-node child map, stored off-tree so CatNode stays serializable-ish.
const _childMaps = new WeakMap<CatNode, Map<string, CatNode>>()
function childMapOf(node: CatNode): Map<string, CatNode> {
  let m = _childMaps.get(node)
  if (!m) {
    m = new Map()
    _childMaps.set(node, m)
  }
  return m
}

/** Render a node and its descendants. depth 0 大 with children = group header
 *  (no bar); other levels show a single aggregate bar. */
function NodeRows({
  node,
  depth,
  levels,
  color,
  currentMonth,
}: {
  node: CatNode
  depth: number
  levels: number
  color: string
  currentMonth: number
}) {
  const isHeader = depth === 0 && levels > 1
  return (
    <>
      <LaneRow
        label={
          <div
            className="flex items-center gap-1.5 overflow-hidden"
            style={{ paddingLeft: depth * 18 }}
          >
            {depth === 0 && (
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: color }} />
            )}
            <span
              className={cn(
                'overflow-hidden text-ellipsis whitespace-nowrap',
                isHeader ? 'text-[12.5px] font-medium text-[var(--ink)]' : 'text-[12px] text-[var(--ink2)]',
              )}
            >
              {node.name}
            </span>
            <span className="flex-shrink-0 text-[10.5px] text-[var(--ink3)]">{node.count}</span>
          </div>
        }
        months={node.months}
        color={color}
        currentMonth={currentMonth}
        bold={isHeader}
        barH={isHeader ? 0 : depth >= 2 ? 9 : 13}
        barOpacity={depth >= 2 ? 0.55 : depth === 1 ? 0.88 : 1}
      />
      {node.children.map((c) => (
        <NodeRows
          key={c.name}
          node={c}
          depth={depth + 1}
          levels={levels}
          color={color}
          currentMonth={currentMonth}
        />
      ))}
    </>
  )
}

function MonthHeader({ currentMonth }: { currentMonth: number }) {
  return (
    <div className="flex items-center border-b border-[var(--line)] bg-[#F7F5EE]">
      <div className="w-[200px] flex-shrink-0 px-3 py-2 text-[11px] font-semibold text-[var(--ink3)]">
        カテゴリ
      </div>
      <div className="grid flex-1" style={{ gridTemplateColumns: 'repeat(12, 1fr)' }}>
        {MONTHS.map((m, i) => (
          <div key={m} className={cnMonth(i === currentMonth)}>
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

/** One swimlane row: a label cell + a 12-month track with rounded bars. */
function LaneRow({
  label,
  months,
  color,
  currentMonth,
  barH,
  barOpacity,
  bold,
}: {
  label: React.ReactNode
  months: boolean[]
  color: string
  currentMonth: number
  barH: number
  barOpacity: number
  bold: boolean
}) {
  const runs = runsOf(months)
  return (
    <div
      className={['flex items-stretch border-b border-[var(--line2)]', bold ? 'bg-[var(--surface)]' : 'bg-[#FCFBF7]'].join(' ')}
    >
      <div className="flex w-[200px] flex-shrink-0 items-center px-3 py-2">{label}</div>
      <div className="relative flex-1">
        <div className="absolute inset-0 grid" style={{ gridTemplateColumns: 'repeat(12, 1fr)' }}>
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
        {barH > 0 &&
          runs.map(([s, e]) => (
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
