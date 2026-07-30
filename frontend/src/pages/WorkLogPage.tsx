// 実績入力 page: record the day's work as lines (task / 大分類 / 中分類 / メモ / 時間).
// Saved lines edit in place and save on change. The bottom blank row auto-creates
// a line as soon as you enter hours — no separate "add" click. Hours roll up into
// each task's weekly actual (see backend worklog_service).

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOrg } from '@/hooks/useSheets'
import { useAuth } from '@/hooks/useAuth'
import { useWorkLogs, useWorkLogMutations } from '@/hooks/useWorkLog'
import { WorkLogRow } from '@/components/worklog/WorkLogRow'
import { WorkLogCard } from '@/components/worklog/WorkLogCard'
import type { WorkLogRowValue } from '@/components/worklog/WorkLogRow'
import { WorklogMasterEditor } from '@/components/worklog/WorklogMasterEditor'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsIcon } from '@/components/ui/icons'
import { fmtISO, parseDate } from '@/lib/dates'
import { categoryLevels } from '@/lib/worklogCats'
import * as api from '@/api/client'
import type { WorkLog, WorkLogInput } from '@/types/api'

const EMPTY_DRAFT: WorkLogRowValue = {
  row_id: null,
  row_key_value: null,
  row_label: null,
  cat1: null,
  cat2: null,
  cat3: null,
  memo: null,
  hours: null,
}

function toRowValue(log: WorkLog): WorkLogRowValue {
  return {
    row_id: log.row_id,
    row_key_value: log.row_key_value,
    row_label: log.row_label,
    cat1: log.cat1,
    cat2: log.cat2,
    cat3: log.cat3,
    memo: log.memo,
    hours: log.hours,
  }
}

function toInput(v: WorkLogRowValue, work_date: string): WorkLogInput {
  return {
    work_date,
    row_id: v.row_id,
    cat1: v.cat1,
    cat2: v.cat2,
    cat3: v.cat3,
    memo: v.memo,
    hours: v.hours ?? 0,
  }
}

const TH = 'px-2 py-2.5 font-medium'

