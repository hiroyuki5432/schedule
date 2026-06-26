import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers, useOrg } from '@/hooks/useSheets'
import { useAuth } from '@/hooks/useAuth'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { ApiError } from '@/lib/http'
import { cn } from '@/lib/format'
import { toast } from '@/lib/toast'
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

  const changeRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) => api.updateMember(id, { role }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : 'ロールの変更に失敗しました。'),
  })

  const renameMember = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.updateMember(id, { name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : '名前の変更に失敗しました。'),
  })

  const removeMember = useMutation({
    mutationFn: (id: string) => api.deleteMember(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : '削除に失敗しました。'),
  })

  const setActive = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      api.updateMember(id, { is_active: value }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : '凍結状態の変更に失敗しました。'),
  })

  return (
    <>
      <PageHeader
        title="グループ管理"
        subtitle="グループ設定とメンバー一覧"
        actions={
          isAdmin && (
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              {showForm ? '閉じる' : 'メンバー追加'}
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-4 overflow-auto px-[22px] pb-6">
        {isAdmin && <GroupSettingsCard />}

        {isAdmin && <OrgDataDangerCard />}

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
                    <th className="px-5 py-2.5 font-medium">アカウント</th>
                    <th className="px-5 py-2.5 font-medium">ロール</th>
                    <th className="px-5 py-2.5 font-medium">日報</th>
                    {isAdmin && <th className="px-5 py-2.5 font-medium">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {(membersQ.data ?? []).map((m) => (
                    <tr
                      key={m.id}
                      className={cn(
                        'border-b border-[var(--line2)]',
                        !m.is_active && 'opacity-50',
                      )}
                    >
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <Avatar name={m.name} seed={m.id} />
                          {isAdmin ? (
                            <InlineName
                              name={m.name}
                              busy={renameMember.isPending}
                              onSave={(name) => renameMember.mutate({ id: m.id, name })}
                            />
                          ) : (
                            m.name
                          )}
                          {!m.is_active && (
                            <Badge color="#A8442B" bg="#FAE6E0">
                              凍結
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-2.5 text-[var(--ink2)]">{m.email}</td>
                      <td className="px-5 py-2.5">
                        {isAdmin && m.id !== user?.id ? (
                          <Select
                            className="w-[110px]"
                            value={m.role}
                            disabled={changeRole.isPending}
                            onChange={(e) =>
                              changeRole.mutate({ id: m.id, role: e.target.value as Role })
                            }
                          >
                            <option value="member">メンバー</option>
                            <option value="admin">管理者</option>
                          </Select>
                        ) : (
                          <Badge
                            color={m.role === 'admin' ? '#266B53' : '#6A675C'}
                            bg={m.role === 'admin' ? '#E3EFEA' : '#EFEDE4'}
                          >
                            {m.role === 'admin' ? '管理者' : 'メンバー'}
                          </Badge>
                        )}
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
                      {isAdmin && (
                        <td className="px-5 py-2.5">
                          {m.id !== user?.id ? (
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                disabled={setActive.isPending}
                                onClick={() =>
                                  setActive.mutate({ id: m.id, value: !m.is_active })
                                }
                                title={
                                  m.is_active
                                    ? '凍結するとログインできなくなります（データは残ります）'
                                    : '凍結を解除してログインを許可します'
                                }
                                className="text-[12px] text-[var(--ink2)] hover:underline disabled:opacity-50"
                              >
                                {m.is_active ? '凍結' : '解除'}
                              </button>
                              <button
                                type="button"
                                disabled={removeMember.isPending}
                                onClick={() => {
                                  if (window.confirm(`「${m.name}」を削除します。よろしいですか？`))
                                    removeMember.mutate(m.id)
                                }}
                                className="text-[12px] text-[#A8442B] hover:underline disabled:opacity-50"
                              >
                                削除
                              </button>
                            </div>
                          ) : (
                            <span className="text-[12px] text-[var(--ink3)]">—</span>
                          )}
                        </td>
                      )}
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

/** Admin-only: edit the group's display name and the app title (per-group).
 *  Both persist to the org (name → organizations.name, app title → settings). */
function GroupSettingsCard() {
  const qc = useQueryClient()
  const orgQ = useOrg()
  const org = orgQ.data
  const [name, setName] = useState('')
  const [appTitle, setAppTitle] = useState('')
  const [closeOffset, setCloseOffset] = useState('0')
  const [holidays, setHolidays] = useState('')
  const [inited, setInited] = useState(false)

  // Initialize fields once the org loads.
  if (org && !inited) {
    setName(org.name)
    setAppTitle(org.settings?.app_title ?? '')
    setCloseOffset(String(org.settings?.closing?.offset_business_days ?? 0))
    setHolidays((org.settings?.closing?.holidays ?? []).join('\n'))
    setInited(true)
  }

  const parsedHolidays = holidays
    .split(/[\n,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))

  const save = useMutation({
    mutationFn: () =>
      api.updateOrg({
        name: name.trim() || undefined,
        settings: {
          ...(org?.settings ?? {}),
          app_title: appTitle.trim(),
          closing: {
            offset_business_days: Math.max(0, Number(closeOffset) || 0),
            holidays: parsedHolidays,
          },
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org'] })
    },
  })

  const curClosing = org?.settings?.closing
  const dirty =
    !!org &&
    (name.trim() !== org.name ||
      appTitle.trim() !== (org.settings?.app_title ?? '') ||
      Math.max(0, Number(closeOffset) || 0) !== (curClosing?.offset_business_days ?? 0) ||
      JSON.stringify(parsedHolidays) !== JSON.stringify(curClosing?.holidays ?? []))

  return (
    <Card>
      <CardHeader>
        <CardTitle>グループ設定</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
            グループ名（組織名）
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：設計3課" />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
            アプリ表示名（サイドバー上部）
            <Input
              value={appTitle}
              onChange={(e) => setAppTitle(e.target.value)}
              placeholder="工数スケジュール"
            />
            <span className="text-[11px] text-[var(--ink3)]">
              空欄なら「工数スケジュール」を表示します。
            </span>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)]">
            月次の締め（月末の何稼働日前で締めるか）
            <Input
              type="number"
              min={0}
              value={closeOffset}
              onChange={(e) => setCloseOffset(e.target.value)}
            />
            <span className="text-[11px] text-[var(--ink3)]">
              0＝暦月どおり。例：4 なら「月末の4稼働日前」を締め日に（稼働日＝土日・祝日を除く）。
            </span>
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-[var(--ink2)] md:col-span-2">
            会社の休日（祝日に追加。1行に1つ、YYYY-MM-DD）
            <textarea
              value={holidays}
              onChange={(e) => setHolidays(e.target.value)}
              rows={3}
              placeholder={'例：\n2026-08-13\n2026-12-29'}
              className="w-full rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[12.5px] text-[var(--ink)] placeholder:text-[var(--ink3)] focus:outline-none focus:ring-2 focus:ring-[var(--green-l)]"
            />
            <span className="text-[11px] text-[var(--ink3)]">
              日本の祝日は自動で考慮します。年末年始など会社独自の休日のみ追加してください。
            </span>
          </label>
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            グループ設定を保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** Admin-only: wipe every sheet's data (rows / 工数 / マイルストン) in the group at
 *  once, keeping all sheets, columns and settings. For clearing import-test data.
 *  Two-step confirm guards against accidental loss. */
function OrgDataDangerCard() {
  const qc = useQueryClient()
  const clear = useMutation({
    mutationFn: () => api.clearOrgData(),
    onSuccess: async (res) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet'] }),
        qc.invalidateQueries({ queryKey: ['effort'] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones'] }),
        qc.invalidateQueries({ queryKey: ['snapshot'] }),
      ])
      toast.show(
        `全シートのデータを削除しました（${res.sheets} シート / ${res.deleted} 行）`,
        'success',
      )
    },
    onError: () => toast.show('データの削除に失敗しました', 'error'),
  })

  return (
    <Card className="border-[#E7C7BC]">
      <CardHeader>
        <CardTitle>全データ削除（要注意）</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[12px] text-[var(--ink2)]">
            グループ内<b>すべてのシート</b>のデータ（行・工数・マイルストン）を一括削除し、
            シート・列・設定は残します。インポートのやり直し用（採番は各シート1から）。元に戻せません。
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={clear.isPending}
            className="flex-shrink-0 border-[#E1A18C] text-[#A8442B] hover:bg-[#FAE6E0]"
            onClick={() => {
              if (!window.confirm('全シートのデータを削除します。よろしいですか？（列・設定は残ります）'))
                return
              if (!window.confirm('本当に削除しますか？この操作は取り消せません。')) return
              clear.mutate()
            }}
          >
            全シートのデータを空にする
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** Admin-only inline editor for a member's display name. Click to edit; Enter/blur
 *  saves, Esc cancels. Mirrors the sheet-title inline editor pattern. */
function InlineName({
  name,
  busy,
  onSave,
}: {
  name: string
  busy: boolean
  onSave: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(name)
  const done = useRef(false)

  function start() {
    setVal(name)
    setEditing(true)
    done.current = false
  }
  function commit() {
    if (done.current) return
    done.current = true
    const next = val.trim()
    setEditing(false)
    if (next && next !== name) onSave(next)
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={val}
        disabled={busy}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            done.current = true
            setEditing(false)
          }
        }}
        className="w-[160px] py-0.5 text-[12.5px]"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={start}
      title="クリックで名前を編集"
      className="rounded px-1 py-0.5 text-left hover:bg-[var(--line2)]"
    >
      {name}
    </button>
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
            type="text"
            placeholder="ログインID（メール形式でなくても可）"
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
