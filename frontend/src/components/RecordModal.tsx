// Full-record view for one row: every field labeled and editable, plus that
// row's 変更履歴. Shared by the table view (行の「開く」) and the schedule grid,
// which needs exactly the same thing (要望: スケジュールも開くと変更履歴が欲しい).
//
// Lives outside TableSheetView so the schedule does not have to import a page.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { InlineCell } from '@/components/schedule/InlineCell'
import { HistoryPanel } from '@/components/schedule/HistoryPanel'
import { statusFromPhases } from '@/lib/status'
import { cn } from '@/lib/format'
import type { CellValue, Column, Member, Row } from '@/types/api'

/** Full-record modal: every field labeled and editable (reuses InlineCell).
 *  Opens from a table row's 「開く」 button for focused viewing/editing. */
export function RecordModal({
  row,
  columns,
  members,
  rows,
  lookupValue,
  autoStatusColId,
  autoStatusBadge,
  onClose,
  onSaveCell,
  onSaveKey,
  onDelete,
}: {
  row: Row
  columns: Column[]
  members: Member[] | undefined
  rows: Row[]
  lookupValue: (column: Column, row: Row) => string | null
  /** Set only where a status column is derived from milestones (テーブル表示).
   *  The schedule leaves these out and lets InlineCell resolve status itself. */
  autoStatusColId?: string | null
  autoStatusBadge?: ReturnType<typeof statusFromPhases>
  onClose: () => void
  onSaveCell: (colId: string, v: CellValue) => void
  onSaveKey: (v: string) => void
  onDelete: () => void
}) {
  const [showHistory, setShowHistory] = useState(false)
  // Column count from the number of fields: a 20-column sheet in one column is a
  // long scroll for no reason, while a 4-column sheet in two looks empty
  // (要望: 多かったら2列みたいなことができるといい). Multi-line text still spans the
  // full width, so a 備考 keeps room to breathe.
  const twoCols = columns.length + 1 > 8
  return (
    <Modal
      title={`レコード詳細 — ${row.key_value || '（IDなし）'}`}
      onClose={onClose}
      widthClass={twoCols ? 'w-[820px] max-w-[95vw]' : 'w-[460px] max-w-[95vw]'}
    >
      <div className={cn('grid gap-x-4 gap-y-3', twoCols ? 'sm:grid-cols-2' : 'grid-cols-1')}>
        <Field label="ID">
          <IdCell row={row} onSave={onSaveKey} />
        </Field>
        {columns.map((c) => (
          <Field
            key={c.id}
            label={c.name}
            // Free text can be long / multi-line — give it the whole row so it is
            // not squeezed into half a modal.
            className={twoCols && c.type === 'text' ? 'sm:col-span-2' : undefined}
          >
            {autoStatusColId && c.id === autoStatusColId ? (
              <AutoStatusCell badge={autoStatusBadge ?? null} />
            ) : (
              <ModalCell
                row={row}
                column={c}
                members={members ?? []}
                lookupValue={lookupValue}
                rows={rows}
                onSave={(v) => onSaveCell(c.id, v)}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[var(--line2)] pt-3">
        <button
          onClick={onDelete}
          className="rounded-[8px] px-2 py-1 text-[12px] text-[#A8442B] hover:bg-[#FAE6E0]"
        >
          このレコードを削除
        </button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowHistory(true)}>
            変更履歴
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>

      {showHistory && (
        <HistoryPanel
          scope={{ kind: 'row', rowId: row.id, name: row.key_value || '（IDなし）' }}
          onClose={() => setShowHistory(false)}
        />
      )}
    </Modal>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="text-[11.5px] font-medium text-[var(--ink3)]">{label}</span>
      {/* min-height ≈ the ID field, so short fields aren't cramped. */}
      <div className="flex min-h-[34px] items-stretch rounded-[8px] border border-[var(--line2)]">
        {children}
      </div>
    </label>
  )
}

/** Field control used inside the record modal. Long free-text grows to fit its
 *  content (no nested modal); lookup shows full text; everything else reuses
 *  InlineCell. */
function ModalCell({
  row,
  column,
  members,
  lookupValue,
  rows,
  onSave,
}: {
  row: Row
  column: Column
  members: Member[]
  lookupValue: (column: Column, row: Row) => string | null
  rows: Row[]
  onSave: (v: CellValue) => void
}) {
  if (column.type === 'lookup') {
    const text = lookupValue(column, row) ?? ''
    return (
      <div className="w-full whitespace-pre-wrap break-words px-2.5 py-1.5 text-[12.5px] text-[var(--ink2)]">
        {text || <span className="text-[var(--ink3)]">—</span>}
      </div>
    )
  }
  if (column.type === 'text') {
    return (
      <AutoTextarea
        value={row.data[column.id] == null ? '' : String(row.data[column.id])}
        onSave={(v) => onSave(v === '' ? null : v)}
      />
    )
  }
  // member / dropdown / status / number / date: short, reuse InlineCell.
  return (
    <div className="flex w-full items-center">
      <InlineCell
        row={row}
        column={column}
        members={members}
        lookupValue={lookupValue}
        rows={rows}
        onSave={onSave}
      />
    </div>
  )
}

/** Textarea that auto-grows to fit its content and saves on blur. Shows the full
 *  text without a nested modal (大規模入力でもインラインで全文表示・編集)。 */
function AutoTextarea({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [val, setVal] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setVal(value), [value])
  const resize = () => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }
  useEffect(resize, [val])
  return (
    <textarea
      ref={ref}
      value={val}
      rows={1}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => {
        if (val.trim() !== value) onSave(val.trim())
      }}
      className="w-full min-w-0 resize-none overflow-hidden bg-transparent px-2.5 py-1.5 text-[12.5px] leading-relaxed outline-none"
    />
  )
}

/** Read-only status badge computed from milestones (Feature 6). */
export function AutoStatusCell({
  badge,
}: {
  badge: ReturnType<typeof statusFromPhases>
}) {
  return (
    <div
      className="flex items-center px-2.5"
      title="達成状況から自動判定（読み取り専用）"
    >
      {badge ? (
        <Badge color={badge.color} bg={badge.bg}>
          {badge.label}
        </Badge>
      ) : (
        <span className="text-[12px] text-[var(--ink3)]">—</span>
      )}
    </div>
  )
}

/** Click-to-edit ID (key_value) cell. Fixed width input avoids reflow. */
export function IdCell({ row, onSave }: { row: Row; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(row.key_value ?? '')
  useEffect(() => setVal(row.key_value ?? ''), [row.key_value])

  if (!editing) {
    return (
      <button
        type="button"
        title="IDを編集"
        onClick={() => setEditing(true)}
        className="box-border w-full truncate px-2 py-1 text-left font-semibold hover:bg-[var(--line2)] rounded"
      >
        {row.key_value || '—'}
      </button>
    )
  }
  const commit = () => {
    setEditing(false)
    const v = val.trim()
    if (v && v !== row.key_value) onSave(v)
    else setVal(row.key_value ?? '')
  }
  return (
    <input
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          setVal(row.key_value ?? '')
          setEditing(false)
        }
      }}
      className="box-border w-full rounded border-[1.5px] border-[var(--green-l)] bg-[var(--surface)] px-2 py-1 text-[12.5px] font-semibold outline-none"
    />
  )
}
