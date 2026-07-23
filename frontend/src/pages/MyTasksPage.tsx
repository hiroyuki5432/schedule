import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useSelectedSheet } from '@/hooks/useSelectedSheet'
import { useScheduleData } from '@/hooks/useScheduleData'
import { useAuth } from '@/hooks/useAuth'
import { PageHeader } from '@/components/PageHeader'
import { SheetPicker } from '@/components/SheetPicker'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'

export function MyTasksPage() {
  const { user } = useAuth()
  const weekStartWeekday = useWeekStartWeekday()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])
  const { sheets, sheetId, setSheetId, loading: sheetsLoading } = useSelectedSheet(
    'view:myTasks:sheetId',
    true,
  )

  const grid = useScheduleData({
    sheetId,
    weekStartWeekday,
    members,
    asOfWeek: null,
  })

  // "自分担当の行" filter (SPEC 3 / 5).
  const mine = useMemo(
    () => grid.rows.filter((r) => r.assigneeId && r.assigneeId === user?.id),
    [grid.rows, user?.id],
  )

  return (
    <>
      <PageHeader
        title="マイタスク"
        subtitle="自分が担当しているタスク"
        actions={<SheetPicker sheets={sheets} sheetId={sheetId} onChange={setSheetId} />}
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        <Card>
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
                title="このシートで担当しているタスクはありません"
                body="担当者の列に自分が設定されたタスクがここに出ます。別のシートを見るには右上で切り替えてください。"
              />
            ) : (
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                    <th className="px-5 py-2.5 font-medium">ID</th>
                    <th className="px-5 py-2.5 font-medium">件名</th>
                    <th className="px-5 py-2.5 font-medium">担当</th>
                    <th className="px-5 py-2.5 font-medium">ステータス</th>
                    <th className="px-5 py-2.5 text-right font-medium">予定計</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.row.id} className="border-b border-[var(--line2)]">
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
                      <td className="px-5 py-2.5">{r.title}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={r.assigneeName} seed={r.assigneeId} />
                          {r.assigneeName}
                        </div>
                      </td>
                      <td className="px-5 py-2.5">
                        {r.status && (
                          <Badge color={r.status.color} bg={r.status.bg}>
                            {r.status.label}
                          </Badge>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[var(--ink2)]">
                        {r.gantt.plannedSum}h
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
