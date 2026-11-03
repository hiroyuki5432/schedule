// ダッシュボードの「ボード」タブ — 状態の列ごとにカードを並べ、ドラッグで状態を変える。
//
// 変えられるのはプルダウンと、手で入れるステータス列だけ。計算列・マイルストンから
// 自動で決まるステータスは並べるだけ（理由を出す）。ステータス列の「未設定」へは
// 落とせない — 値を空にするとルールの判定に戻り、置いた所と違う列に出てしまうため。
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/format'
import { fmtISO } from '@/lib/dates'
import { shortDate } from '@/lib/dashboard'
import type { Lane, TaskInfo } from '@/lib/dashboard'
import { laneFill } from '@/components/dashboard/Overview'
import type { Column } from '@/types/api'

export function Board({
  sheetId,
  tasks,
  lanes,
  stateCol,
  readOnlyReason,
  showDone,
  onShowDone,
  hasCategory,
  pending,
  onMove,
}: {
  sheetId: string
  /** 絞り込み済み・親の行を除いた行。 */
  tasks: TaskInfo[]
  lanes: Lane[]
  stateCol: Column | undefined
  readOnlyReason: string | null
  showDone: boolean
  onShowDone: (v: boolean) => void
  hasCategory: boolean
  /** 保存中のカード（行id → 移す先の値）。読み直すまで移した先に出しておく。 */
  pending: Map<string, string>
  onMove: (t: TaskInfo, value: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)

  if (!stateCol)
    return (
      <div className="rounded-[14px] border border-dashed border-[var(--line)] px-5 py-10 text-center text-[12.5px] text-[var(--ink3)]">
        上の「状態の列」を選ぶと、その値ごとにカードが並びます。
      </div>
    )

  const laneOf = (t: TaskInfo) => pending.get(String(t.m.row.id)) ?? t.state
  const hiddenDone = showDone ? 0 : tasks.filter((t) => t.done).length
  const visible = showDone ? tasks : tasks.filter((t) => !t.done)
  // 未設定の列は、カードがあるときだけ出す。
  const shown = lanes.filter((l) => l.value !== '' || visible.some((t) => laneOf(t) === ''))
  const canDropOn = (l: Lane) =>
    !readOnlyReason && !(stateCol.type === 'status' && l.value === '')

  const byDue = (a: TaskInfo, b: TaskInfo) =>
    (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
    a.m.keyValue.localeCompare(b.m.keyValue, 'ja', { numeric: true })

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--ink2)]">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={showDone}
            onChange={(e) => onShowDone(e.target.checked)}
            className="accent-[var(--green)]"
          />
          完了も表示
        </label>
        {hiddenDone > 0 && <span className="text-[var(--ink3)]">完了 {hiddenDone} 件を非表示</span>}
        <span className="text-[11.5px] text-[var(--ink3)]">
          {readOnlyReason ?? `カードをドラッグすると「${stateCol.name}」が変わります（スケジュールにも反映）`}
        </span>
      </div>
      <div className="flex min-h-[420px] gap-3 overflow-x-auto pb-2">
        {shown.map((l) => {
          const cards = visible.filter((t) => laneOf(t) === l.value).sort(byDue)
          const droppable = canDropOn(l)
          const isOver = overLane === l.value && dragId != null
          return (
            <div
              key={l.value}
              onDragOver={(e) => {
                if (!droppable || dragId == null) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overLane !== l.value) setOverLane(l.value)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverLane(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setOverLane(null)
                const t = tasks.find((x) => String(x.m.row.id) === dragId)
                setDragId(null)
                if (t && droppable && laneOf(t) !== l.value) onMove(t, l.value)
              }}
              className={cn(
                'flex w-[264px] flex-shrink-0 flex-col rounded-[14px] border transition-colors',
                isOver ? 'border-[var(--green)] bg-[#EAF3EE]' : 'bg-[#f6f3ec]',
                isOver ? 'border-[var(--green)]' : 'border-[var(--line)]',
                dragId != null && !droppable && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
                <span
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-[3px] shadow-[inset_0_0_0_1px_rgba(35,33,29,0.14)]"
                  style={{ background: laneFill(lanes, l.value) }} />
                <span className="truncate text-[12.5px] font-semibold">{l.value || '（未設定）'}</span>
                <span className="ml-auto text-[12px] tabular-nums text-[var(--ink3)]">{cards.length}</span>
              </div>
              <div className="flex max-h-[calc(100vh-330px)] min-h-[60px] flex-col gap-2 overflow-y-auto px-2 pb-2">
                {cards.map((t) => (
                  <BoardCard
                    key={t.m.row.id}
                    sheetId={sheetId}
                    t={t}
                    draggable={!readOnlyReason}
                    saving={pending.has(String(t.m.row.id))}
                    hasCategory={hasCategory}
                    onDragStart={() => setDragId(String(t.m.row.id))}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverLane(null)
                    }}
                  />
                ))}
                {cards.length === 0 && (
                  <div className="py-4 text-center text-[11.5px] text-[var(--ink3)]">—</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BoardCard({
  sheetId,
  t,
  draggable,
  saving,
  hasCategory,
  onDragStart,
  onDragEnd,
}: {
  sheetId: string
  t: TaskInfo
  draggable: boolean
  saving: boolean
  hasCategory: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', t.m.keyValue)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'rounded-[10px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-[12.5px] shadow-[0_1px_0_rgba(0,0,0,0.03)]',
        draggable && 'cursor-grab active:cursor-grabbing',
        saving && 'opacity-60',
      )}
    >
      <div className="flex items-center gap-2 text-[11px] text-[var(--ink3)]">
        <Link
          to={`/sheets/${sheetId}?focus=${t.m.row.id}&t=${Date.now()}`}
          className="font-semibold hover:text-[var(--green-d)] hover:underline"
          title="スケジュールでこの行を表示"
          draggable={false}
        >
          {t.m.keyValue}
        </Link>
        {hasCategory && t.category && (
          <span className="truncate rounded-[5px] bg-[var(--line2)] px-1.5 py-[1px] text-[var(--ink2)]" title={t.category}>
            {t.category}
          </span>
        )}
        {saving && <span className="ml-auto">保存中…</span>}
      </div>
      <div className="mt-1 line-clamp-2 leading-snug" title={t.m.title}>
        {t.m.title || <span className="text-[var(--ink3)]">（件名なし）</span>}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[11.5px]">
        {t.m.assigneeName ? (
          <>
            <Avatar name={t.m.assigneeName} seed={t.m.assigneeId} />
            <span className="max-w-[110px] truncate text-[var(--ink2)]">{t.m.assigneeName}</span>
          </>
        ) : (
          <span className="text-[var(--ink3)]">担当なし</span>
        )}
        {t.due && (
          <span
            className={cn('ml-auto whitespace-nowrap', t.overdue ? 'font-semibold text-[#A8442B]' : 'text-[var(--ink3)]')}
            title={t.dueFrom === 'effort' ? '完了日の列が空なので、予定工数の最後の週を使っています' : '期限'}
          >
            {shortDate(t.due, fmtISO(new Date()))}
            {t.overdue && ' 超過'}
          </span>
        )}
      </div>
    </div>
  )
}
