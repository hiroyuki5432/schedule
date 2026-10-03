// サイドバー下部の「同期中」表示。リアルタイム更新がつながっているかどうかを出す
// （つながっていないのに最新だと思い込むのが、いちばん困る）。
import { useRealtimeStatus } from '@/hooks/useRealtime'
import type { RealtimeState } from '@/hooks/useRealtime'

const LABEL: Record<RealtimeState, { text: string; dot: string; tip: string }> = {
  live: {
    text: '同期中',
    dot: '#7FD1A6',
    tip: '他の人の変更は自動で画面に反映されます',
  },
  connecting: { text: '接続中…', dot: '#E7C98A', tip: 'サーバに接続しています' },
  reconnecting: {
    text: '再接続中…',
    dot: '#E7A08A',
    tip: 'サーバとの接続が切れています。つながるまで、他の人の変更は自動では反映されません（自分の入力は保存されます）',
  },
  paused: { text: '一時停止', dot: '#9CB8AC', tip: '画面が裏にある間は止めています' },
  off: { text: '', dot: 'transparent', tip: '' },
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function RealtimeBadge() {
  const { state, lastRemoteAt } = useRealtimeStatus()
  if (state === 'off') return null
  const l = LABEL[state]
  const tip = lastRemoteAt
    ? `${l.tip}\n最後に他の人の変更を反映: ${hhmm(lastRemoteAt)}`
    : l.tip
  return (
    <div
      className="mt-2 flex items-center gap-1.5 text-[10.5px] text-[#9CB8AC]"
      title={tip}
      aria-live="polite"
    >
      <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: l.dot }} />
      {l.text}
      {lastRemoteAt && state === 'live' && (
        <span className="text-[#7E9C90]">・更新 {hhmm(lastRemoteAt)}</span>
      )}
    </div>
  )
}
