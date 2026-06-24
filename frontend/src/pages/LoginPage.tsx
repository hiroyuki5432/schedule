import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import * as api from '@/api/client'
import { ApiError } from '@/lib/http'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Sign-up (new group) fields.
  const [orgName, setOrgName] = useState('')
  const [adminName, setAdminName] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('IDまたはパスワードが正しくありません。')
      } else {
        setError('ログインに失敗しました。時間をおいて再度お試しください。')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function onSignup(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await api.signupOrg({
        org_name: orgName,
        admin_name: adminName,
        admin_email: email,
        admin_password: password,
      })
      // signup logs the new admin in server-side; refresh client auth state.
      await login(email, password)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || 'グループの作成に失敗しました。')
      } else {
        setError('グループの作成に失敗しました。時間をおいて再度お試しください。')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--canvas)] px-4 py-8">
      <div className="w-full max-w-sm rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-8">
        <div className="mb-6 flex items-center gap-2.5 text-[18px] font-semibold text-[var(--green-d)]">
          <span className="h-2.5 w-2.5 rounded-full bg-[#7FC9A6]" />
          工数スケジュール
        </div>
        <p className="mb-5 text-[12px] text-[var(--ink3)]">
          {mode === 'login'
            ? 'IDとパスワードでログイン'
            : '新しいグループ（組織）と管理者アカウントを作成します'}
        </p>

        {mode === 'login' ? (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              ID
              <Input
                type="text"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ログインID"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              パスワード
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>

            {error && (
              <div className="rounded-[9px] border border-[#E8C7BD] bg-[#FBEDE8] px-3 py-2 text-[12px] text-[#A8442B]">
                {error}
              </div>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? 'ログイン中…' : 'ログイン'}
            </Button>
          </form>
        ) : (
          <form onSubmit={onSignup} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              グループ名（組織名）
              <Input
                type="text"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="例：開発チーム"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              管理者の名前
              <Input
                type="text"
                required
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="例：山田 太郎"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              ログインID
              <Input
                type="text"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ログインID（メール形式でなくても可）"
              />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
              パスワード
              <Input
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>

            {error && (
              <div className="rounded-[9px] border border-[#E8C7BD] bg-[#FBEDE8] px-3 py-2 text-[12px] text-[#A8442B]">
                {error}
              </div>
            )}

            <Button type="submit" disabled={submitting} className="mt-1 w-full">
              {submitting ? '作成中…' : 'グループを作成して開始'}
            </Button>
          </form>
        )}

        <button
          type="button"
          className="mt-4 w-full text-center text-[12px] text-[var(--green-d)] hover:underline"
          onClick={() => {
            setError(null)
            setMode((m) => (m === 'login' ? 'signup' : 'login'))
          }}
        >
          {mode === 'login'
            ? '新しいグループを作成する'
            : 'ログイン画面に戻る'}
        </button>
      </div>
    </div>
  )
}
