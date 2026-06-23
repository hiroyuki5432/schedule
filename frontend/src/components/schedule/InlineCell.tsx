// Inline editable attribute cell, keyed by column type. Click to enter edit
// mode; commit on Enter/blur/select-change, cancel on Escape. Shared by the
// schedule frozen columns and the TableSheetView.
//
// Runtime note: row.data keys and member/option ids are numbers at runtime but
// typed as string. We stringify for comparison and coerce on save.

import { useEffect, useRef, useState } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { deriveStatus, literalStatusBadge, statusOptions } from '@/lib/status'
import { cn } from '@/lib/format'
import type { CellValue, Column, Member, Row } from '@/types/api'

interface Props {
  row: Row
  column: Column
  members: Member[]
  /** Lookup resolver: returns display value for a lookup column, or null. */
  lookupValue?: (column: Column, row: Row) => string | null
  /** All rows in the sheet — used to build the status option list. */
  rows?: Row[]
  onSave: (value: CellValue) => void
  className?: string
  /** Visual padding/size context. */
  compact?: boolean
  /** When false, editable types render read-only (e.g. as-of snapshot). Default true. */
  editable?: boolean
}

function raw(row: Row, column: Column): CellValue {
  return row.data[column.id] ?? null
}

export function InlineCell({
  row,
  column,
  members,
  lookupValue,
  rows,
  onSave,
  className,
  compact,
  editable = true,
}: Props) {
  const [editing, setEditing] = useState(false)
  const value = raw(row, column)
  const pad = compact ? 'px-2.5' : 'px-3'

  // --- Editable status: badge when idle, dropdown of values when editing ---
  if (column.type === 'status') {
    const statusCol = column
    // Stored value wins; else derive from rules.
    const stored = row.data[statusCol.id]
    let badge =
      stored != null && stored !== '' ? literalStatusBadge(String(stored)) : null
    if (!badge) badge = deriveStatus(row, statusCol)
    const badgeNode = badge ? (
      <Badge color={badge.color} bg={badge.bg}>
        {badge.label}
      </Badge>
    ) : null
    if (!editable) {
      return <div className={cn('flex h-full items-center', pad, className)}>{badgeNode}</div>
    }
    const options = statusOptions(statusCol, rows ?? [row])
    return (
      <SelectCell
        className={className}
        pad={pad}
        editing={editing}
        setEditing={setEditing}
        value={stored == null ? '' : String(stored)}
        options={options.map((o) => ({
          value: o.value,
          label: o.value,
          color: o.badge.bg,
          textColor: o.badge.color,
        }))}
        onSave={(v) => onSave(v === '' ? null : v)}
        display={badgeNode}
      />
    )
  }

  if (column.type === 'lookup') {
    const text = lookupValue?.(column, row) ?? ''
    return (
      <div
        className={cn(
          'flex h-full items-center overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-[var(--ink3)]',
          pad,
          className,
        )}
        title={text ? `${text}（参照列・読み取り専用）` : '参照列（読み取り専用）'}
      >
        {text}
      </div>
    )
  }

  // --- Editable: member / dropdown ---
  if (column.type === 'member') {
    return (
      <SelectCell
        className={className}
        pad={pad}
        editing={editing}
        setEditing={setEditing}
        value={value == null ? '' : String(value)}
        options={members.map((m) => ({ value: String(m.id), label: m.name }))}
        onSave={(v) => onSave(v === '' ? null : Number(v))}
        display={
          value == null ? null : (
            <MemberChip members={members} id={String(value)} />
          )
        }
      />
    )
  }

  if (column.type === 'dropdown') {
    const options = (column.config?.options ?? []).map((o) => ({
      value: o.value,
      label: o.value,
      color: o.color,
    }))
    const opt = options.find((o) => o.value === String(value ?? ''))
    return (
      <SelectCell
        className={className}
        pad={pad}
        editing={editing}
        setEditing={setEditing}
        value={value == null ? '' : String(value)}
        options={options}
        onSave={(v) => onSave(v === '' ? null : v)}
        display={
          opt ? (
            <Badge bg={opt.color ?? '#EFEDE4'} color="#3a382f">
              {opt.label}
            </Badge>
          ) : null
        }
      />
    )
  }

  // --- Editable: multi-line free text (large input mode) → modal textarea ---
  if (column.type === 'text' && column.config?.multiline) {
    return (
      <MultilineCell
        value={value == null ? '' : String(value)}
        editable={editable}
        pad={pad}
        label={column.name}
        className={className}
        onSave={(v) => onSave(v === '' ? null : v)}
      />
    )
  }

  // --- Editable: text / number / date (text inputs) ---
  const inputType = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'
  const display =
    value == null || value === '' ? (
      <span className="text-[var(--ink3)]">—</span>
    ) : (
      String(value)
    )

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        // Full value on hover so narrow columns stay readable (truncated text).
        title={value == null || value === '' ? undefined : String(value)}
        className={cn(
          'box-border flex h-full w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded text-left text-[12.5px] hover:bg-[var(--line2)]',
          pad,
          className,
        )}
      >
        {display}
      </button>
    )
  }

  return (
    <TextCellInput
      type={inputType}
      pad={pad}
      className={className}
      initial={value == null ? '' : String(value)}
      onCommit={(v) => {
        setEditing(false)
        const next: CellValue =
          v === '' ? null : column.type === 'number' ? Number(v) : v
        onSave(next)
      }}
      onCancel={() => setEditing(false)}
    />
  )
}

