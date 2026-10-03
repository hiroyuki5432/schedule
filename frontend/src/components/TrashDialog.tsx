// ゴミ箱（要望: 行の削除を取り消したい）。
//
// 削除した行は、行ごとの工数・◇・メモ・子タスクと一緒にゴミ箱に入り、ここから
// 同じID・同じ位置に戻せる。直後なら Ctrl+Z やトーストの「元に戻す」でも戻せる。

import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuth } from '@/hooks/useAuth'
import { toast } from '@/lib/toast'

/** 戻したあと、そのシートの画面を全部読み直す。 */
export async function restoreTrashEntry(
  qc: ReturnType<typeof useQueryClient>,
  sheetId: string,
  trashId: number,
): Promise<boolean> {
  try {
    const res = await api.restoreTrash(trashId)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
      qc.invalidateQueries({ queryKey: ['effort', sheetId] }),
      qc.invalidateQueries({ queryKey: ['sheet-milestones', sheetId] }),
      qc.invalidateQueries({ queryKey: ['notes', sheetId] }),
      qc.invalidateQueries({ queryKey: ['trash', sheetId] }),
    ])
    toast.show(
      res.notes.length > 0
        ? `${res.restored} 行を元に戻しました（${res.notes.join(' / ')}）`
        : `${res.restored} 行を元に戻しました`,
      res.notes.length > 0 ? 'warn' : 'success',
      res.notes.length > 0 ? 8000 : 3000,
    )
    return true
  } catch (e) {
    toast.show(`元に戻せませんでした：${e instanceof Error ? e.message : ''}`, 'error')
    void qc.invalidateQueries({ queryKey: ['trash', sheetId] })
    return false
  }
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function TrashDialog({ sheetId, onClose }: { sheetId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const q = useQuery({ queryKey: ['trash', sheetId], queryFn: () => api.getTrash(sheetId) })
  const items = q.data ?? []

  return (
    <Modal title="削除した行（ゴミ箱）" onClose={onClose} widthClass="w-[560px]">
      <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink2)]">
        削除した行は、工数・フェーズ（◇）・メモ・子タスクと一緒にここへ入ります。
        「元に戻す」で、同じIDのまま元の位置に戻ります。
      </p>
      {q.isLoading ? (
        <div className="py-6 text-center text-[12px] text-[var(--ink3)]">読み込み中…</div>
      ) : items.length === 0 ? (
        <EmptyState title="削除した行はありません" body="このシートで削除した行がここに並びます。" />
      ) : (
        <div className="max-h-[52vh] overflow-auto rounded-[10px] border border-[var(--line)]">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-[#F4F1E8] text-left text-[11.5px] text-[var(--ink3)]">
              <tr>
                <th className="px-3 py-2 font-medium">削除した行</th>
                <th className="px-2 py-2 font-medium">削除した人</th>
                <th className="px-2 py-2 font-medium">日時</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} className="border-t border-[var(--line2)]">
                  <td className="px-3 py-2">
                    <div className="break-all">{t.row_keys || '(IDなし)'}</div>
                    <div className="text-[11px] text-[var(--ink3)]">{t.row_count} 行</div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-[var(--ink2)]">
                    {t.deleted_by_name}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-[var(--ink2)]">
                    {fmtWhen(t.deleted_at)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
                    <Button size="sm" onClick={() => void restoreTrashEntry(qc, sheetId, t.id)}>
                      元に戻す
                    </Button>
                    {isAdmin && (
                      <button
                        title="ゴミ箱から完全に削除（戻せなくなります）"
                        onClick={() => {
                          if (!confirm(`「${t.row_keys}」をゴミ箱から完全に削除しますか？戻せなくなります。`))
                            return
                          void api
                            .purgeTrash(t.id)
                            .then(() => qc.invalidateQueries({ queryKey: ['trash', sheetId] }))
                            .catch(() => toast.show('削除できませんでした', 'error'))
                        }}
                        className="ml-1.5 rounded px-1.5 py-1 text-[11.5px] text-[#A8442B] hover:bg-[#FAE6E0]"
                      >
                        完全に削除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </Modal>
  )
}
