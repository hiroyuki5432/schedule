import { describe, expect, it } from 'vitest'
import {
  boardReadOnlyReason,
  buildLoad,
  buildTasks,
  defaultCategoryColumn,
  defaultStateColumn,
  doneLanesLast,
  laneOptions,
  loadWeeks,
  shortDate,
} from '@/lib/dashboard'
import type { BuildArgs } from '@/lib/dashboard'
import { makeIsRowDone } from '@/lib/status'
import type { ScheduleRowModel } from '@/hooks/useScheduleData'
import type { Column, Effort, Member, Row } from '@/types/api'

const col = (id: string, name: string, type: Column['type'], config: Column['config'] = null): Column => ({
  id,
  sheet_id: '1',
  name,
  type,
  order: Number(id),
  is_key: false,
  config,
})

const START = col('1', '開始日', 'date', { sched_role: 'start' })
const END = col('2', '完了日', 'date', { sched_role: 'end' })
const STATUS = col('3', 'ステータス', 'status', { rules: [] })
const CAT = col('4', 'タスクカテゴリ', 'dropdown', {
  options: [{ value: 'PDK' }, { value: '活動' }, { value: 'その他' }],
})
const COLUMNS = [START, END, STATUS, CAT]

function model(
  id: string,
  data: Row['data'],
  extra: Partial<ScheduleRowModel> = {},
): ScheduleRowModel {
  const row: Row = {
    id,
    sheet_id: '1',
    parent_row_id: null,
    key_value: `T-${id}`,
    data,
    version: 1,
    progress: null,
    progress_week: null,
    depends_on: [],
  }
  return {
    row,
    keyValue: row.key_value,
    title: '',
    assigneeName: null,
    assigneeId: null,
    status: null,
    hasChildren: false,
    startIdx: null,
    finishIdx: null,
    ...extra,
  } as ScheduleRowModel
}

// weeks[0] = 2026-11-02 (Mon) … 4 weeks
const WEEKS = [0, 1, 2, 3].map((i) => new Date(2026, 10, 2 + i * 7))
const TODAY = '2026-11-03'
const memberName = new Map([['7', '佐藤']])

function args(rows: ScheduleRowModel[], effort: Effort[] = []): BuildArgs {
  return {
    rows,
    columns: COLUMNS,
    weeks: WEEKS,
    today: TODAY,
    effort,
    isDone: makeIsRowDone(COLUMNS, memberName),
    categoryCol: CAT,
    stateCol: STATUS,
    memberName,
    computedValue: () => null,
  }
}

describe('buildTasks', () => {
  it('開始日を過ぎて未完了なら開発中、未来なら開始前、完了は完了', () => {
    const [a, b, c] = buildTasks(
      args([
        model('1', { '1': '2026-11-01', '3': '進行中', '4': 'PDK' }),
        model('2', { '1': '2026-11-10', '3': '未着手' }),
        model('3', { '1': '2026-10-01', '3': '完了' }),
      ]),
    )
    expect(a.phase).toBe('active')
    expect(a.category).toBe('PDK')
    expect(a.state).toBe('進行中')
    expect(b.phase).toBe('upcoming')
    expect(c.phase).toBe('done')
  })

  it('今日が開始日なら開発中', () => {
    const [t] = buildTasks(args([model('1', { '1': TODAY })]))
    expect(t.phase).toBe('active')
  })

  it('開始日の列が空なら予定工数の最初の週を使い、それも無ければ nostart', () => {
    const [a, b] = buildTasks(
      args([model('1', {}, { startIdx: 0, finishIdx: 1 }), model('2', {})]),
    )
    expect(a.start).toBe('2026-11-02')
    expect(a.startFrom).toBe('effort')
    expect(a.due).toBe('2026-11-15') // 最後の週（11/9）の週末
    expect(a.phase).toBe('active')
    expect(b.phase).toBe('nostart')
  })

  it('期限超過は未完了かつ期限が今日より前', () => {
    const [a, b] = buildTasks(
      args([
        model('1', { '1': '2026-10-01', '2': '2026-11-02' }),
        model('2', { '1': '2026-10-01', '2': '2026-11-02', '3': '完了' }),
      ]),
    )
    expect(a.overdue).toBe(true)
    expect(b.overdue).toBe(false)
  })

  it('取り込みで残った「2026/11/01 00:00:00」形式の日付も読む', () => {
    const [t] = buildTasks(args([model('1', { '1': '2026/11/01 00:00:00' })]))
    expect(t.start).toBe('2026-11-01')
  })

  it('予定・実績はその行そのものの工数だけを足す', () => {
    const [t] = buildTasks(
      args(
        [model('1', {})],
        [
          { row_id: '1', week_start: '2026-11-02', planned_hours: 10, actual_hours: 4 },
          { row_id: '1', week_start: '2026-11-09', planned_hours: 5, actual_hours: null },
          { row_id: '2', week_start: '2026-11-09', planned_hours: 99, actual_hours: 99 },
        ],
      ),
    )
    expect(t.planned).toBe(15)
    expect(t.actual).toBe(4)
  })
})

