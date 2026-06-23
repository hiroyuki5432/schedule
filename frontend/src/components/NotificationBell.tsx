// Bell + unread badge + dropdown panel. Cron-free: the list query (useNotifications)
// also mints 未入力 reminders server-side on each fetch. Clicking an item marks it
// read and navigates to the relevant page.
//
// The panel renders in a portal at <body> with fixed positioning so it always sits
// above the schedule grid (whose sticky/pinned columns create their own stacking
// contexts that would otherwise overlap an in-sidebar dropdown).

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMarkNotificationsRead, useNotifications } from '@/hooks/useNotifications'
import { BellIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import type { Notification, NotificationType } from '@/types/api'

const PANEL_W = 340
const TYPE_DOT: Record<NotificationType, string> = {
  behind: 'bg-[#A8442B]',
  dep: 'bg-[#A8442B]',
  overrun: 'bg-[#C77A2B]',
  milestone: 'bg-[#C77A2B]',
  worklog_missing: 'bg-[var(--green)]',
}

function targetPath(n: Notification): string {
  if (n.type === 'worklog_missing') {
    // ref_id is the missed date (YYYY-MM-DD) — open the 実績入力 on that day.
    return n.ref_id ? `/worklog?date=${n.ref_id}` : '/worklog'
  }
  // Schedule alerts: ref_id = "<sheetId>:<rowId>" → open the sheet and focus the
  // specific task (scroll + highlight). `t` is a nonce so re-clicking re-flashes.
  if (n.ref_kind === 'row' && n.ref_id) {
    const [sheetId, rowId] = n.ref_id.split(':')
    return `/sheets/${sheetId}?focus=${rowId}&t=${Date.now()}`
  }
  // Back-compat: older notifications stored just the sheet id.
  if (n.ref_kind === 'sheet' && n.ref_id) return `/sheets/${n.ref_id}`
  return '/dashboard'
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}時間前`
  return `${Math.floor(hr / 24)}日前`
}

export function NotificationBell({
  variant = 'dark',
  align = 'left',
}: {
  variant?: 'dark' | 'light'
  /** Which edge the dropdown aligns to relative to the bell (kept on-screen). */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const { data: notes = [] } = useNotifications()
  const markRead = useMarkNotificationsRead()

  const unread = notes.filter((n) => !n.read_at).length

  // Position the portal panel under the bell, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const margin = 12
      const maxLeft = window.innerWidth - PANEL_W - margin
      const left =
        align === 'right'
          ? r.right - PANEL_W // right edge of panel aligns to bell's right
          : r.left
      setPos({ top: r.bottom + 6, left: Math.max(margin, Math.min(left, maxLeft)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align])

  // Close on outside click (button or panel — both live outside one container now).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function onClickItem(n: Notification) {
    if (!n.read_at) markRead.mutate([n.id])
    setOpen(false)
    navigate(targetPath(n))
  }

  const btnColor =
    variant === 'dark'
      ? 'text-[#9CB8AC] hover:bg-[var(--green-line)] hover:text-white'
      : 'text-[var(--ink2)] hover:bg-[var(--line2)]'

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        title="通知"
        aria-label="通知"
        className={cn('relative rounded-md p-1.5', btnColor)}
      >
        <BellIcon className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#C0392B] px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: PANEL_W }}
            className="fixed z-[9999] max-w-[calc(100vw-24px)] overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)] shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--line)] px-3.5 py-2.5">
              <span className="text-[13px] font-semibold text-[var(--ink)]">通知</span>
              {unread > 0 && (
                <button
                  onClick={() => markRead.mutate(undefined)}
                  className="text-[11.5px] text-[var(--green)] hover:underline"
                >
                  すべて既読
                </button>
              )}
            </div>

            <div className="max-h-[min(60vh,440px)] overflow-y-auto">
              {notes.length === 0 ? (
                <div className="px-3.5 py-6 text-center text-[12.5px] text-[var(--ink3)]">
                  通知はありません
                </div>
              ) : (
                notes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => onClickItem(n)}
                    className={cn(
                      'flex w-full items-start gap-2.5 border-b border-[var(--line2)] px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--line2)]',
                      !n.read_at && 'bg-[#FBFAF5]',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1.5 h-2 w-2 flex-shrink-0 rounded-full',
                        n.read_at ? 'bg-[var(--line)]' : TYPE_DOT[n.type],
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-medium text-[var(--ink)]">
                        {n.title}
                      </span>
                      {n.body && (
                        <span className="mt-0.5 block truncate text-[11.5px] text-[var(--ink2)]">
                          {n.body}
                        </span>
                      )}
                      <span className="mt-0.5 block text-[10.5px] text-[var(--ink3)]">
                        {timeAgo(n.created_at)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
