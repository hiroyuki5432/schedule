// ダッシュボード（概要・ボード）の集計。
//
// 値はスケジュール画面と同じ関数で出す（ステータスは resolveDisplayValue、参照/数式は
// 計算列の resolver、完了は makeIsRowDone）。サーバの /aggregate は row.data の生の値で
// まとめるため、保存されないステータス・計算列が全部「空」に寄る — 画面と食い違う
// 集計を作らないよう、ここでは画面側の行モデルから数える。

import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import type { Column, Effort, Member, Row } from '@/types/api'
import { addWeeks, dateCellText, fmtISO } from '@/lib/dates'
import { isComputed } from '@/lib/computed'
import type { ComputedResolver } from '@/lib/computed'
import { resolveDisplayValue, statusOptions } from '@/lib/status'

/** 1人1週あたりの上限（負荷の色分けの基準）。 */
export const WEEKLY_CAPACITY_H = 40
/** 負荷を見る週数（今週から）。 */
export const LOAD_WEEKS = 8

/** active=開発中（開始日を過ぎて未完了） upcoming=開始前 done=完了 nostart=開始日が決まらない */
export type Phase = 'active' | 'upcoming' | 'done' | 'nostart'

export interface TaskInfo {
  m: ScheduleRowModel
  /** 子タスクを持つ行。件数・一覧・ボードでは数えない（子タスクで数える）。 */
  isParent: boolean
  start: string | null
  /** 開始日をどこから取ったか: 'column'=開始日の列 'effort'=予定工数の最初の週 */
  startFrom: 'column' | 'effort' | null
  due: string | null
  dueFrom: 'column' | 'effort' | null
  done: boolean
  phase: Phase
  overdue: boolean
  category: string
  state: string
  /** この行そのものの予定・実績の合計（親の合算は含まない＝二重に数えない）。 */
  planned: number
  actual: number
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

function isoOrNull(v: unknown): string | null {
  const s = dateCellText(v)
  return ISO.test(s) ? s : null
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 一覧・カードの日付。今年なら「M/D」、年が違えば「YYYY/M/D」（年をまたぐ期限を取り違えない）。 */
export function shortDate(iso: string | null, today: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  return iso.slice(0, 4) === today.slice(0, 4) ? `${m}/${d}` : `${y}/${m}/${d}`
}

/** 列の値を、画面に出ているとおりの文字列で返す。 */
export function shownValue(
  m: ScheduleRowModel,
  col: Column,
  memberName: Map<string, string>,
  computedValue: ComputedResolver,
): string {
  if (isComputed(col)) return computedValue(col, m.row) ?? ''
  if (col.type === 'date') return dateCellText(m.row.data[col.id])
  return resolveDisplayValue(m, col, memberName)
}

export interface BuildArgs {
  rows: ScheduleRowModel[]
  columns: Column[]
  weeks: Date[]
  /** 今日（YYYY-MM-DD）。 */
  today: string
  effort: Effort[]
  isDone: (m: ScheduleRowModel) => boolean
  categoryCol?: Column
  stateCol?: Column
  memberName: Map<string, string>
  computedValue: ComputedResolver
}

export function buildTasks(a: BuildArgs): TaskInfo[] {
  const startCol = a.columns.find((c) => c.config?.sched_role === 'start')
  const endCol = a.columns.find((c) => c.config?.sched_role === 'end')

  const sums = new Map<string, { p: number; a: number }>()
  for (const e of a.effort) {
    const k = String(e.row_id)
    const cur = sums.get(k) ?? { p: 0, a: 0 }
    cur.p += num(e.planned_hours)
    cur.a += num(e.actual_hours)
    sums.set(k, cur)
  }

  return a.rows.map((m) => {
    const data = m.row.data
    let start = (startCol ? isoOrNull(data[startCol.id]) : null) ?? isoOrNull(data.__sched_start)
    let startFrom: TaskInfo['startFrom'] = start ? 'column' : null
    if (!start && m.startIdx != null && a.weeks[m.startIdx]) {
      start = fmtISO(a.weeks[m.startIdx])
      startFrom = 'effort'
    }
    let due = (endCol ? isoOrNull(data[endCol.id]) : null) ?? isoOrNull(data.__sched_end)
    let dueFrom: TaskInfo['dueFrom'] = due ? 'column' : null
    if (!due && m.finishIdx != null && a.weeks[m.finishIdx]) {
      // 予定工数の最後の週の、週末の日。
      const d = new Date(a.weeks[m.finishIdx].getTime())
      d.setDate(d.getDate() + 6)
      due = fmtISO(d)
      dueFrom = 'effort'
    }

    const done = a.isDone(m)
    const phase: Phase = done
      ? 'done'
      : !start
        ? 'nostart'
        : start <= a.today
          ? 'active'
          : 'upcoming'
    const s = sums.get(String(m.row.id)) ?? { p: 0, a: 0 }
    return {
      m,
      isParent: m.hasChildren,
      start,
      startFrom,
      due,
      dueFrom,
      done,
      phase,
      overdue: !done && due != null && due < a.today,
      category: a.categoryCol
        ? shownValue(m, a.categoryCol, a.memberName, a.computedValue)
        : '',
      state: a.stateCol ? shownValue(m, a.stateCol, a.memberName, a.computedValue) : '',
      planned: s.p,
      actual: s.a,
    }
  })
}

// ---------------------------------------------------------------------------
// 担当者別の負荷

export interface LoadRow {
  /** 担当者 id。'' = 担当なし。 */
  key: string
  name: string
  active: number
  overdue: number
  upcoming: number
  /** 週ごとの予定工数（weekIsos と同じ並び）。 */
  hours: number[]
}

/** 今週から n 週の week_start。 */
export function loadWeeks(currentWeek: string, n = LOAD_WEEKS): string[] {
  return Array.from({ length: n }, (_, i) => addWeeks(currentWeek, i))
}

/**
 * 担当者ごとの件数（開発中・期限超過・開始前）と、週ごとの予定工数。
 * 工数は未完了の行だけを数える（完了した行に残った先の予定は、もう使われないため）。
 * 親の行は件数に入れないが、親そのものに入れた工数は数える（子の分は子の行で数える）。
 */
export function buildLoad(
  tasks: TaskInfo[],
  effort: Effort[],
  weekIsos: string[],
  members: Member[],
): LoadRow[] {
  const byKey = new Map<string, LoadRow>()
  const get = (key: string, name: string) => {
    let r = byKey.get(key)
    if (!r) {
      r = { key, name, active: 0, overdue: 0, upcoming: 0, hours: weekIsos.map(() => 0) }
      byKey.set(key, r)
    }
    return r
  }
  const nameOf = (t: TaskInfo) => t.m.assigneeName ?? (t.m.assigneeId ? '（不明な担当者）' : '担当なし')
  const keyOf = (t: TaskInfo) => (t.m.assigneeName ? String(t.m.assigneeId) : t.m.assigneeId ? `?${t.m.assigneeId}` : '')

  const open = new Map<string, TaskInfo>()
  for (const t of tasks) {
    if (t.done) continue
    open.set(String(t.m.row.id), t)
    if (t.isParent) continue
    if (t.phase !== 'active' && t.phase !== 'upcoming' && !t.overdue) continue
    const r = get(keyOf(t), nameOf(t))
    if (t.phase === 'active') r.active += 1
    if (t.phase === 'upcoming') r.upcoming += 1
    if (t.overdue) r.overdue += 1
  }

  const weekIdx = new Map(weekIsos.map((w, i) => [w, i]))
  for (const e of effort) {
    const i = weekIdx.get(e.week_start)
    if (i == null) continue
    const t = open.get(String(e.row_id))
    if (!t) continue
    const h = num(e.planned_hours)
    if (h === 0) continue
    get(keyOf(t), nameOf(t)).hours[i] += h
  }

  // 並びはメンバー管理の順。知らない担当者、担当なしは後ろ。
  const order = new Map(members.map((mb, i) => [String(mb.id), i]))
  const rank = (r: LoadRow) =>
    r.key === '' ? 1e9 + 1 : r.key.startsWith('?') ? 1e9 : (order.get(r.key) ?? 1e9)
  return [...byKey.values()].sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name, 'ja'))
}

