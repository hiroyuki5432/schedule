// Inline editable attribute cell, keyed by column type. Click to enter edit
// mode; commit on Enter/blur/select-change, cancel on Escape. Shared by the
// schedule frozen columns and the TableSheetView.
//
// Runtime note: row.data keys and member/option ids are numbers at runtime but
// typed as string. We stringify for comparison and coerce on save.

import { useEffect, useRef, useState } from 'react'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
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
        title="参照列（読み取り専用）"
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

function MemberChip({ members, id }: { members: Member[]; id: string }) {
  const m = members.find((x) => String(x.id) === id)
  if (!m) return <span className="text-[12px] text-[var(--ink3)]">—</span>
  return (
    <span className="flex items-center gap-1.5 overflow-hidden">
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
