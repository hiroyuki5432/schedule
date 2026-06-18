import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { ApiError } from '@/lib/http'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('メールアドレスまたはパスワードが正しくありません。')
      } else {
        setError('ログインに失敗しました。時間をおいて再度お試しください。')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--canvas)] px-4">
      <div className="w-full max-w-sm rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-8">
        <div className="mb-6 flex items-center gap-2.5 text-[18px] font-semibold text-[var(--green-d)]">
          <span className="h-2.5 w-2.5 rounded-full bg-[#7FC9A6]" />
          工数スケジュール
        </div>
        <p className="mb-5 text-[12px] text-[var(--ink3)]">
          メールアドレスとパスワードでログイン
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
            メールアドレス
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
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
      </div>
    </div>
  )
}
