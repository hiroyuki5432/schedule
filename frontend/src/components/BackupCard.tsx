// バックアップ / リストア（グループ管理・管理者のみ）。
//
// A backup holds the whole group: sheets, columns, rows, 工数, ◇, 日報, 変更履歴,
// メンバー, and every setting. Restoring puts all of it back exactly — see
// backend/app/backup_service.py for why the original ids are kept.
//
// Restoring is destructive, so the UI does three things: it says plainly what
// will be replaced, it names what is in the backup being applied, and it points
// out that a safety backup is taken automatically first.
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import type { Backup } from '@/api/client'
import { ApiError } from '@/lib/http'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toast } from '@/lib/toast'

/** Table key → what to call it. Order is the order shown. */
const SUMMARY_LABELS: [string, string][] = [
  ['sheets', 'シート'],
  ['rows', 'タスク'],
  ['effort_entries', '週次工数'],
  ['row_milestones', 'マイルストン'],
  ['work_logs', '日報'],
  ['row_events', '変更履歴'],
  ['members', 'メンバー'],
]

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function summaryText(summary: Record<string, number>): string {
  return SUMMARY_LABELS.filter(([k]) => (summary[k] ?? 0) > 0)
    .map(([k, label]) => `${label} ${summary[k]}`)
    .join(' / ')
}

export function BackupCard() {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [label, setLabel] = useState('')
  const [confirming, setConfirming] = useState<Backup | null>(null)
  const [confirmingFile, setConfirmingFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)

  const listQ = useQuery({ queryKey: ['backups'], queryFn: api.getBackups })

  const create = useMutation({
    mutationFn: () => api.createBackup(label.trim()),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setLabel('')
      await qc.invalidateQueries({ queryKey: ['backups'] })
      toast.show('バックアップを作成しました', 'success')
    },
    // Show what the server actually said — a generic "失敗しました" hides whether
    // this was a permission problem, a missing migration, or a real bug.
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? `バックアップの作成に失敗しました：${e.message}（HTTP ${e.status}）`
          : 'バックアップの作成に失敗しました。',
      ),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteBackup(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['backups'] })
      toast.show('バックアップを削除しました', 'info', 2000)
    },
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? `削除に失敗しました：${e.message}（HTTP ${e.status}）`
          : '削除に失敗しました。',
      ),
  })

  const restore = useMutation({
    mutationFn: (src: { backup: Backup } | { file: File }) =>
      'backup' in src ? api.restoreBackup(src.backup.id) : api.restoreBackupFile(src.file),
    onSuccess: (res) => {
      setConfirming(null)
      setConfirmingFile(null)
      if (res.signed_out) {
        // The restored data has no account for this session — say so before the
        // next request bounces to the login screen with a bare 401.
        toast.show('復元しました。このアカウントは復元後のデータに存在しないためログアウトします', 'info', 6000)
        window.setTimeout(() => window.location.assign('/login'), 1500)
        return
      }
      // Everything on screen is now stale — sheets, rows, settings, the lot.
      qc.clear()
      toast.show('復元しました', 'success')
      window.setTimeout(() => window.location.reload(), 600)
    },
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? `${e.message}（HTTP ${e.status}）`
          : '復元に失敗しました。',
      ),
  })

  const backups = listQ.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>バックアップ / 復元</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--ink2)]">
          このグループの<strong>すべて</strong>（シート・列・タスク・週次工数・マイルストン・
          日報・変更履歴・メンバー・各種設定）を丸ごと保存します。復元するとその時点の状態に
          完全に戻ります。復元の直前には自動でバックアップを取るので、戻しすぎたときも
          そこから戻せます。
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            value={label}
            placeholder="ラベル（省略可。例: 2026年度取り込み前）"
            onChange={(e) => setLabel(e.target.value)}
            className="h-8 w-[280px] py-1 text-[12.5px]"
          />
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? '作成中…' : 'バックアップを作成'}
          </Button>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            ファイルから復元
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                setError(null)
                setConfirmingFile(f)
              }
              if (fileRef.current) fileRef.current.value = ''
            }}
          />
        </div>

        {error && (
          <div className="mb-3 whitespace-pre-line rounded-[10px] bg-[#FBF3EE] px-3 py-2 text-[12px] leading-relaxed text-[#A8442B]">
            {error}
          </div>
        )}
        {listQ.isError && (
          <div className="mb-3 rounded-[10px] bg-[#FBF3EE] px-3 py-2 text-[12px] text-[#A8442B]">
            一覧を取得できませんでした：
            {listQ.error instanceof ApiError
              ? `${listQ.error.message}（HTTP ${listQ.error.status}）`
              : '不明なエラー'}
          </div>
        )}
        {listQ.isLoading ? (
          <div className="py-4 text-[12px] text-[var(--ink3)]">読み込み中…</div>
        ) : backups.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-4 text-center text-[12px] text-[var(--ink3)]">
            まだバックアップがありません。大きな取り込みや設定変更の前に取っておくと安心です。
          </div>
        ) : (
          <div className="max-h-[320px] overflow-auto rounded-[10px] border border-[var(--line)]">
            <table className="w-full border-collapse text-[12px]">
              <thead className="sticky top-0 bg-[var(--line2)] text-[var(--ink2)]">
                <tr>
                  <th className="border-b border-[var(--line)] px-3 py-1.5 text-left">日時</th>
                  <th className="border-b border-[var(--line)] px-3 py-1.5 text-left">ラベル</th>
                  <th className="border-b border-[var(--line)] px-3 py-1.5 text-left">内容</th>
                  <th className="border-b border-[var(--line)] px-3 py-1.5 text-right">サイズ</th>
                  <th className="border-b border-[var(--line)] px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td className="whitespace-nowrap border-b border-[var(--line2)] px-3 py-1.5 tabular-nums">
                      {fmtWhen(b.created_at)}
                      {b.created_by_name && (
                        <span className="block text-[10.5px] text-[var(--ink3)]">
                          {b.created_by_name}
                        </span>
                      )}
                    </td>
                    <td className="border-b border-[var(--line2)] px-3 py-1.5">{b.label}</td>
                    <td className="border-b border-[var(--line2)] px-3 py-1.5 text-[11px] text-[var(--ink2)]">
                      {summaryText(b.summary) || '（空）'}
                    </td>
                    <td className="whitespace-nowrap border-b border-[var(--line2)] px-3 py-1.5 text-right tabular-nums text-[var(--ink2)]">
                      {fmtSize(b.size_bytes)}
                    </td>
                    <td className="whitespace-nowrap border-b border-[var(--line2)] px-3 py-1.5 text-right">
                      <button
                        onClick={() => {
                          setError(null)
                          setConfirming(b)
                        }}
                        className="rounded-[7px] px-2 py-1 text-[11.5px] text-[#A8442B] hover:bg-[#FAE6E0]"
                      >
                        復元
                      </button>
                      <a
                        href={api.backupDownloadUrl(b.id)}
                        download
                        className="rounded-[7px] px-2 py-1 text-[11.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
                      >
                        ダウンロード
                      </a>
                      <button
                        onClick={() => {
                          if (confirm(`「${b.label}」を削除しますか？`)) remove.mutate(b.id)
                        }}
                        className="rounded-[7px] px-2 py-1 text-[11.5px] text-[var(--ink3)] hover:bg-[var(--line2)] hover:text-[var(--ink)]"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>

      {(confirming || confirmingFile) && (
        <RestoreConfirm
          backup={confirming}
          file={confirmingFile}
          running={restore.isPending}
          error={error}
          onCancel={() => {
            setConfirming(null)
            setConfirmingFile(null)
            setError(null)
          }}
          onRun={() => {
            setError(null)
            if (confirming) restore.mutate({ backup: confirming })
            else if (confirmingFile) restore.mutate({ file: confirmingFile })
          }}
        />
      )}
    </Card>
  )
}