// ---------------------------------------------------------------------------
// 状態の並び（グラフの内訳・ボードの列）

export interface Lane {
  /** 保存される値。'' = 未設定。 */
  value: string
  color?: string
  bg?: string
}

/**
 * 状態の列の選択肢を、設定の並び順で返す。末尾に「未設定」('')。
 * `present` は実際に出ている値 — 選択肢に無い値も列として残す（行が消えて見えないように）。
 */
export function laneOptions(col: Column | undefined, rows: Row[], present: string[]): Lane[] {
  const lanes: Lane[] = []
  const seen = new Set<string>()
  const add = (l: Lane) => {
    if (seen.has(l.value)) return
    seen.add(l.value)
    lanes.push(l)
  }
  if (col?.type === 'status') {
    for (const o of statusOptions(col, rows)) add({ value: o.value, color: o.badge.color, bg: o.badge.bg })
  } else if (col?.type === 'dropdown') {
    for (const o of col.config?.options ?? []) add({ value: o.value, bg: o.color })
  }
  const rest = present.filter((v) => v !== '' && !seen.has(v))
  rest.sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }))
  for (const v of rest) add({ value: v })
  add({ value: '' })
  return lanes
}

/**
 * 完了を表す列を最後へ回す（ステータスのルールは判定の優先順なので、そのまま並べると
 * 「完了」が途中に来る）。行があれば「その値の行がすべて完了」で判定し、行が無い値は
 * 完了判定の既定と同じく「完了」という名前で見る。
 */
