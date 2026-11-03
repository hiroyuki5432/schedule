// ダッシュボード — スケジュール1枚を対象に、
//   概要: 件数のカード／カテゴリ別の件数（状態の内訳）／担当者別の負荷／案件の一覧
//   ボード: 状態の列ごとのカンバン（ドラッグで状態を変える）
//   工数の集計: 予定 vs 実績・バーンアップ・月別・ピボット（従来の画面）
//
// 「カテゴリの列」「状態の列」は利用者が選ぶ（シートの列は利用者が定義するので、
// アプリ側で PDK などの語彙を持たない）。名前で当たるときだけ既定で選び、そのことを画面に出す。
import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useSelectedSheet } from '@/hooks/useSelectedSheet'
import { useScheduleData } from '@/hooks/useScheduleData'
import { useComputedValues } from '@/hooks/useComputedValues'
import { usePersistentState } from '@/hooks/usePersistentState'
import { useRowMutation } from '@/hooks/useRowMutation'
import { PageHeader } from '@/components/PageHeader'
import { SheetPicker } from '@/components/SheetPicker'
import { Card, CardBody } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { Tabs } from '@/components/ui/Tabs'
import { DownloadIcon } from '@/components/ui/icons'
import { Overview } from '@/components/dashboard/Overview'
import type { Scope } from '@/components/dashboard/Overview'
import { Board } from '@/components/dashboard/Board'
import { EffortSummary } from '@/components/dashboard/EffortSummary'
import { Timeline } from '@/components/dashboard/Timeline'
import { fmtISO, startOfWeek } from '@/lib/dates'
import { makeIsRowDone } from '@/lib/status'
import { ApiError } from '@/lib/http'
import { toast } from '@/lib/toast'
import {
  boardReadOnlyReason,
  buildLoad,
  buildTasks,
  categoryColumnCandidates,
  defaultCategoryColumn,
  defaultStateColumn,
  doneLanesLast,
  laneOptions,
  loadWeeks,
  stateColumnCandidates,
} from '@/lib/dashboard'
import type { TaskInfo } from '@/lib/dashboard'
import type { Column, Effort } from '@/types/api'

type TabKey = 'overview' | 'board' | 'timeline' | 'effort'
const TABS = [
  { key: 'overview', label: '概要' },
  { key: 'board', label: 'ボード' },
  { key: 'timeline', label: '期間' },
  { key: 'effort', label: '工数の集計' },
] as const

/** 列の選び方。undefined = 既定（名前で当てる）、'' = 使わない、それ以外 = 列id。 */
interface ColChoice {
  cat?: string
  state?: string
}
/** 絞り込み。null = すべて（'' は「未設定」「担当なし」という値）。 */
interface Filters {
  cat: string | null
  who: string | null
  state: string | null
}
const NO_FILTER: Filters = { cat: null, who: null, state: null }
const ANY = '__any__'
const NONE = '__none__'

function pickColumn(
  candidates: Column[],
  choice: string | undefined,
  fallback: Column | undefined,
): { col: Column | undefined; auto: boolean } {
  if (choice === '') return { col: undefined, auto: false }
  const chosen = choice ? candidates.find((c) => String(c.id) === choice) : undefined
  if (chosen) return { col: chosen, auto: false }
  return { col: fallback, auto: !!fallback }
}

