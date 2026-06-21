// みんなの入力一覧 — 全員の実績入力（日報）を1日分まとめて表示する読み取り専用ビュー。
// ユーザー別にグループ化し、各人合計＋全員合計を出す。前日/翌日/今日で日付を移動。

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { fmtISO, parseDate } from '@/lib/dates'
import type { UserDayWorkLog } from '@/types/api'

const round1 = (x: number) => Math.round(x * 10) / 10

function todayIso(): string {
  return fmtISO(new Date())
}
function shiftIso(iso: string, days: number): string {
  const d = parseDate(iso)
  d.setDate(d.getDate() + days)
  return fmtISO(d)
}
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
function dowLabel(iso: string): string {
  return `（${WEEKDAYS[parseDate(iso).getDay()]}）`
}

export function AllUsersWorklogPage() {
  const [date, setDate] = useState<string>(todayIso())
  const isToday = date === todayIso()

  const q = useQuery({
    queryKey: ['all-worklog', date],
    queryFn: () => api.getAllUsersWorklog(date),
  })
  const users = q.data ?? []
  const grandTotal = users.reduce((s, u) => s + u.total_hours, 0)

  return (
    <>
      <PageHeader title="みんなの入力一覧" subtitle="全員の実績入力（日報）を日別に集約" />

      <div className="flex flex-col gap-3 overflow-auto px-[22px] pb-6">
        {/* date nav */}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setDate(shiftIso(date, -1))}>
            ◀ 前日
          </Button>
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px]"
          />
          <Button variant="outline" size="sm" onClick={() => setDate(shiftIso(date, 1))}>
            翌日 ▶
          </Button>
          <Button
            variant={isToday ? 'primary' : 'outline'}
            size="sm"
            onClick={() => setDate(todayIso())}
          >
            今日
          </Button>
          <span className="text-[13px] text-[var(--ink3)]">
            {date} {dowLabel(date)}
            {isToday && '（本日）'}
          </span>
        </div>

        <Card>
          <CardBody className="px-0 py-0">
            {q.isLoading ? (
              <div className="px-5 py-8 text-center text-[var(--ink3)]">読み込み中…</div>
            ) : (
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                    <th className="px-4 py-2.5 font-medium">タスク</th>
                    <th className="px-4 py-2.5 font-medium">大分類</th>
                    <th className="px-4 py-2.5 font-medium">中分類</th>
                    <th className="px-4 py-2.5 font-medium">メモ・詳細</th>
                    <th className="px-4 py-2.5 text-right font-medium">時間(h)</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <UserGroup key={u.user_id} user={u} />
                  ))}
                  <tr className="border-t-2 border-[var(--line)] bg-[#F4F1E8]">
                    <td className="px-4 py-2.5 font-semibold" colSpan={4}>
                      全員合計
                    </td>
                    <td className="px-4 py-2.5 text-right font-semibold">{round1(grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  )
}

function UserGroup({ user }: { user: UserDayWorkLog }) {
  const empty = user.logs.length === 0
  return (
    <>
      <tr className="border-b border-[var(--line2)] bg-[#EEF1F6]">
        <td className="px-4 py-2 font-bold text-[var(--ink)]" colSpan={empty ? 4 : 1}>
          {user.user_name}
          {empty && <span className="ml-2 font-normal text-[var(--ink3)]">（入力なし）</span>}
        </td>
        {!empty && <td colSpan={3} />}
        <td className="px-4 py-2 text-right font-bold">{empty ? '' : round1(user.total_hours)}</td>
      </tr>
      {user.logs.map((l) => (
        <tr key={l.id} className="border-b border-[var(--line2)]">
          <td className="px-4 py-2 text-[var(--ink3)]">{l.row_key_value ?? ''}</td>
          <td className="px-4 py-2 text-[var(--ink2)]">{l.cat1 ?? ''}</td>
          <td className="px-4 py-2 text-[var(--ink2)]">{l.cat2 ?? ''}</td>
          <td className="px-4 py-2">{l.memo ?? ''}</td>
          <td className="px-4 py-2 text-right">{round1(l.hours)}</td>
        </tr>
      ))}
    </>
  )
}
