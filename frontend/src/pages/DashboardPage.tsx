import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useSheets } from '@/hooks/useSheets'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { DownloadIcon } from '@/components/ui/icons'
import type { AggregateRow } from '@/types/api'

export function DashboardPage() {
  const sheetsQ = useSheets()
  const sheetId = sheetsQ.data?.[0]?.id

  const columnsQ = useQuery({
    queryKey: ['columns', sheetId],
    queryFn: () => api.getColumns(sheetId!),
    enabled: !!sheetId,
  })

  // Group-by candidates: dropdown / member / status / text columns.
  const groupable = useMemo(
    () =>
      (columnsQ.data ?? []).filter((c) =>
        ['dropdown', 'member', 'status', 'text'].includes(c.type),
      ),
    [columnsQ.data],
  )

  const [groupBy, setGroupBy] = useState<string>('')
  const effectiveGroupBy = groupBy || groupable[0]?.id || ''

  const aggQ = useQuery({
    queryKey: ['aggregate', sheetId, effectiveGroupBy],
    queryFn: () => api.getAggregate(sheetId!, effectiveGroupBy),
    enabled: !!sheetId && !!effectiveGroupBy,
  })

  const rows = aggQ.data ?? []

  return (
    <>
      <PageHeader
        title="ダッシュボード"
        subtitle="シート単位の予定/実績集計"
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
        <div className="flex items-center gap-2 text-[12px] text-[var(--ink2)]">
          グループ化:
          <Select
            value={effectiveGroupBy}
            onChange={(e) => setGroupBy(e.target.value)}
          >
            {groupable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>

        {!sheetId ? (
          <Card>
            <CardBody className="text-[var(--ink3)]">シートがありません。</CardBody>
          </Card>
        ) : aggQ.isLoading ? (
          <Card>
            <CardBody className="text-[var(--ink3)]">読み込み中…</CardBody>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>予定 vs 実績（グループ別）</CardTitle>
              </CardHeader>
              <CardBody>
                <BarChart rows={rows} />
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>ピボット表</CardTitle>
              </CardHeader>
              <CardBody className="px-0 py-0">
                <PivotTable rows={rows} />
              </CardBody>
            </Card>
          </>
        )}
      </div>
    </>
  )
}

function PivotTable({ rows }: { rows: AggregateRow[] }) {
  if (rows.length === 0) {
    return <div className="px-5 py-4 text-[var(--ink3)]">データがありません。</div>
  }
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
          <th className="px-5 py-2.5 font-medium">グループ</th>
          <th className="px-5 py-2.5 text-right font-medium">予定計</th>
          <th className="px-5 py-2.5 text-right font-medium">実績計</th>
          <th className="px-5 py-2.5 text-right font-medium">件数</th>
          <th className="px-5 py-2.5 text-right font-medium">消化率</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const rate = r.planned_sum > 0 ? r.actual_sum / r.planned_sum : 0
          return (
            <tr key={r.group} className="border-b border-[var(--line2)]">
              <td className="px-5 py-2.5">{r.group || '（未設定）'}</td>
              <td className="px-5 py-2.5 text-right">{r.planned_sum}h</td>
              <td className="px-5 py-2.5 text-right">{r.actual_sum}h</td>
              <td className="px-5 py-2.5 text-right">{r.count}</td>
              <td className="px-5 py-2.5 text-right">{Math.round(rate * 100)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// Tiny inline-SVG grouped bar chart (planned vs actual). No chart library.
function BarChart({ rows }: { rows: AggregateRow[] }) {
  if (rows.length === 0) {
    return <div className="text-[var(--ink3)]">データがありません。</div>
  }
  const max = Math.max(1, ...rows.flatMap((r) => [r.planned_sum, r.actual_sum]))
  const barH = 200
  const groupW = 84
  const W = Math.max(rows.length * groupW + 40, 320)
  const H = barH + 48

  return (
    <div className="overflow-x-auto">
      <svg width={W} height={H} role="img">
        {/* baseline */}
        <line
          x1={0}
          y1={barH + 8}
          x2={W}
          y2={barH + 8}
          stroke="var(--line)"
        />
        {rows.map((r, i) => {
          const x = 20 + i * groupW
          const ph = (r.planned_sum / max) * barH
          const ah = (r.actual_sum / max) * barH
          return (
            <g key={r.group}>
              <rect
                x={x}
                y={barH + 8 - ph}
                width={26}
                height={ph}
                rx={3}
                fill="var(--p-review)"
              />
              <rect
                x={x + 30}
                y={barH + 8 - ah}
                width={26}
                height={ah}
                rx={3}
                fill="var(--p-impl)"
              />
              <text
                x={x + 28}
                y={barH + 26}
                textAnchor="middle"
                fontSize={11}
                fill="var(--ink2)"
              >
                {(r.group || '—').slice(0, 6)}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="mt-2 flex gap-4 text-[12px] text-[var(--ink2)]">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] bg-[var(--p-review)]" />予定
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[3px] bg-[var(--p-impl)]" />実績
        </span>
      </div>
    </div>
  )
}