/** Free-text cell with the 複数行入力 flag: the cell shows the first line; clicking
 *  opens a roomy textarea modal for multi-line editing (Feature: 大規模入力). */
function MultilineCell({
  value,
  editable,
  pad,
  label,
  className,
  onSave,
}: {
  value: string
  editable: boolean
  pad: string
  label: string
  className?: string
  onSave: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const firstLine = value.split('\n')[0]
  const hasMore = value.includes('\n')
  return (
    <>
      <button
        type="button"
        onClick={() => editable && setOpen(true)}
        title={value || undefined}
        className={cn(
          'box-border flex h-full w-full items-center gap-1 overflow-hidden rounded text-left text-[12.5px] hover:bg-[var(--line2)]',
          pad,
          className,
        )}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
          {value === '' ? <span className="text-[var(--ink3)]">—</span> : firstLine}
        </span>
        {hasMore && <span className="flex-shrink-0 text-[10px] text-[var(--ink3)]">⋯</span>}
      </button>
      {open && (
        <MultilineCellEditor
          initial={value}
          label={label}
          onCancel={() => setOpen(false)}
          onSave={(v) => {
            setOpen(false)
            onSave(v)
          }}
        />
      )}
    </>
  )
}

function MultilineCellEditor({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string
  label: string
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <Modal title={label || '入力'} onClose={onCancel} widthClass="w-[560px]">
      <textarea
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault()
            onSave(val.trim())
          }
        }}
        rows={12}
        className="w-full resize-y rounded-[8px] border border-[var(--line)] bg-[var(--surface)] p-2.5 text-[13px] leading-relaxed outline-none focus:border-[var(--green-l)]"
      />
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-[var(--ink3)]">
          Ctrl/⌘+Enter で保存 ・ Esc で取消
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            キャンセル
          </Button>
          <Button size="sm" onClick={() => onSave(val.trim())}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function MemberChip({ members, id }: { members: Member[]; id: string }) {
  const m = members.find((x) => String(x.id) === id)
  if (!m) return <span className="text-[12px] text-[var(--ink3)]">—</span>
  return (
    <span className="flex items-center gap-1.5 overflow-hidden" title={m.name}>
      <Avatar name={m.name} seed={String(m.id)} />
      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px]">
        {m.name}
      </span>
    </span>
  )
}

function SelectCell({
  editing,
  setEditing,
  value,
  options,
  onSave,
  display,
  pad,
  className,
}: {
  editing: boolean
  setEditing: (v: boolean) => void
  value: string
  options: Array<{ value: string; label: string; color?: string; textColor?: string }>
  onSave: (v: string) => void
  display: React.ReactNode
  pad: string
  className?: string
}) {
  const ref = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'box-border flex h-full w-full items-center overflow-hidden rounded text-left hover:bg-[var(--line2)]',
          pad,
          className,
        )}
      >
        {display ?? <span className="text-[12px] text-[var(--ink3)]">—</span>}
      </button>
    )
  }

  return (
    <select
      ref={ref}
      defaultValue={value}
      className={cn(
        'box-border h-full w-full rounded border border-[var(--green-l)] bg-[var(--surface)] text-[12.5px] outline-none',
        pad,
        className,
      )}
      onBlur={() => setEditing(false)}
      onChange={(e) => {
        setEditing(false)
        onSave(e.target.value)
      }}
    >
      <option value="">（未設定）</option>
      {options.map((o) => (
        <option
          key={o.value}
          value={o.value}
          style={o.color ? { background: o.color, color: o.textColor } : undefined}
        >
          {o.label}
        </option>
      ))}
    </select>
  )
}

function TextCellInput({
  type,
  initial,
  onCommit,
  onCancel,
  pad,
  className,
}: {
  type: string
  initial: string
  onCommit: (v: string) => void
  onCancel: () => void
  pad: string
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [val, setVal] = useState(initial)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      type={type}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => onCommit(val.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(val.trim())
        if (e.key === 'Escape') onCancel()
      }}
      className={cn(
        'box-border h-full w-full rounded border border-[var(--green-l)] bg-[var(--surface)] text-[12.5px] outline-none',
        pad,
        className,
      )}
    />
  )
}
