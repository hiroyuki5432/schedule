// データのお掃除（管理者）。
//
// 要望: 「作ったり消したりを続けているが、基本DBは溜まり続けている？ もしそうなら
// 表面に見えないデータはきれいにできるといい」。答えは Yes で、画面から消しても
// 消えないものがある — 変更履歴・週次スナップショット・既読の通知・**消した列の値**
// （行データの中に列IDのまま残る＝どこにも表示されない）・空の工数セル、そして
// バックアップ（1件がグループ全体の JSON）。
//
// どれも「消していい」と言い切れないので、この画面は
//   ① いま何がどれだけあるかを出す → ② 選ぶ → ③ 消える件数を出す → ④ 実行
// の順に進む。②③のあいだで条件を変えたら、また③からやり直しになる。
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ApiError } from '@/lib/http'
import { toast } from '@/lib/toast'

/** バイト数を人が読める形に。 */
function mb(bytes: number | null | undefined): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function MaintenanceCard() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  // しきい値。既定は「1年より古い履歴」「1年より古い断面」「バックアップは10件」。
  const [eventDays, setEventDays] = useState(365)
  const [snapshotWeeks, setSnapshotWeeks] = useState(52)
  const [backupKeep, setBackupKeep] = useState(10)

  // 何を消すか。既定は「見えないデータだけ」— 履歴と断面は，消すと戻らない記録なので
  // 自分でチェックを入れてもらう。
  const [pick, setPick] = useState({
    events: false,
    snapshots: false,
    notifications: true,
    orphans: true,
    legacy: false,
    effort: true,
    backups: false,
  })

  const usageQ = useQuery({
    queryKey: ['maintenance-usage', eventDays, snapshotWeeks, backupKeep],
    queryFn: () =>
      api.getMaintenanceUsage({
        rowEventsKeepDays: eventDays,
        snapshotsKeepWeeks: snapshotWeeks,
        backupsKeep: backupKeep,
      }),
    enabled: open,
    staleTime: 30_000,
  })
  const c = usageQ.data?.cleanable

  const body = (dryRun: boolean): api.CleanupInput => ({
    row_events_keep_days: pick.events ? eventDays : null,
    snapshots_keep_weeks: pick.snapshots ? snapshotWeeks : null,
    notifications_read: pick.notifications,
    orphan_cells: pick.orphans,
    legacy_cells: pick.legacy,
    empty_effort: pick.effort,
    backups_keep: pick.backups ? backupKeep : null,
    dry_run: dryRun,
  })

  const signature = JSON.stringify(body(true))
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, number> | null>(null)
  const fresh = checkedAt === signature && preview !== null
  const total = useMemo(
    () => Object.values(preview ?? {}).reduce((a, b) => a + b, 0),
    [preview],
  )

  const check = useMutation({
    mutationFn: () => api.runMaintenanceCleanup(body(true)),
    onSuccess: (r) => {
      setPreview(r.deleted)
      setCheckedAt(signature)
    },
    onError: (e) =>
      toast.show(e instanceof ApiError ? e.message : '確認できませんでした', 'error'),
  })

  const run = useMutation({
    mutationFn: () => api.runMaintenanceCleanup(body(false)),
    onSuccess: async (r) => {
      setPreview(null)
      setCheckedAt(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['maintenance-usage'] }),
        qc.invalidateQueries({ queryKey: ['sheet'] }),
        qc.invalidateQueries({ queryKey: ['backups'] }),
        qc.invalidateQueries({ queryKey: ['notifications'] }),
      ])
      toast.show(`お掃除しました（${r.total} 件）`, 'success')
    },
    onError: (e) =>
      toast.show(e instanceof ApiError ? e.message : '削除できませんでした', 'error'),
  })

  const nothing = fresh && total === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>データのお掃除</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--ink2)]">
          このアプリのデータは、画面から行やシートを消しても<b>すべてが消えるわけではありません</b>。
          変更履歴・週次スナップショット（変化点の比較に使う断面）・既読の通知は残り、
          <b>消した列の値</b>は行の中に残ったまま画面のどこにも出ません。取り込みのやり直しを
          繰り返すほど溜まります。ここでは、いまの中身を見て、要らないものだけを消せます。
        </p>

        {!open ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            いまの使用量を見る
          </Button>
        ) : usageQ.isPending ? (
          <div className="text-[12px] text-[var(--ink3)]">読み込み中…</div>
        ) : usageQ.isError || !c ? (
          <div className="text-[12px] text-[#A8442B]">使用量を取得できませんでした。</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="overflow-auto rounded-[10px] border border-[var(--line)]">
              <table className="w-full border-collapse text-[11.5px]">
                <thead className="bg-[var(--line2)] text-[var(--ink2)]">
                  <tr>
                    <th className="border-b border-[var(--line)] px-2 py-1.5 text-left">
                      中身
                    </th>
                    <th className="w-[110px] border-b border-[var(--line)] px-2 py-1.5 text-right">
                      このグループ
                    </th>
                    <th className="w-[110px] border-b border-[var(--line)] px-2 py-1.5 text-right">
                      サイズ（全体）
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {usageQ.data!.tables.map((t) => (
                    <tr key={t.name}>
                      <td className="border-b border-[var(--line)] px-2 py-1">{t.label}</td>
                      <td className="border-b border-[var(--line)] px-2 py-1 text-right tabular-nums">
                        {t.rows.toLocaleString()} 件
                      </td>
                      <td className="border-b border-[var(--line)] px-2 py-1 text-right tabular-nums text-[var(--ink3)]">
                        {mb(t.bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-2 py-1.5 text-[11px] text-[var(--ink3)]">
                データベース全体：{mb(usageQ.data!.database_bytes)}
                （サイズはこのサーバー全体のもの。件数はこのグループぶんです）
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Row
                checked={pick.orphans}
                onChange={(v) => setPick({ ...pick, orphans: v })}
                label="消した列の値（画面に出ないデータ）"
                detail={`${c.orphan_cells.toLocaleString()} セル / ${c.orphan_rows.toLocaleString()} 行`}
                note="列を削除しても行の中に残っていた値です。消しても表示は変わりません。"
              />
              <Row
                checked={pick.effort}
                onChange={(v) => setPick({ ...pick, effort: v })}
                label="空の工数セル"
                detail={`${c.empty_effort.toLocaleString()} 件`}
                note="予定も実績も入っていない週のレコード。消しても入力は変わりません。"
              />
              <Row
                checked={pick.notifications}
                onChange={(v) => setPick({ ...pick, notifications: v })}
                label="既読の通知"
                detail={`${c.notifications_read.toLocaleString()} 件`}
              />
              <Row
                checked={pick.legacy}
                onChange={(v) => setPick({ ...pick, legacy: v })}
                label="開始日/完了日の古いコピー"
                detail={`${c.legacy_cells.toLocaleString()} セル`}
                note="列に移す前の値です。列に同じ値が入っているぶんだけが対象になります。"
              />
              <Row
                checked={pick.events}
                onChange={(v) => setPick({ ...pick, events: v })}
                label="古い変更履歴"
                detail={`${c.row_events_old.toLocaleString()} / ${c.row_events_total.toLocaleString()} 件`}
                note="消すと「誰がいつ何を変えたか」がその期間ぶん見られなくなります。"
                after={
                  <span className="flex items-center gap-1 text-[11.5px] text-[var(--ink2)]">
                    <Input
                      type="number"
                      min={0}
                      value={eventDays}
                      onChange={(e) => setEventDays(Number(e.target.value) || 0)}
                      className="h-7 w-[74px] px-2 py-1 text-[11.5px] tabular-nums"
                    />
                    日より前
                  </span>
                }
              />
              <Row
                checked={pick.snapshots}
                onChange={(v) => setPick({ ...pick, snapshots: v })}
                label="古い週次スナップショット"
                detail={`${c.snapshots_old.toLocaleString()} / ${c.snapshots_total.toLocaleString()} 件`}
                note="その週まで遡って「変化点」を見る機能が、消した期間ぶん使えなくなります。"
                after={
                  <span className="flex items-center gap-1 text-[11.5px] text-[var(--ink2)]">
                    <Input
                      type="number"
                      min={0}
                      value={snapshotWeeks}
                      onChange={(e) => setSnapshotWeeks(Number(e.target.value) || 0)}
                      className="h-7 w-[74px] px-2 py-1 text-[11.5px] tabular-nums"
                    />
                    週より前
                  </span>
                }
              />
              <Row
                checked={pick.backups}
                onChange={(v) => setPick({ ...pick, backups: v })}
                label="古いバックアップ"
                detail={`${c.backups_old.toLocaleString()} / ${c.backups_total.toLocaleString()} 件（${mb(c.backups_old_bytes)}）`}
                note="いちばん容量を使います。新しいものから指定の件数だけ残します。"
                after={
                  <span className="flex items-center gap-1 text-[11.5px] text-[var(--ink2)]">
                    新しい
                    <Input
                      type="number"
                      min={0}
                      value={backupKeep}
                      onChange={(e) => setBackupKeep(Number(e.target.value) || 0)}
                      className="h-7 w-[64px] px-2 py-1 text-[11.5px] tabular-nums"
                    />
                    件を残す
                  </span>
                }
              />
            </div>

            {fresh && (
              <div
                className={
                  nothing
                    ? 'rounded-[9px] bg-[var(--line2)] px-3 py-2 text-[12px] text-[var(--ink2)]'
                    : 'rounded-[9px] bg-[#FBF3EE] px-3 py-2 text-[12px] text-[#A8442B]'
                }
              >
                {nothing ? (
                  '消せるものはありませんでした。'
                ) : (
                  <>
                    <b>{total.toLocaleString()} 件</b>を削除します：
                    {Object.entries(preview!)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => `${LABEL[k] ?? k} ${n.toLocaleString()}`)
                      .join(' / ')}
                  </>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <span className="mr-auto text-[11.5px] text-[var(--ink3)]">
                削除は取り消せません。心配なときは先にバックアップを取ってください。
              </span>
              <Button
                size="sm"
                variant={fresh ? 'outline' : undefined}
                disabled={check.isPending || run.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending ? '確認中…' : '消える件数を確認'}
              </Button>
              <Button
                size="sm"
                disabled={!fresh || total === 0 || run.isPending}
                title={fresh ? undefined : '先に「消える件数を確認」を押してください'}
                className="border-[#E1A18C] text-[#A8442B] hover:bg-[#FAE6E0]"
                variant="outline"
                onClick={() => {
                  if (window.confirm(`${total} 件を削除します。よろしいですか？`))
                    run.mutate()
                }}
              >
                {run.isPending ? '削除中…' : '削除する'}
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

const LABEL: Record<string, string> = {
  row_events: '変更履歴',
  sheet_snapshots: 'スナップショット',
  notifications: '通知',
  effort_entries: '工数セル',
  orphan_cells: '見えないセル',
  backups: 'バックアップ',
}

function Row({
  checked,
  onChange,
  label,
  detail,
  note,
  after,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  detail: string
  note?: string
  after?: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-2 rounded-[9px] px-1 py-1 hover:bg-[var(--line2)]">
      <input
        type="checkbox"
        className="mt-[3px] accent-[var(--green)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-[var(--ink)]">{label}</span>
          <span className="text-[11.5px] tabular-nums text-[var(--ink2)]">{detail}</span>
          {after}
        </span>
        {note && <span className="block text-[11px] text-[var(--ink3)]">{note}</span>}
      </span>
    </label>
  )
}