export function doneLanesLast(lanes: Lane[], tasks: Array<Pick<TaskInfo, 'state' | 'done'>>): Lane[] {
  const isDoneLane = (l: Lane) => {
    if (l.value === '') return false
    const ts = tasks.filter((t) => t.state === l.value)
    return ts.length > 0 ? ts.every((t) => t.done) : l.value === '完了'
  }
  const unset = lanes.filter((l) => l.value === '')
  const rest = lanes.filter((l) => l.value !== '')
  return [...rest.filter((l) => !isDoneLane(l)), ...rest.filter(isDoneLane), ...unset]
}

/** ボードでカードを動かせる列か。動かせないなら理由を返す。 */
export function boardReadOnlyReason(col: Column | undefined): string | null {
  if (!col) return '状態の列が選ばれていません。'
  if (isComputed(col)) return `「${col.name}」は計算で決まる列なので、ボードからは変えられません。`
  if (col.type === 'status' && col.config?.auto_from_milestones)
    return `「${col.name}」はマイルストンから自動で決まるので、ボードからは変えられません。`
  if (col.type !== 'status' && col.type !== 'dropdown')
    return `「${col.name}」はプルダウンでもステータスでもないので、ボードからは変えられません。`
  return null
}

/** 状態の列の候補（ステータス・プルダウン・計算列）。 */
export function stateColumnCandidates(columns: Column[]): Column[] {
  return columns.filter((c) => ['status', 'dropdown', 'lookup', 'formula'].includes(c.type))
}

/** カテゴリの列の候補。 */
export function categoryColumnCandidates(columns: Column[]): Column[] {
  return columns.filter((c) => ['dropdown', 'text', 'lookup', 'formula', 'status'].includes(c.type) && !c.is_key)
}

const CATEGORY_NAME = /カテゴリ|分類|区分|種別|category/i
const STATE_NAME = /状態|ステータス|status/i

/**
 * 既定の列。名前で当てるだけで、当たらなければ選ばない（推測で結線しない）。
 * 状態はステータス型の列があればそれ（スケジュールのステータスと同じもの）。
 */
export function defaultCategoryColumn(columns: Column[]): Column | undefined {
  return categoryColumnCandidates(columns).find((c) => CATEGORY_NAME.test(c.name))
}

export function defaultStateColumn(columns: Column[]): Column | undefined {
  const cands = stateColumnCandidates(columns)
  return cands.find((c) => c.type === 'status') ?? cands.find((c) => STATE_NAME.test(c.name))
}
