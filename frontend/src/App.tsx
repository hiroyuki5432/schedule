import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { AppLayout } from '@/components/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { SheetPage } from '@/pages/SheetPage'
import { SheetIndexRedirect } from '@/pages/SheetIndexRedirect'
import { DashboardPage } from '@/pages/DashboardPage'
import { AnnualPlanPage } from '@/pages/AnnualPlanPage'
import { AllUsersWorklogPage } from '@/pages/AllUsersWorklogPage'
import { MyTasksPage } from '@/pages/MyTasksPage'
import { WorkLogPage } from '@/pages/WorkLogPage'
import { MembersPage } from '@/pages/MembersPage'
import { SheetSettingsPage } from '@/pages/SheetSettingsPage'

function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen items-center justify-center text-[var(--ink3)]">
      {children}
    </div>
  )
}

export default function App() {
  const { user, loading } = useAuth()

  if (loading) {
    return <FullScreenMessage>読み込み中…</FullScreenMessage>
  }

  if (!user) {
    // Auth guard: anything but /login redirects to /login.
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<SheetIndexRedirect />} />
        <Route path="/sheets/:sheetId" element={<SheetPage />} />
        <Route path="/sheets/:sheetId/settings" element={<SheetSettingsPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/annual" element={<AnnualPlanPage />} />
        <Route path="/worklog" element={<WorkLogPage />} />
        <Route path="/all-worklog" element={<AllUsersWorklogPage />} />
        <Route path="/my-tasks" element={<MyTasksPage />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
