// Editable table for non-grid sheets: attribute columns × rows, no weekly grid.
// Each cell is editable per column type via InlineCell (text/number/date inputs,
// dropdown/member selects, lookup read-only, status badge computed). Add row.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers } from '@/hooks/useSheets'
import { useRowMutation } from '@/hooks/useRowMutation'
import { useLookupTargets } from '@/hooks/useLookupTargets'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { InlineCell } from '@/components/schedule/InlineCell'
import { Modal } from '@/components/ui/Modal'
import { statusFromPhases } from '@/lib/status'
import { PlusIcon, TrashIcon } from '@/components/ui/icons'
import type { CellValue, Column, Member, Milestone, Row } from '@/types/api'

interface Props {
  sheetId: string
  sheetName: string
}

// ---- Client-side sorting (Feature 1) ----------------------------------------
type SortDir = 'asc' | 'desc'
const SORT_ID = '__id__'
interface SortState {
  key: string
  dir: SortDir
}

function cycleSort(prev: SortState | null, key: string): SortState | null {
  if (!prev || prev.key !== key) return { key, dir: 'asc' }
  if (prev.dir === 'asc') return { key, dir: 'desc' }
  return null
}

function SortArrow({ dir }: { dir: SortDir | null }) {
  if (!dir) return null
  return <span className="ml-0.5 text-[9px]">{dir === 'asc' ? '▲' : '▼'}</span>
}

/** Fixed table-column width by type, so display↔edit never reflows neighbors. */
function colWidth(c: Column): number {
  switch (c.type) {
    case 'status':
      return 140
    case 'member':
      return 160
    case 'date':
      return 140
    case 'number':
      return 110
    case 'lookup':
      return 180
    default:
      return 200
  }
}

