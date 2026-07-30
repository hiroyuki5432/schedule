// みんなの入力一覧 — 全員の実績入力（日報）を1日分まとめて表示する読み取り専用ビュー。
// ユーザー別にグループ化し、各人合計＋全員合計を出す。前日/翌日/今日で日付を移動。

import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import { ImportWorklogWizard } from '@/components/import/ImportWorklogWizard'
import { useAuth } from '@/hooks/useAuth'
import { useOrg } from '@/hooks/useSheets'
import { fmtISO, parseDate } from '@/lib/dates'
import { CAT_FIELDS, categoryLevels } from '@/lib/worklogCats'
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
  const orgQ = useOrg()
  // 分類の段数・名称は設定に追従（既定: 大分類・中分類）。
  const levels = useMemo(
    () => categoryLevels(orgQ.data?.settings?.worklog),
    [orgQ.data],
  )
  const users = q.data ?? []
  const grandTotal = users.reduce((s, u) => s + u.total_hours, 0)

  return (
    <>
      <PageHeader
        title="みんなの入力一覧"
        subtitle="全員の実績入力（日報）を日別に集約"
        actions={<WorklogExcelToolbar date={date} />}
      />

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
              <TableSkeleton rows={6} cols={5} />
            ) : users.length === 0 ? (
              <EmptyState
                compact
                title="この日の入力はまだありません"
                body="メンバーが実績入力を保存すると、ここに一覧で出ます。上の日付を変えると別の日を確認できます。"
              />
            ) : (
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                    <th className="px-4 py-2.5 font-medium">タスク</th>
                    {levels.map((l, i) => (
                      <th key={l + i} className="px-4 py-2.5 font-medium">
                        {l}
                      </th>
                    ))}
                    <th className="px-4 py-2.5 font-medium">メモ・詳細</th>
                    <th className="px-4 py-2.5 text-right font-medium">時間(h)</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <UserGroup key={u.user_id} user={u} levelCount={levels.length} />
                  ))}
                  <tr className="border-t-2 border-[var(--line)] bg-[#F4F1E8]">
                    <td className="px-4 py-2.5 font-semibold" colSpan={2 + levels.length}>
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

/** Export the viewed day to Excel; admins can also import (bulk-add) logs.
 *  取り込みはウィザード経由 — 列の対応と、追加/スキップ/重複の件数を確認してから
 *  書き込む（ユーザーは名前、タスクはIDで照合）。 */
function WorklogExcelToolbar({ date }: { date: string }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)

  return (
    <div className="flex items-center gap-2">
      <a href={api.exportWorklogXlsxUrl(date, date)} download>
        <Button size="sm" variant="outline">
          Excel出力
        </Button>
      </a>
      {isAdmin && (
        <>
          <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
            Excel取込
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) setFile(f)
            }}
          />
          {file && (
            <ImportWorklogWizard
              file={file}
              onClose={() => {
                setFile(null)
                if (inputRef.current) inputRef.current.value = ''
              }}
            />
          )}
        </>
      )}
    </div>
  )
}

function UserGroup({ user, levelCount }: { user: UserDayWorkLog; levelCount: number }) {
  const empty = user.logs.length === 0
  const span = 2 + levelCount // タスク + 分類 + メモ
  return (
    <>
      <tr className="border-b border-[var(--line2)] bg-[#EEF1F6]">
        <td className="px-4 py-2 font-bold text-[var(--ink)]" colSpan={empty ? span : 1}>
          {user.user_name}
          {empty && <span className="ml-2 font-normal text-[var(--ink3)]">（入力なし）</span>}
        </td>
        {!empty && <td colSpan={span - 1} />}
        <td className="px-4 py-2 text-right font-bold">{empty ? '' : round1(user.total_hours)}</td>
      </tr>
      {user.logs.map((l) => (
        <tr key={l.id} className="border-b border-[var(--line2)]">
          {/* タスクはシート設定の表示列（既定 ID＋件名）。未設定/未リンクはIDのみ。 */}
          <td className="px-4 py-2 text-[var(--ink2)]">{l.row_label || l.row_key_value || ''}</td>
          {CAT_FIELDS.slice(0, levelCount).map((f) => (
            <td key={f} className="px-4 py-2 text-[var(--ink2)]">
              {l[f] ?? ''}
            </td>
          ))}
          <td className="px-4 py-2">{l.memo ?? ''}</td>
          <td className="px-4 py-2 text-right">{round1(l.hours)}</td>
        </tr>
      ))}
    </>
  )
}