describe('buildLoad', () => {
  const members: Member[] = [
    { id: '7', name: '佐藤', email: '', role: 'member', worklog_required: false, is_active: true },
  ]
  const weeks = loadWeeks('2026-11-02', 2)

  it('担当ごとに件数と週ごとの予定工数を出す。完了した行の工数は数えない', () => {
    const tasks = buildTasks(
      args(
        [
          model('1', { '1': '2026-11-01' }, { assigneeId: '7', assigneeName: '佐藤' }),
          model('2', { '1': '2026-12-01' }, { assigneeId: '7', assigneeName: '佐藤' }),
          model('3', { '1': '2026-10-01', '3': '完了' }, { assigneeId: '7', assigneeName: '佐藤' }),
          model('4', { '1': '2026-11-01' }),
        ],
      ),
    )
    const effort: Effort[] = [
      { row_id: '1', week_start: '2026-11-02', planned_hours: 30, actual_hours: null },
      { row_id: '2', week_start: '2026-11-02', planned_hours: 20, actual_hours: null },
      { row_id: '3', week_start: '2026-11-02', planned_hours: 50, actual_hours: null },
      { row_id: '4', week_start: '2026-11-09', planned_hours: 8, actual_hours: null },
      { row_id: '1', week_start: '2026-10-26', planned_hours: 99, actual_hours: null },
    ]
    const load = buildLoad(tasks, effort, weeks, members)
    expect(load.map((r) => r.name)).toEqual(['佐藤', '担当なし'])
    expect(load[0]).toMatchObject({ active: 1, upcoming: 1, overdue: 0, hours: [50, 0] })
    expect(load[1]).toMatchObject({ active: 1, hours: [0, 8] })
  })

  it('親の行は件数に入れないが、親そのものの工数は数える', () => {
    const tasks = buildTasks(
      args([
        model('1', { '1': '2026-11-01' }, { assigneeId: '7', assigneeName: '佐藤', hasChildren: true }),
      ]),
    )
    const load = buildLoad(
      tasks,
      [{ row_id: '1', week_start: '2026-11-09', planned_hours: 6, actual_hours: null }],
      weeks,
      members,
    )
    expect(load[0]).toMatchObject({ active: 0, hours: [0, 6] })
  })
})

describe('laneOptions', () => {
  it('プルダウンは設定の順、選択肢に無い値も列にし、最後に未設定', () => {
    const lanes = laneOptions(CAT, [], ['活動', '旧区分', ''])
    expect(lanes.map((l) => l.value)).toEqual(['PDK', '活動', 'その他', '旧区分', ''])
  })
})

describe('shortDate', () => {
  it('今年は月/日、それ以外は年つき', () => {
    expect(shortDate('2026-12-06', TODAY)).toBe('12/6')
    expect(shortDate('2027-02-28', TODAY)).toBe('2027/2/28')
    expect(shortDate(null, TODAY)).toBe('—')
  })
})

describe('doneLanesLast', () => {
  it('完了の行だけの列を最後へ（未設定はさらに後ろ）', () => {
    const lanes = ['遅延', '完了', '進行中', '済', ''].map((value) => ({ value }))
    const tasks = [
      { state: '済', done: true },
      { state: '進行中', done: false },
    ]
    expect(doneLanesLast(lanes, tasks).map((l) => l.value)).toEqual(['遅延', '進行中', '完了', '済', ''])
  })
})

describe('既定の列と読み取り専用', () => {
  it('カテゴリは名前で当たるときだけ選ぶ', () => {
    expect(defaultCategoryColumn(COLUMNS)?.id).toBe('4')
    expect(defaultCategoryColumn([STATUS, col('9', '担当', 'member')])).toBeUndefined()
  })

  it('状態はステータス型の列を優先', () => {
    expect(defaultStateColumn([CAT, STATUS])?.id).toBe('3')
  })

  it('自動ステータス・計算列はボードから動かせない', () => {
    expect(boardReadOnlyReason(STATUS)).toBeNull()
    expect(boardReadOnlyReason(CAT)).toBeNull()
    expect(
      boardReadOnlyReason(col('5', 'ステータス', 'status', { auto_from_milestones: true })),
    ).toMatch(/マイルストン/)
    expect(boardReadOnlyReason(col('6', '区分', 'lookup'))).toMatch(/計算/)
  })
})