function RestoreConfirm({
  backup,
  file,
  running,
  error,
  onCancel,
  onRun,
}: {
  backup: Backup | null
  file: File | null
  running: boolean
  error: string | null
  onCancel: () => void
  onRun: () => void
}) {
  return (
    <Modal title="この状態に復元しますか？" onClose={onCancel} widthClass="w-[520px] max-w-[95vw]">
      <div className="rounded-[10px] bg-[var(--line2)] px-3 py-2.5 text-[12.5px]">
        {backup ? (
          <>
            <div className="font-medium text-[var(--ink)]">{backup.label}</div>
            <div className="mt-0.5 text-[11.5px] text-[var(--ink2)]">
              {fmtWhen(backup.created_at)} 時点 ／ {summaryText(backup.summary) || '（空）'}
            </div>
          </>
        ) : (
          <div className="font-medium text-[var(--ink)]">{file?.name}</div>
        )}
      </div>

      <ul className="mt-3 space-y-1 rounded-[10px] bg-[#FBF3EE] px-3 py-2.5 text-[12px] text-[#A8442B]">
        <li>・現在のシート・タスク・工数・日報・変更履歴・設定は<strong>すべて置き換わります</strong>。</li>
        <li>
          ・<strong>メンバーも置き換わります</strong>。このバックアップより後に追加したメンバーは
          消え、変更したパスワードも当時のものに戻ります。
        </li>
        <li>・通知（ベル）は復元対象外です（開き直すと再生成されます）。</li>
      </ul>

      <p className="mt-3 text-[11.5px] text-[var(--ink3)]">
        復元の直前に現在の状態を「復元前の自動バックアップ」として保存します。取り消したいときは
        それを復元してください。
      </p>

      {error && <div className="mt-3 text-[12px] text-[#A8442B]">{error}</div>}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={running} onClick={onCancel}>
          キャンセル
        </Button>
        <Button size="sm" disabled={running} onClick={onRun}>
          {running ? '復元中…' : '復元する'}
        </Button>
      </div>
    </Modal>
  )
}
