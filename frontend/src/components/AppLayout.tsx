import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useOrg, useSheets } from '@/hooks/useSheets'
import { cn, initial } from '@/lib/format'
import { AddSheetDialog } from '@/components/AddSheetDialog'
import {
  CalendarIcon,
  ChartIcon,
  GearIcon,
  LogoutIcon,
  MembersIcon,
  MenuIcon,
  PlusIcon,
  TableIcon,
  TasksIcon,
  XIcon,
} from '@/components/ui/icons'
import type { Sheet } from '@/types/api'

const FIXED_NAV = [
  { to: '/dashboard', label: 'ダッシュボード', Icon: ChartIcon },
  { to: '/annual', label: '年間計画', Icon: TableIcon },
  { to: '/worklog', label: '実績入力', Icon: CalendarIcon },
  { to: '/my-tasks', label: 'マイタスク', Icon: TasksIcon },
  { to: '/members', label: 'メンバー管理', Icon: MembersIcon },
]

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'mb-0.5 flex items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 text-[13px] transition-colors',
    isActive
      ? 'bg-[var(--green-l)] font-medium text-white'
      : 'text-[#C2D7CC] hover:bg-[var(--green-line)]',
  )

export function AppLayout() {
  const { user, logout } = useAuth()
  const { data: org } = useOrg()
  const sheetsQ = useSheets()
  const [showAdd, setShowAdd] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const location = useLocation()

  const sheets = [...(sheetsQ.data ?? [])].sort((a, b) => a.order - b.order)

  // Close the mobile drawer on route change.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Off-canvas backdrop (mobile only) */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[226px] flex-shrink-0 flex-col bg-[var(--green)] px-3.5 py-[18px] text-[#CFE0D7] transition-transform duration-200',
          'md:static md:z-auto md:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-1.5 pb-4 pt-0.5 text-[16px] font-semibold text-white">
          <span className="h-2.5 w-2.5 rounded-full bg-[#7FC9A6]" />
          工数スケジュール
          <button
            onClick={() => setDrawerOpen(false)}
            className="ml-auto rounded-md p-1 text-[#9CB8AC] hover:bg-[var(--green-line)] hover:text-white md:hidden"
            aria-label="メニューを閉じる"
          >
            <XIcon className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="mb-4 flex items-center gap-2.5 rounded-[11px] bg-[var(--green-d)] px-2.5 py-2.5">
          <div className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-[var(--green-l)] text-[12px] font-semibold text-white">
            {initial(org?.name ?? 'デ')}
          </div>
          <div>
            <div className="text-[13px] text-white">{org?.name ?? 'デモ組織'}</div>
            <div className="text-[11px] text-[#9CB8AC]">{org?.slug ?? 'demo'}</div>
          </div>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* ---- Sheets group ---- */}
          <div className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#8FB0A2]">
            シート
          </div>
          {sheetsQ.isLoading ? (
            <div className="mb-1 px-2.5 py-2 text-[12px] text-[#9CB8AC]">読み込み中…</div>
          ) : sheets.length === 0 ? (
            <div className="mb-1 px-2.5 py-2 text-[12px] text-[#9CB8AC]">シートがありません</div>
          ) : (
            sheets.map((s) => <SheetNavItem key={s.id} sheet={s} />)
          )}

          <button
            onClick={() => setShowAdd(true)}
            className="mb-2 mt-0.5 flex items-center gap-2 rounded-[9px] border border-dashed border-[var(--green-line)] px-2.5 py-2 text-[12.5px] text-[#C2D7CC] transition-colors hover:bg-[var(--green-line)] hover:text-white"
          >
            <PlusIcon className="h-[15px] w-[15px]" strokeWidth={1.8} />
            シート追加
          </button>

          {/* ---- Divider + fixed group ---- */}
          <div className="my-2 border-t border-[var(--green-line)]" />
          {FIXED_NAV.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to} className={navClass}>
              <Icon className="h-[17px] w-[17px]" strokeWidth={1.7} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-3 flex items-center gap-2.5 border-t border-[var(--green-line)] pt-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#C9DCD3] text-[12px] font-semibold text-[var(--green-d)]">
            {initial(user?.name)}
          </div>
          <div className="flex-1 text-[12px] text-[#CFE0D7]">{user?.name}</div>
          <button
            onClick={() => void logout()}
            title="ログアウト"
            className="rounded-md p-1 text-[#9CB8AC] hover:bg-[var(--green-line)] hover:text-white"
          >
            <LogoutIcon className="h-[16px] w-[16px]" />
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Slim mobile top bar with hamburger */}
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-3 py-2 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-md p-1.5 text-[var(--ink2)] hover:bg-[var(--line2)]"
            aria-label="メニューを開く"
          >
            <MenuIcon className="h-[20px] w-[20px]" />
          </button>
          <span className="flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
            <span className="h-2 w-2 rounded-full bg-[var(--green)]" />
            工数スケジュール
          </span>
        </div>
        <Outlet />
      </main>

      {showAdd && <AddSheetDialog onClose={() => setShowAdd(false)} />}
    </div>
  )
}

function SheetNavItem({ sheet }: { sheet: Sheet }) {
  const Icon = sheet.has_week_grid ? CalendarIcon : TableIcon

  // Deletion is intentionally NOT offered here (too easy to hit by accident).
  // Sheets can only be deleted from the sheet settings page (危険操作).
  return (
    <div className="group/sheet relative mb-0.5 flex items-center">
      <NavLink
        to={`/sheets/${sheet.id}`}
        className={({ isActive }) =>
          cn(
            'flex flex-1 items-center gap-2.5 overflow-hidden rounded-[9px] py-2.5 pl-2.5 pr-9 text-[13px] transition-colors',
            isActive
              ? 'bg-[var(--green-l)] font-medium text-white'
              : 'text-[#C2D7CC] hover:bg-[var(--green-line)]',
          )
        }
      >
        <Icon className="h-[17px] w-[17px] flex-shrink-0" strokeWidth={1.7} />
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{sheet.name}</span>
      </NavLink>
      <div className="absolute right-1 flex items-center gap-0.5">
        <NavLink
          to={`/sheets/${sheet.id}/settings`}
          title="シート設定"
          className={({ isActive }) =>
            cn(
              'flex h-7 w-7 items-center justify-center rounded-[7px] text-[#9CB8AC] transition-opacity hover:bg-[var(--green-line)] hover:text-white',
              isActive ? 'opacity-100' : 'opacity-0 group-hover/sheet:opacity-100',
            )
          }
        >
          <GearIcon className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </NavLink>
      </div>
    </div>
  )
}