export function TableSheetView({ sheetId, sheetName }: Props) {
  const qc = useQueryClient()
  const membersQ = useMembers()
  const members = useMemo(() => membersQ.data ?? [], [membersQ.data])
  const rowMut = useRowMutation(sheetId)

  const detailQ = useQuery({
    queryKey: ['sheet', sheetId],
    queryFn: () => api.getSheet(sheetId),
  })

  const columns: Column[] = useMemo(
    () => [...(detailQ.data?.columns ?? [])].sort((a, b) => a.order - b.order),
    [detailQ.data],
  )
  const rows: Row[] = useMemo(() => detailQ.data?.rows ?? [], [detailQ.data])
  const { lookupValue } = useLookupTargets(columns, members)

  // Feature 6: when a status column auto-derives from milestones, fetch each
  // row's milestones (batched) and compute a read-only badge per row.
  const autoStatusColId = useMemo(
    () =>
      columns.find((c) => c.type === 'status' && c.config?.auto_from_milestones)
        ?.id ?? null,
    [columns],
  )
  const milestonesQ = useQuery({
    queryKey: ['sheet-milestones', sheetId],
    queryFn: () => api.getSheetMilestones(sheetId),
    enabled: !!autoStatusColId,
  })
  const autoStatusByRow = useMemo(() => {
    const map = new Map<string, ReturnType<typeof statusFromPhases>>()
    if (!autoStatusColId) return map
    const byRow = new Map<string, Milestone[]>()
    for (const ms of milestonesQ.data ?? []) {
      const arr = byRow.get(String(ms.row_id))
      if (arr) arr.push(ms)
      else byRow.set(String(ms.row_id), [ms])
    }
    rows.forEach((r) => {
      // No effort data in the table view → don't force 未着手 by effort; show the
      // current phase (or 完了 when the final milestone is achieved).
      map.set(
        r.id,
        statusFromPhases(byRow.get(String(r.id)) ?? [], {
          actualSum: Number.POSITIVE_INFINITY,
        }),
      )
    })
    return map
  }, [rows, autoStatusColId, milestonesQ.data])

  // Per-record modal (詳細・編集): track the open row by id so it stays fresh
  // across refetches.
  const [modalRowId, setModalRowId] = useState<string | null>(null)
  const modalRow = rows.find((r) => r.id === modalRowId) ?? null

  // Client-side sort on the displayed rows (Feature 1).
  const [sort, setSort] = useState<SortState | null>(null)
  function sortValueFor(row: Row, key: string): string | number {
    if (key === SORT_ID) return row.key_value ?? ''
    const c = columns.find((x) => x.id === key)
    if (!c) return ''
    if (c.type === 'status' && c.id === autoStatusColId) {
      return autoStatusByRow.get(row.id)?.label ?? ''
    }
    if (c.type === 'member') {
      const id = row.data[c.id]
      const m = members.find((x) => String(x.id) === String(id ?? ''))
      return m?.name ?? ''
    }
    if (c.type === 'lookup') return lookupValue(c, row) ?? ''
    const v = row.data[c.id]
    if (v == null || v === '') return ''
    if (c.type === 'number') {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    return String(v)
  }
  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = sortValueFor(a, sort.key)
      const bv = sortValueFor(b, sort.key)
      const aEmpty = av === '' || av == null
      const bEmpty = bv === '' || bv == null
      if (aEmpty && bEmpty) return 0
      if (aEmpty) return 1
      if (bEmpty) return -1
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv), 'ja')
      return cmp * dir
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, columns, members, autoStatusByRow])
  const dirFor = (key: string): SortDir | null =>
    sort?.key === key ? sort.dir : null

  function addRow() {
    api
      .createRow(sheetId, { data: {} })
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
      .catch(() => {
        /* TODO: toast on failure */
      })
  }

  function saveCell(row: Row, colId: string, value: CellValue) {
    rowMut.mutate({ row, patch: { [colId]: value } })
  }

  function saveKey(row: Row, key: string) {
    api
      .updateRow(row.id, { data: row.data, version: row.version, key_value: key })
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
      .catch(() => {
        /* TODO: toast on failure (e.g. duplicate ID) */
      })
  }

  function deleteRow(row: Row) {
    if (!confirm(`行「${row.key_value}」を削除しますか？`)) return
    api
      .deleteRow(row.id)
      .then(() => qc.invalidateQueries({ queryKey: ['sheet', sheetId] }))
      .catch(() => {
        /* TODO: toast on failure */
      })
  }

  return (
    <>
      <PageHeader
        title={sheetName}
        subtitle="テーブル（集計・参照）"
        actions={
          <Button size="sm" onClick={addRow}>
            <PlusIcon className="h-[15px] w-[15px]" />
            新規行
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-[22px] pb-6">
        {detailQ.isLoading ? (
          <Card className="flex flex-1 items-center justify-center text-[var(--ink3)]">
            読み込み中…
          </Card>
        ) : (
          <Card className="overflow-auto">
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <colgroup>
                <col style={{ width: 56 }} />
                <col style={{ width: 120 }} />
                {columns.map((c) => (
                  <col key={c.id} style={{ width: colWidth(c) }} />
                ))}
                <col style={{ width: 48 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
                  <th className="px-2 py-2.5" />
                  <th className="px-3 py-2.5 font-medium">
                    <SortHeader
                      label="ID"
                      dir={dirFor(SORT_ID)}
                      onClick={() => setSort((p) => cycleSort(p, SORT_ID))}
                    />
                  </th>
                  {columns.map((c) => (
                    <th key={c.id} className="px-3 py-2.5 font-medium">
                      <SortHeader
                        label={c.name}
                        dir={dirFor(c.id)}
                        onClick={() => setSort((p) => cycleSort(p, c.id))}
                      />
                    </th>
                  ))}
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    className="group/row border-b border-[var(--line2)] hover:bg-[#FCFBF7]"
                  >
                    <td className="px-2 py-1">
                      <button
                        title="このレコードを開く（詳細・編集）"
                        onClick={() => setModalRowId(row.id)}
                        className="rounded border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--ink2)] hover:bg-[var(--line2)] hover:text-[var(--ink)]"
                      >
                        開く
                      </button>
                    </td>
                    <td className="px-1 py-1">
                      <IdCell row={row} onSave={(v) => saveKey(row, v)} />
                    </td>
                    {columns.map((c) => (
                      <td key={c.id} className="px-0 py-1">
                        {c.id === autoStatusColId ? (
                          <AutoStatusCell badge={autoStatusByRow.get(row.id) ?? null} />
                        ) : (
                          <InlineCell
                            row={row}
                            column={c}
                            members={members}
                            lookupValue={lookupValue}
                            rows={rows}
                            compact
                            onSave={(v) => saveCell(row, c.id, v)}
                          />
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-1 text-right">
                      <button
                        title="行を削除"
                        onClick={() => deleteRow(row)}
                        className="rounded p-1 text-[var(--ink3)] opacity-0 transition-opacity hover:bg-[#FAE6E0] hover:text-[#A8442B] group-hover/row:opacity-100"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={columns.length + 3}
                      className="px-3 py-6 text-center text-[var(--ink3)]"
                    >
                      行がありません。「新規行」で追加します。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      {modalRow && (
        <RecordModal
          row={modalRow}
          columns={columns}
          members={members}
          rows={rows}
          lookupValue={lookupValue}
          autoStatusColId={autoStatusColId}
          autoStatusBadge={autoStatusByRow.get(modalRow.id) ?? null}
          onClose={() => setModalRowId(null)}
          onSaveCell={(colId, v) => saveCell(modalRow, colId, v)}
          onSaveKey={(v) => saveKey(modalRow, v)}
          onDelete={() => {
            deleteRow(modalRow)
            setModalRowId(null)
          }}
        />
      )}
    </>
  )
}

/** Full-record modal: every field labeled and editable (reuses InlineCell).
 *  Opens from a table row's 「開く」 button for focused viewing/editing. */
function RecordModal({
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
  members: ReturnType<typeof useMembers>['data']
  rows: Row[]
  lookupValue: (column: Column, row: Row) => string | null
  autoStatusColId: string | null
  autoStatusBadge: ReturnType<typeof statusFromPhases>
  onClose: () => void
  onSaveCell: (colId: string, v: CellValue) => void
  onSaveKey: (v: string) => void
  onDelete: () => void
}) {
  return (
    <Modal
      title={`レコード詳細 — ${row.key_value || '（IDなし）'}`}
      onClose={onClose}
      widthClass="w-[460px]"
    >
      <div className="flex flex-col gap-3">
        <Field label="ID">
          <IdCell row={row} onSave={onSaveKey} />
        </Field>
        {columns.map((c) => (
          <Field key={c.id} label={c.name}>
            {c.id === autoStatusColId ? (
              <AutoStatusCell badge={autoStatusBadge} />
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
        <Button size="sm" variant="outline" onClick={onClose}>
          閉じる
        </Button>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
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
      className="w-full resize-none overflow-hidden bg-transparent px-2.5 py-1.5 text-[12.5px] leading-relaxed outline-none"
    />
  )
}

/** Clickable column header that toggles asc → desc → none. */
function SortHeader({
  label,
  dir,
  onClick,
}: {
  label: string
  dir: SortDir | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="クリックで並べ替え（昇順→降順→解除）"
      className={
        'flex items-center font-medium hover:text-[var(--ink2)]' +
        (dir ? ' text-[var(--ink)]' : '')
      }
    >
      {label}
      <SortArrow dir={dir} />
    </button>
  )
}

/** Read-only status badge computed from milestones (Feature 6). */
function AutoStatusCell({
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
function IdCell({ row, onSave }: { row: Row; onSave: (v: string) => void }) {
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