export function WorkLogPage() {
  // Deep-link from a 未入力 notification: ?date=YYYY-MM-DD opens that day.
  const [searchParams] = useSearchParams()
  const [date, setDate] = useState(() => searchParams.get('date') || fmtISO(new Date()))
  const [draft, setDraft] = useState<WorkLogRowValue>(EMPTY_DRAFT)
  const [draftKey, setDraftKey] = useState(0) // bump to remount the draft row after create
  const [showSettings, setShowSettings] = useState(false)

  // Follow later ?date changes (e.g. clicking another 未入力 notification).
  const dateParam = searchParams.get('date')
  useEffect(() => {
    if (dateParam) setDate(dateParam)
  }, [dateParam])

  const [copying, setCopying] = useState(false)
  const qc = useQueryClient()

  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const orgQ = useOrg()
  const master = orgQ.data?.settings?.worklog
  const note = master?.note?.trim()
  const tasksQ = useQuery({ queryKey: ['my-tasks'], queryFn: api.getMyTasks })
  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data])
  const multiSheet = useMemo(() => new Set(tasks.map((t) => t.sheet_id)).size > 1, [tasks])

  const logsQ = useWorkLogs(date, date)
  const { create, update, remove } = useWorkLogMutations()

  const logs = logsQ.data ?? []
  const total = useMemo(() => logs.reduce((s, l) => s + (l.hours ?? 0), 0), [logs])
  const masterEmpty = (master?.categories?.length ?? 0) === 0
  // 分類の段数・名称は設定で変わる（既定: 大分類・中分類）。
  const levels = useMemo(() => categoryLevels(master), [master])

  function shiftDay(delta: number) {
    const d = parseDate(date)
    d.setDate(d.getDate() + delta)
    setDate(fmtISO(d))
  }

  // Duplicate the previous day's lines into the current date — for people whose
  // work is similar day to day (just tweak the hours). Skips if there are none.
  async function copyYesterday() {
    const d = parseDate(date)
    d.setDate(d.getDate() - 1)
    const yIso = fmtISO(d)
    setCopying(true)
    try {
      const prev = await api.getWorkLogs({ from: yIso, to: yIso })
      if (prev.length === 0) {
        alert('前日の実績入力がありません。')
        return
      }
      await Promise.all(
        prev.map((l) =>
          api.createWorkLog({
            work_date: date,
            row_id: l.row_id,
            cat1: l.cat1,
            cat2: l.cat2,
            cat3: l.cat3,
            memo: l.memo,
            hours: l.hours,
          }),
        ),
      )
      qc.invalidateQueries({ queryKey: ['worklogs'] })
      qc.invalidateQueries({ queryKey: ['effort'] })
      qc.invalidateQueries({ queryKey: ['aggregate'] })
      qc.invalidateQueries({ queryKey: ['sheet'] })
    } finally {
      setCopying(false)
    }
  }

  // Draft row: merge edits; once hours > 0 is entered, auto-create the line.
  function onDraftChange(patch: Partial<WorkLogRowValue>) {
    const next = { ...draft, ...patch }
    if ('hours' in patch && patch.hours != null && patch.hours > 0) {
      create.mutate(toInput(next, date), {
        onSuccess: () => {
          setDraft(EMPTY_DRAFT)
          setDraftKey((k) => k + 1)
        },
      })
    } else {
      setDraft(next)
    }
  }

  function updateLog(id: string, patch: Partial<WorkLogRowValue>) {
    const { row_key_value: _omit, ...rest } = patch
    const body = { ...rest } as Partial<WorkLogInput>
    if ('hours' in body && body.hours == null) body.hours = 0
    update.mutate({ id, patch: body })
  }

  const stepBtn =
    'rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-[14px] leading-none text-[var(--ink2)] hover:bg-[var(--line2)]'

  return (
    <>
      <PageHeader
        title="実績入力"
        subtitle="日々の作業を記録（タスクの実績に自動反映）"
        actions={
          <div className="flex items-center gap-2">
            <button className={stepBtn} title="前の日" onClick={() => shiftDay(-1)}>
              ‹
            </button>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-[160px]"
            />
            <button className={stepBtn} title="次の日" onClick={() => shiftDay(1)}>
              ›
            </button>
            <Button variant="outline" size="sm" onClick={() => setDate(fmtISO(new Date()))}>
              今日
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={copyYesterday}
              disabled={copying}
              title="前日の入力をこの日にコピー（時間だけ直せばOK）"
            >
              前日コピー
            </Button>
            {isAdmin && (
              <Button
                variant={showSettings ? 'primary' : 'outline'}
                size="sm"
                onClick={() => setShowSettings((s) => !s)}
                title="分類（段数・項目）と記載ルールの設定"
              >
                <SettingsIcon className="h-[15px] w-[15px]" />
                分類の設定
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-3 overflow-auto px-[22px] pb-6">
        {isAdmin && showSettings && <WorklogMasterEditor onClose={() => setShowSettings(false)} />}

        {masterEmpty && !showSettings && (
          <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--line)] bg-[#FBFAF5] px-3 py-2 text-[12px] text-[var(--ink3)]">
            <span>
              分類は未登録です。
              {isAdmin
                ? '「分類の設定」で段（大分類・中分類…）と項目を自由に作れます。'
                : '管理者が設定します。'}
              未登録でもタスク・メモ・時間だけで記録できます。
            </span>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setShowSettings(true)}>
                分類を設定する
              </Button>
            )}
          </div>
        )}

        {/* Desktop: dense table. Mobile: stacked cards (see below). */}
        <Card className="hidden md:block">
          <CardBody className="overflow-x-auto px-0 py-0">
            <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                  <th className={TH} style={{ width: 300 }}>
                    タスク
                  </th>
                  {levels.map((l, i) => (
                    <th key={l + i} className={TH}>
                      {l}
                    </th>
                  ))}
                  <th className={TH}>メモ・詳細</th>
                  <th className={`${TH} text-right`} style={{ width: 90 }}>
                    時間(h)
                  </th>
                  <th className={TH} style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {logsQ.isLoading ? (
                  <tr>
                    <td colSpan={4 + levels.length} className="px-3 py-4 text-[var(--ink3)]">
                      読み込み中…
                    </td>
                  </tr>
                ) : (
                  logs.map((l) => (
                    <WorkLogRow
                      key={l.id}
                      value={toRowValue(l)}
                      tasks={tasks}
                      multiSheet={multiSheet}
                      master={master}
                      onChange={(patch) => updateLog(l.id, patch)}
                      onDelete={() => remove.mutate(l.id)}
                    />
                  ))
                )}
                <WorkLogRow
                  key={`draft-${draftKey}`}
                  value={draft}
                  tasks={tasks}
                  multiSheet={multiSheet}
                  master={master}
                  onChange={onDraftChange}
                />
              </tbody>
            </table>

            <div className="flex items-center justify-between border-t border-[var(--line2)] px-3 py-2.5">
              <span className="text-[12px] text-[var(--ink3)]">
                一番下の空行に入力すると自動で追加されます（時間を入れると確定）。
              </span>
              <div className="text-[12.5px] text-[var(--ink2)]">
                合計 <b className="text-[var(--ink)]">{total}</b> h
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Mobile: stacked cards (big tap targets, decimal keypad for hours). */}
        <div className="flex flex-col gap-2 md:hidden">
          {logsQ.isLoading ? (
            <div className="rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-3 py-4 text-[12.5px] text-[var(--ink3)]">
              読み込み中…
            </div>
          ) : (
            logs.map((l) => (
              <WorkLogCard
                key={l.id}
                value={toRowValue(l)}
                tasks={tasks}
                multiSheet={multiSheet}
                master={master}
                onChange={(patch) => updateLog(l.id, patch)}
                onDelete={() => remove.mutate(l.id)}
              />
            ))
          )}
          <WorkLogCard
            key={`draft-card-${draftKey}`}
            value={draft}
            tasks={tasks}
            multiSheet={multiSheet}
            master={master}
            onChange={onDraftChange}
          />
          <div className="flex items-center justify-between px-1 py-1 text-[12px] text-[var(--ink2)]">
            <span className="text-[var(--ink3)]">時間を入れると自動で追加されます。</span>
            <span>
              合計 <b className="text-[var(--ink)]">{total}</b> h
            </span>
          </div>
        </div>

        {note && (
          <div className="rounded-[10px] border border-[var(--line)] bg-[#FBFAF5] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--ink2)]">
            <div className="mb-0.5 font-medium text-[var(--ink3)]">記載ルール</div>
            <div className="whitespace-pre-wrap">{note}</div>
          </div>
        )}
      </div>
    </>
  )
}
