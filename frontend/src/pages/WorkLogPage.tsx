// 実績入力 page: record the day's work as lines (task / 大分類 / 中分類 / メモ / 時間).
// Saved lines edit in place and save on change. The bottom blank row auto-creates
// a line as soon as you enter hours — no separate "add" click. Hours roll up into
// each task's weekly actual (see backend worklog_service).

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useOrg } from '@/hooks/useSheets'
import { useAuth } from '@/hooks/useAuth'
import { useWorkLogs, useWorkLogMutations } from '@/hooks/useWorkLog'
import { WorkLogRow } from '@/components/worklog/WorkLogRow'
import type { WorkLogRowValue } from '@/components/worklog/WorkLogRow'
import { WorklogMasterEditor } from '@/components/worklog/WorklogMasterEditor'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SettingsIcon } from '@/components/ui/icons'
import { fmtISO, parseDate } from '@/lib/dates'
import * as api from '@/api/client'
import type { WorkLog, WorkLogInput } from '@/types/api'

const EMPTY_DRAFT: WorkLogRowValue = {
  row_id: null,
  row_key_value: null,
  cat1: null,
  cat2: null,
  memo: null,
  hours: null,
}

function toRowValue(log: WorkLog): WorkLogRowValue {
  return {
    row_id: log.row_id,
    row_key_value: log.row_key_value,
    cat1: log.cat1,
    cat2: log.cat2,
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
    memo: v.memo,
    hours: v.hours ?? 0,
  }
}

const TH = 'px-2 py-2.5 font-medium'

export function WorkLogPage() {
  const [date, setDate] = useState(() => fmtISO(new Date()))
  const [draft, setDraft] = useState<WorkLogRowValue>(EMPTY_DRAFT)
  const [draftKey, setDraftKey] = useState(0) // bump to remount the draft row after create
  const [showSettings, setShowSettings] = useState(false)

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

  function shiftDay(delta: number) {
    const d = parseDate(date)
    d.setDate(d.getDate() + delta)
    setDate(fmtISO(d))
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
            {isAdmin && (
              <Button
                variant={showSettings ? 'primary' : 'outline'}
                size="sm"
                onClick={() => setShowSettings((s) => !s)}
                title="分類・記載ルールの設定"
              >
                <SettingsIcon className="h-[15px] w-[15px]" />
                設定
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-3 overflow-auto px-[22px] pb-6">
        {isAdmin && showSettings && <WorklogMasterEditor onClose={() => setShowSettings(false)} />}

        {masterEmpty && (
          <div className="rounded-[10px] border border-[var(--line)] bg-[#FBFAF5] px-3 py-2 text-[12px] text-[var(--ink3)]">
            分類は未登録です。{isAdmin ? '右上の「設定」から登録できます。' : '管理者が設定します。'}
            未登録でもタスク・メモ・時間だけで記録できます。
          </div>
        )}

        <Card>
          <CardBody className="overflow-x-auto px-0 py-0">
            <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                  <th className={TH} style={{ width: 300 }}>
                    タスク
                  </th>
                  <th className={TH}>大分類</th>
                  <th className={TH}>中分類</th>
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
                    <td colSpan={6} className="px-3 py-4 text-[var(--ink3)]">
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
