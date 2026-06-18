import { useMemo } from 'react'
import { useSheets, useMembers, useWeekStartWeekday } from '@/hooks/useSheets'
import { useScheduleData } from '@/hooks/useScheduleData'
import { useAuth } from '@/hooks/useAuth'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'

export function MyTasksPage() {
  const { user } = useAuth()
  const weekStartWeekday = useWeekStartWeekday()
  const sheetsQ = useSheets()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])
  const sheetId = sheetsQ.data?.[0]?.id

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
      <PageHeader title="マイタスク" subtitle="自分が担当している行" />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        <Card>
          <CardBody className="px-0 py-0">
            {grid.loading ? (
              <div className="px-5 py-4 text-[var(--ink3)]">読み込み中…</div>
            ) : mine.length === 0 ? (
              <div className="px-5 py-4 text-[var(--ink3)]">
                担当しているタスクはありません。
              </div>
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
                      <td className="px-5 py-2.5 font-semibold">{r.keyValue}</td>
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
