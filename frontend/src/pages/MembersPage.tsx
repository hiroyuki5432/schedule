import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers } from '@/hooks/useSheets'
import { useAuth } from '@/hooks/useAuth'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { ApiError } from '@/lib/http'
import type { Role } from '@/types/api'

export function MembersPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()
  const membersQ = useMembers()
  const [showForm, setShowForm] = useState(false)

  const toggleWorklog = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      api.updateMember(id, { worklog_required: value }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
  })

  return (
    <>
      <PageHeader
        title="メンバー管理"
        subtitle="組織のメンバー一覧"
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              {showForm ? '閉じる' : 'メンバー追加'}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        {isAdmin && showForm && (
          <AddMemberForm
            onDone={() => {
              setShowForm(false)
              void qc.invalidateQueries({ queryKey: ['members'] })
            }}
          />
        )}

        <Card>
          <CardBody className="px-0 py-0">
            {membersQ.isLoading ? (
              <div className="px-5 py-4 text-[var(--ink3)]">読み込み中…</div>
            ) : (
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                    <th className="px-5 py-2.5 font-medium">名前</th>
                    <th className="px-5 py-2.5 font-medium">メール</th>
                    <th className="px-5 py-2.5 font-medium">ロール</th>
                    <th className="px-5 py-2.5 font-medium">日報</th>
                  </tr>
                </thead>
                <tbody>
                  {(membersQ.data ?? []).map((m) => (
                    <tr key={m.id} className="border-b border-[var(--line2)]">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={m.name} seed={m.id} />
                          {m.name}
                        </div>
                      </td>
                      <td className="px-5 py-2.5 text-[var(--ink2)]">{m.email}</td>
                      <td className="px-5 py-2.5">
                        <Badge
                          color={m.role === 'admin' ? '#266B53' : '#6A675C'}
                          bg={m.role === 'admin' ? '#E3EFEA' : '#EFEDE4'}
                        >
                          {m.role === 'admin' ? '管理者' : 'メンバー'}
                        </Badge>
                      </td>
                      <td className="px-5 py-2.5">
                        {isAdmin ? (
                          <label
                            className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--ink2)]"
                            title="オフにすると日報の未入力リマインドを受け取りません"
                          >
                            <input
                              type="checkbox"
                              checked={m.worklog_required}
                              disabled={toggleWorklog.isPending}
                              onChange={(e) =>
                                toggleWorklog.mutate({ id: m.id, value: e.target.checked })
                              }
                            />
                            入力対象
                          </label>
                        ) : (
                          <span className="text-[12px] text-[var(--ink3)]">
                            {m.worklog_required ? '入力対象' : '対象外'}
                          </span>
                        )}
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

function AddMemberForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [worklogRequired, setWorklogRequired] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      api.createMember({ name, email, password, role, worklog_required: worklogRequired }),
    onSuccess: onDone,
    onError: (e) => {
      setError(e instanceof ApiError ? e.message : '追加に失敗しました。')
    },
  })

  return (
    <Card>
      <CardBody>
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            mutation.mutate()
          }}
        >
          <Input
            placeholder="名前"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            type="email"
            placeholder="メール"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="text"
            placeholder="初期パスワード"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex gap-2">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">メンバー</option>
              <option value="admin">管理者</option>
            </Select>
            <Button type="submit" disabled={mutation.isPending}>
              追加
            </Button>
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--ink2)] md:col-span-4">
            <input
              type="checkbox"
              checked={worklogRequired}
              onChange={(e) => setWorklogRequired(e.target.checked)}
            />
            日報入力の対象（オフにすると未入力リマインドを送りません。管理者・外注など向け）
          </label>
          {error && (
            <div className="md:col-span-4 text-[12px] text-[#A8442B]">{error}</div>
          )}
        </form>
      </CardBody>
    </Card>
  )
}