export function DashboardPage() {
  const weekStartWeekday = useWeekStartWeekday()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])
  const { sheets, sheetId, setSheetId, loading: sheetsLoading } = useSelectedSheet(
    'view:dashboard:sheetId',
    true,
  )
  const [tab, setTab] = usePersistentState<TabKey>('view:dashboard:tab', 'overview')
  const [scope, setScope] = usePersistentState<Scope>('view:dashboard:scope', 'active')
  const [showDone, setShowDone] = usePersistentState('view:dashboard:boardShowDone', false)
  const [choice, setChoice] = usePersistentState<ColChoice>(
    sheetId ? `view:dashboard:${sheetId}:cols` : null,
    {},
  )
  const [filters, setFilters] = usePersistentState<Filters>(
    sheetId ? `view:dashboard:${sheetId}:filters` : null,
    NO_FILTER,
  )

  const grid = useScheduleData({ sheetId, weekStartWeekday, members, asOfWeek: null })
  const effortQ = useQuery({
    queryKey: ['effort', sheetId],
    queryFn: () => api.getEffort(sheetId!),
    enabled: !!sheetId,
  })
  const effort: Effort[] = useMemo(() => effortQ.data ?? [], [effortQ.data])
  const { computedValue } = useComputedValues(grid.columns, members)

  const memberName = useMemo(
    () => new Map(members.map((m) => [String(m.id), m.name])),
    [members],
  )
  // 完了判定はスケジュール・マイタスクと同じ（シート設定の done_filter → status列）。
  const isDone = useMemo(
    () => makeIsRowDone(grid.columns, memberName, grid.detail?.sheet?.settings?.done_filter),
    [grid.columns, memberName, grid.detail],
  )

  const catCands = useMemo(() => categoryColumnCandidates(grid.columns), [grid.columns])
  const stateCands = useMemo(() => stateColumnCandidates(grid.columns), [grid.columns])
  const cat = pickColumn(catCands, choice.cat, defaultCategoryColumn(grid.columns))
  const state = pickColumn(stateCands, choice.state, defaultStateColumn(grid.columns))

  const today = fmtISO(new Date())
  const currentWeek = fmtISO(startOfWeek(new Date(), weekStartWeekday))

  const allTasks = useMemo(
    () =>
      buildTasks({
        rows: grid.rows,
        columns: grid.columns,
        weeks: grid.weeks,
        today,
        effort,
        isDone,
        categoryCol: cat.col,
        stateCol: state.col,
        memberName,
        computedValue,
      }),
    [grid.rows, grid.columns, grid.weeks, today, effort, isDone, cat.col, state.col, memberName, computedValue],
  )
  const plainRows = useMemo(() => grid.rows.map((r) => r.row), [grid.rows])
  const leaves = useMemo(() => allTasks.filter((t) => !t.isParent), [allTasks])

  const lanes = useMemo(
    () => doneLanesLast(laneOptions(state.col, plainRows, leaves.map((t) => t.state)), leaves),
    [state.col, plainRows, leaves],
  )
  const categoryLanes = useMemo(
    () => laneOptions(cat.col, plainRows, leaves.map((t) => t.category)),
    [cat.col, plainRows, leaves],
  )

  const whoKey = (t: TaskInfo) => (t.m.assigneeId ? String(t.m.assigneeId) : '')
  const filtered = useMemo(
    () =>
      allTasks.filter(
        (t) =>
          (filters.cat == null || !cat.col || t.category === filters.cat) &&
          (filters.who == null || whoKey(t) === filters.who) &&
          (filters.state == null || !state.col || t.state === filters.state),
      ),
    [allTasks, filters, cat.col, state.col],
  )

  const weekIsos = useMemo(() => loadWeeks(currentWeek), [currentWeek])
  const load = useMemo(
    () => buildLoad(filtered, effort, weekIsos, members),
    [filtered, effort, weekIsos, members],
  )

  // 絞り込みの候補は、出ている値だけ（選んでも0件、を作らない）。
  const whoOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of leaves) seen.set(whoKey(t), t.m.assigneeName ?? (t.m.assigneeId ? '（不明な担当者）' : '担当なし'))
    const order = new Map(members.map((m, i) => [String(m.id), i]))
    return [...seen.entries()].sort(
      (a, b) => (a[0] === '' ? 1e9 : (order.get(a[0]) ?? 1e8)) - (b[0] === '' ? 1e9 : (order.get(b[0]) ?? 1e8)),
    )
  }, [leaves, members])
  const catValues = categoryLanes.map((l) => l.value).filter((v) => leaves.some((t) => t.category === v))
  const stateValues = lanes.map((l) => l.value).filter((v) => leaves.some((t) => t.state === v))

  // --- ボードのドラッグ → 状態の列を書き換える ------------------------------
  const qc = useQueryClient()
  const rowMut = useRowMutation(sheetId)
  const [pending, setPending] = useState<Map<string, string>>(new Map())
  const tasksRef = useRef(allTasks)
  tasksRef.current = allTasks
  const stateCol = state.col
  const move = async (rowId: string, value: string, undoable: boolean) => {
    if (!stateCol) return
    const t = tasksRef.current.find((x) => String(x.m.row.id) === rowId)
    if (!t) return
    const before = t.state
    const prevStored = t.m.row.data[stateCol.id] ?? null
    setPending((p) => new Map(p).set(rowId, value))
    try {
      await rowMut.mutateAsync({ row: t.m.row, patch: { [stateCol.id]: value === '' ? null : value } })
      await qc.refetchQueries({ queryKey: ['sheet', sheetId] })
      if (undoable)
        toast.show(`${t.m.keyValue} を「${value || '（未設定）'}」にしました`, 'success', 6000, {
          label: '元に戻す',
          onClick: () => void restore(rowId, prevStored == null ? '' : String(prevStored), before),
        })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409))
        toast.show(`${t.m.keyValue} を変更できませんでした。`, 'error')
    } finally {
      setPending((p) => {
        const n = new Map(p)
        n.delete(rowId)
        return n
      })
    }
  }
  // 元に戻すは「保存されていた値」に戻す（ルールで出ていた表示値ではなく）。
  const restore = async (rowId: string, stored: string, shown: string) => {
    if (!stateCol) return
    const t = tasksRef.current.find((x) => String(x.m.row.id) === rowId)
    if (!t) return
    setPending((p) => new Map(p).set(rowId, shown))
    try {
      await rowMut.mutateAsync({ row: t.m.row, patch: { [stateCol.id]: stored === '' ? null : stored } })
      await qc.refetchQueries({ queryKey: ['sheet', sheetId] })
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409))
        toast.show(`${t.m.keyValue} を元に戻せませんでした。`, 'error')
    } finally {
      setPending((p) => {
        const n = new Map(p)
        n.delete(rowId)
        return n
      })
    }
  }

  const filterCount = [filters.cat, filters.who, filters.state].filter((v) => v != null).length
  const loading = sheetsLoading || grid.loading

  return (
    <>
      <PageHeader
        title="ダッシュボード"
        subtitle="開発中の案件・状態・担当者の負荷"
        actions={
          sheetId && (
            <a href={api.exportCsvUrl(sheetId)}>
              <Button variant="outline" size="sm">
                <DownloadIcon className="h-[15px] w-[15px]" />
                CSV
              </Button>
            </a>
          )
        }
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        {loading ? (
          <Card>
            <CardBody className="px-0 py-0">
              <TableSkeleton rows={5} cols={4} />
            </CardBody>
          </Card>
        ) : !sheetId ? (
          <EmptyState
            compact
            title="集計するスケジュールがありません"
            body="左のサイドバーから「シート追加」でスケジュール（週次グリッドあり）を作ると、ここに集計が出ます。"
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Tabs tabs={TABS} active={tab} onChange={setTab} />
              <SheetPicker sheets={sheets} sheetId={sheetId} onChange={setSheetId} />
            </div>

            {tab !== 'effort' && (
              <div className="flex flex-col gap-2 text-[12px] text-[var(--ink2)]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <ColumnPicker
                    label="カテゴリの列"
                    candidates={catCands}
                    col={cat.col}
                    onChange={(v) => {
                      setChoice({ ...choice, cat: v })
                      setFilters({ ...filters, cat: null })
                    }}
                  />
                  <ColumnPicker
                    label="状態の列"
                    candidates={stateCands}
                    col={state.col}
                    onChange={(v) => {
                      setChoice({ ...choice, state: v })
                      setFilters({ ...filters, state: null })
                    }}
                  />
                  {(cat.auto || state.auto) && (
                    <span className="text-[11.5px] text-[var(--ink3)]">
                      {[cat.auto && `「${cat.col!.name}」`, state.auto && `「${state.col!.name}」`]
                        .filter(Boolean)
                        .join('・')}
                      は列名から選びました。違う場合は変えてください（このブラウザに保存）。
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="text-[var(--ink3)]">絞り込み</span>
                  {cat.col && (
                    <FilterSelect
                      label={cat.col.name}
                      value={filters.cat}
                      options={catValues.map((v) => [v, v || '（未設定）'])}
                      onChange={(v) => setFilters({ ...filters, cat: v })}
                    />
                  )}
                  <FilterSelect
                    label="担当"
                    value={filters.who}
                    options={whoOptions}
                    onChange={(v) => setFilters({ ...filters, who: v })}
                  />
                  {state.col && (
                    <FilterSelect
                      label={state.col.name}
                      value={filters.state}
                      options={stateValues.map((v) => [v, v || '（未設定）'])}
                      onChange={(v) => setFilters({ ...filters, state: v })}
                    />
                  )}
                  {filterCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setFilters(NO_FILTER)}
                      className="rounded-[8px] px-2 py-1 text-[var(--green-d)] hover:bg-[var(--line2)]"
                    >
                      絞り込みを解除
                    </button>
                  )}
                </div>
              </div>
            )}

            {tab === 'overview' && (
              <Overview
                sheetId={sheetId}
                tasks={filtered}
                load={load}
                loadWeekIsos={weekIsos}
                lanes={lanes}
                categoryOrder={categoryLanes.map((l) => l.value)}
                hasCategory={!!cat.col}
                hasState={!!state.col}
                scope={scope}
                onScope={setScope}
                onPickAssignee={(key) => setFilters({ ...filters, who: key })}
              />
            )}
            {tab === 'board' && (
              <Board
                sheetId={sheetId}
                tasks={filtered.filter((t) => !t.isParent)}
                lanes={lanes}
                stateCol={state.col}
                readOnlyReason={boardReadOnlyReason(state.col)}
                showDone={showDone}
                onShowDone={setShowDone}
                hasCategory={!!cat.col}
                pending={pending}
                onMove={(t, v) => void move(String(t.m.row.id), v, true)}
              />
            )}
            {tab === 'timeline' && (
              <Timeline
                sheetId={sheetId}
                tasks={filtered.filter((t) => !t.isParent)}
                lanes={lanes}
                today={today}
                currentWeek={currentWeek}
                scope={scope}
                onScope={setScope}
              />
            )}
            {tab === 'effort' && (
              <EffortSummary
                columns={grid.columns}
                tasks={allTasks}
                effort={effort}
                todayWeek={currentWeek}
                memberName={memberName}
                computedValue={computedValue}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

function ColumnPicker({
  label,
  candidates,
  col,
  onChange,
}: {
  label: string
  candidates: Column[]
  col: Column | undefined
  onChange: (v: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      {label}
      <Select value={col ? String(col.id) : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">（使わない）</option>
        {candidates.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name}
          </option>
        ))}
      </Select>
    </label>
  )
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string | null
  options: Array<[string, string]>
  onChange: (v: string | null) => void
}) {
  // value '' (未設定・担当なし) と「すべて」を区別するため、select の値は置き換える。
  const enc = (v: string | null) => (v == null ? ANY : v === '' ? NONE : v)
  const dec = (v: string) => (v === ANY ? null : v === NONE ? '' : v)
  // 保存しておいた値がもう無い（選択肢を消した等）ときも、選んだままだと分かるように出す。
  const all =
    value != null && !options.some(([v]) => v === value)
      ? [...options, [value, `${value || '（未設定）'}（該当なし）`] as [string, string]]
      : options
  return (
    <label className="flex items-center gap-2">
      {label}
      <Select value={enc(value)} onChange={(e) => onChange(dec(e.target.value))}>
        <option value={ANY}>すべて</option>
        {all.map(([v, text]) => (
          <option key={enc(v)} value={enc(v)}>
            {text}
          </option>
        ))}
      </Select>
    </label>
  )
}
