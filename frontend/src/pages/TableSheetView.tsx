// Editable table for non-grid sheets: attribute columns × rows, no weekly grid.
// Each cell is editable per column type via InlineCell (text/number/date inputs,
// dropdown/member selects, lookup read-only, status badge computed). Add row.
import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useMembers } from '@/hooks/useSheets'
import { useRowMutation } from '@/hooks/useRowMutation'
import { useLookupTargets } from '@/hooks/useLookupTargets'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { InlineCell } from '@/components/schedule/InlineCell'
import { AutoStatusCell, IdCell, RecordModal } from '@/components/RecordModal'
import { DefaultViewButton, SearchBox } from '@/components/ViewControls'
import { statusFromPhases } from '@/lib/status'
import { ColumnHeaderMenu } from '@/components/schedule/ColumnHeaderMenu'
import { buildColFilterOptions, filterKindOf, matchColFilter } from '@/lib/colFilter'
import type { ColFilter, ColFilterOptions } from '@/lib/colFilter'
import { cn, normalizeDateForSort } from '@/lib/format'
import { ID_COL_KEY, defaultColWidth, fitWidth, useColumnWidths } from '@/lib/colWidth'
import { usePersistentState } from '@/hooks/usePersistentState'
import { toast } from '@/lib/toast'
import { ExpandIcon, PlusIcon, TrashIcon } from '@/components/ui/icons'
import type { CellValue, Column, Member, Milestone, Row } from '@/types/api'

interface Props {
  sheetId: string
  sheetName: string
}

// Frozen (sticky) cells. Rules are inset shadows, not borders: with
// border-collapse a border on a stuck cell is painted by the table grid and
// scrolls away with it.
const SH_BOTTOM = 'shadow-[inset_0_-1px_0_var(--line)]'
const SH_RIGHT = 'shadow-[inset_-1px_0_0_var(--line)]'
const SH_BOTH = 'shadow-[inset_0_-1px_0_var(--line),inset_-1px_0_0_var(--line)]'
/** Width of the fixed leading columns (開く / ID), matching <colgroup>. */
const OPEN_W = 56
// Default only — the ID header has a drag handle like every other column, with
// the override kept in the shared width map under ID_COL_KEY.
const ID_W_DEFAULT = 120

/** Header cell: pinned to the top of the scrolling card so 見出し stays visible
 *  while scrolling down (要望: スケジュールのように見出しは常に表示). Needs its own
 *  opaque background — rows scroll underneath it. */
const TH = `sticky top-0 z-20 bg-[var(--surface)] py-2.5 ${SH_BOTTOM}`
/** Header cell that is ALSO frozen to the left (行の識別＋固定列). */
const TH_PIN = 'sticky top-0 z-30 bg-[var(--surface)] py-2.5'
/** Body cell frozen to the left; keeps the row-hover tint. */
const TD_PIN = 'sticky z-10 bg-[var(--surface)] group-hover/row:bg-[#FCFBF7]'

// ---- Client-side sorting (Feature 1) ----------------------------------------
type SortDir = 'asc' | 'desc'
const SORT_ID = '__id__'
interface SortState {
  key: string
  dir: SortDir
}

/** What 既定の表示 remembers for a table sheet. */
interface TableView {
  search: string
  colFilters: Record<string, ColFilter>
  sort: SortState | null
}
const EMPTY_TABLE_VIEW: TableView = { search: '', colFilters: {}, sort: null }

function cycleSort(prev: SortState | null, key: string): SortState | null {
  if (!prev || prev.key !== key) return { key, dir: 'asc' }
  if (prev.dir === 'asc') return { key, dir: 'desc' }
  return null
}

function SortArrow({ dir }: { dir: SortDir | null }) {
  if (!dir) return null
  return <span className="ml-0.5 text-[9px]">{dir === 'asc' ? '▲' : '▼'}</span>
}

/** Display string for a cell — only used to measure the content-fit width. */
function measureValue(
  c: Column,
  row: Row,
  members: Member[],
  lookupValue: (column: Column, row: Row) => string | null,
): string {
  if (c.type === 'member') {
    const id = row.data[c.id]
    return members.find((m) => String(m.id) === String(id ?? ''))?.name ?? ''
  }
  if (c.type === 'lookup') return lookupValue(c, row) ?? ''
  const v = row.data[c.id]
  // Multi-line text only ever shows its first line in the table.
  return v == null ? '' : String(v).split('\n')[0]
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

  // Client-side sort on the displayed rows (Feature 1). Persisted per sheet so the
  // last sort resumes on reload (要望: 前回の表示から開始).
  const [sort, setSort] = usePersistentState<SortState | null>(
    `view:table:${sheetId}:sort`,
    null,
  )
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
    // Date columns: literal placeholder dash 「-」 sorts as empty (always last).
    if (c.type === 'date') return normalizeDateForSort(v)
    return String(v)
  }
  // ---- Per-column filters (要望: テーブルもスケジュールと同じように絞り込み) ------
  // Same model as the schedule: options are built from the UNFILTERED rows so a
  // menu always lists every choice, and a surviving key means real narrowing.
  const [colFilters, setColFilters] = usePersistentState<Record<string, ColFilter>>(
    `view:table:${sheetId}:colFilters`,
    {},
  )
  const resolveColValue = useCallback(
    (r: Row, col: Column): string =>
      // An auto status shows a computed badge, not row.data — filter on what the
      // user actually sees.
      col.id === autoStatusColId
        ? (autoStatusByRow.get(r.id)?.label ?? '')
        : measureValue(col, r, members, lookupValue),
    [members, lookupValue, autoStatusColId, autoStatusByRow],
  )
  const filterOptions = useMemo(
    () => buildColFilterOptions(columns, rows, resolveColValue),
    [columns, rows, resolveColValue],
  )
  const [search, setSearch] = usePersistentState(`view:table:${sheetId}:search`, '')

  // 既定の表示: the saved 検索/絞り込み/並べ替え for this sheet, same model as the
  // schedule so both screens behave identically.
  const [defaultView, setDefaultView] = usePersistentState<TableView | null>(
    `view:table:${sheetId}:defaultView`,
    null,
  )
  function applyView(v: TableView) {
    setSearch(v.search ?? '')
    setColFilters(v.colFilters ?? {})
    setSort(v.sort ?? null)
  }
  function resetView() {
    applyView(defaultView ?? EMPTY_TABLE_VIEW)
    toast.show(
      defaultView ? '既定の表示に戻しました' : '検索・絞り込み・並べ替えを解除しました',
      'success',
      2000,
    )
  }

  const anyColFilter = Object.keys(colFilters).length > 0
  const q = search.trim().toLowerCase()
  const filteredRows = useMemo(() => {
    if (!anyColFilter && !q) return rows
    const colById = new Map(columns.map((c) => [String(c.id), c]))
    const entries = Object.entries(colFilters)
    return rows.filter((r) => {
      for (const [colId, f] of entries) {
        const col = colById.get(String(colId))
        if (col && !matchColFilter(f, resolveColValue(r, col))) return false
      }
      if (q) {
        // ID + every column's DISPLAYED value, so what you search is what you see.
        const parts = [r.key_value ?? '']
        for (const c of columns) parts.push(resolveColValue(r, c))
        if (!parts.join(' ').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [rows, columns, colFilters, anyColFilter, q, resolveColValue])

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filteredRows].sort((a, b) => {
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
  }, [filteredRows, sort, columns, members, autoStatusByRow])
  const dirFor = (key: string): SortDir | null =>
    sort?.key === key ? sort.dir : null

  // Column widths: fit each column to its widest value instead of a flat 200px
  // (要望: リスト作成時 幅広すぎ)、and let the header edge be dragged to a fixed
  // width that sticks (shared with the schedule grid, keyed by column id).
  const fitWidths = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of columns)
      m.set(
        c.id,
        fitWidth(
          c,
          rows.map((r) => measureValue(c, r, members, lookupValue)),
        ),
      )
    return m
  }, [columns, rows, members, lookupValue])
  const { colW, startResize, resetWidth } = useColumnWidths()
  const cw = (c: Column) => colW[c.id] ?? fitWidths.get(c.id) ?? defaultColWidth(c)
  const idW = colW[ID_COL_KEY] ?? ID_W_DEFAULT
  /** Total table width: 開く + ID + every attribute column + the trailing 削除
   *  column. Handed to the <table> so `table-fixed` treats the <colgroup> as
   *  authoritative (see the note at the table). */
  const tableW = OPEN_W + idW + columns.reduce((s, c) => s + cw(c), 0) + 48

  // Frozen columns (表示固定), same model as the schedule: 開く＋ID are always
  // frozen, then the sheet's 「左端に固定する列」 count, with a 通常／最小 toggle.
  const settings = detailQ.data?.sheet.settings
  const [pinsCollapsed, setPinsCollapsed] = usePersistentState(
    `view:table:${sheetId}:pinsCollapsed`,
    false,
  )
  const pinnedFull = Math.min(settings?.pinned_columns ?? 0, columns.length)
  const pinnedMin = Math.min(settings?.pinned_columns_narrow ?? 0, pinnedFull)
  const pinnedCount = Math.max(0, pinsCollapsed ? pinnedMin : pinnedFull)
  /** Left offset (px) of each frozen attribute column. */
  const pinLefts = useMemo(() => {
    const out: number[] = []
    let x = OPEN_W + idW
    for (let i = 0; i < pinnedCount; i++) {
      out.push(x)
      x += cw(columns[i])
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, pinnedCount, colW, fitWidths, idW])
  /** Frozen columns are the ID pair plus `pinnedCount` attributes; the last one
   *  carries the separating edge. */
  const isPinned = (i: number) => i < pinnedCount
  const lastPinnedAttr = pinnedCount - 1

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
          <div className="flex items-center gap-2">
            <SearchBox value={search} onChange={setSearch} />

            {/* Active-filter indicator + clear-all, same as the schedule. */}
            {(anyColFilter || !!q) && (
              <button
                onClick={() => {
                  setColFilters({})
                  setSearch('')
                }}
                title="検索と、すべての列の絞り込みを解除"
                className="rounded-[9px] border border-[var(--green)] bg-[var(--green-l)]/15 px-2.5 py-1.5 text-[12px] text-[var(--green-d)] hover:bg-[var(--green-l)]/30"
              >
                絞り込み {filteredRows.length}/{rows.length} ×
              </button>
            )}
            <DefaultViewButton
              hasDefault={defaultView != null}
              onReset={resetView}
              onSave={() => {
                setDefaultView({ search, colFilters, sort })
                toast.show('今の検索・絞り込み・並べ替えを既定にしました', 'success', 2500)
              }}
              onClear={() => {
                setDefaultView(null)
                toast.show('既定の表示を削除しました', 'info', 2000)
              }}
            />

            {pinnedFull > 0 && (
              /* frozen columns 通常/最小 toggle (列数はシート設定) */
              <button
                onClick={() => setPinsCollapsed((c) => !c)}
                title="固定列を通常／最小に切替（固定する列数はシート設定で指定）"
                className={cn(
                  'rounded-[9px] border px-3 py-1.5 text-[12px]',
                  pinsCollapsed
                    ? 'border-[var(--green)] bg-[var(--green)] font-medium text-white'
                    : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink2)] hover:bg-[var(--line2)]',
                )}
              >
                固定列: {pinsCollapsed ? '最小' : '通常'}
              </button>
            )}
            <Button size="sm" onClick={addRow}>
              <PlusIcon className="h-[15px] w-[15px]" />
              新規行
            </Button>
          </div>
        }
      />

      {/* The CARD is the scroller (not this wrapper) so the header row can stay
          pinned while scrolling — same behaviour as the schedule grid. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-[22px] pb-6">
        {detailQ.isLoading ? (
          <Card>
            <TableSkeleton rows={7} cols={5} />
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState
            title="まだレコードがありません"
            body="「新規行」で1件追加すると、列に沿って値を入れられます。列の追加や変更はシート設定から行えます。"
            actions={
              <Button size="sm" onClick={addRow}>
                <PlusIcon className="h-[15px] w-[15px]" />
                最初のレコードを追加
              </Button>
            }
          />
        ) : filteredRows.length === 0 ? (
          <EmptyState
            title={q ? '検索に一致するレコードがありません' : '絞り込みに一致するレコードがありません'}
            body={`${rows.length} 件のうち、条件に合うものがありませんでした。検索語を変えるか、見出しの ⋮ から条件を緩めてください。`}
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setColFilters({})
                  setSearch('')
                }}
              >
                検索・絞り込みを解除
              </Button>
            }
          />
        ) : (
          <Card className="min-h-0 overflow-auto">
            {/* An EXPLICIT width (the sum of the columns), not `w-max`.
                `table-fixed` only takes the <colgroup> as authoritative when the
                table has a definite width — with an auto/max-content width the
                browser falls back to sizing from content, which is why some
                columns refused to get narrower than their contents
                (要望: 縮められない列がある). A fixed number also stops the table
                stretching across a wide screen (要望: スカスカ). */}
            <table
              className="table-fixed border-collapse text-[12.5px]"
              style={{ width: tableW }}
            >
              <colgroup>
                <col style={{ width: 56 }} />
                <col style={{ width: idW }} />
                {columns.map((c) => (
                  <col key={c.id} style={{ width: cw(c) }} />
                ))}
                <col style={{ width: 48 }} />
              </colgroup>
              {/* Sticky header: each cell carries the background + bottom border,
                  because a <tr>'s own border does not paint while stuck. */}
              <thead>
                <tr className="text-left text-[var(--ink3)]">
                  <th className={cn(TH_PIN, SH_BOTTOM, 'px-2')} style={{ left: 0 }} />
                  <th
                    className={cn(
                      TH_PIN,
                      pinnedCount === 0 ? SH_BOTH : SH_BOTTOM,
                      'relative px-3 font-medium',
                    )}
                    style={{ left: OPEN_W }}
                  >
                    <SortHeader
                      label="ID"
                      dir={dirFor(SORT_ID)}
                      onClick={() => setSort((p) => cycleSort(p, SORT_ID))}
                    />
                    {/* The ID column resizes like any other (要望: 縮められない列がある). */}
                    <span
                      onMouseDown={(e) => startResize(e, ID_COL_KEY, idW)}
                      onDoubleClick={() => resetWidth(ID_COL_KEY)}
                      title="ドラッグで列幅を変更（ダブルクリックで既定に戻す）"
                      className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[var(--green-l)]/40"
                    />
                  </th>
                  {columns.map((c, i) => (
                    <th
                      key={c.id}
                      className={cn(
                        'relative px-3 font-medium',
                        isPinned(i) ? TH_PIN : TH,
                        isPinned(i) && (i === lastPinnedAttr ? SH_BOTH : SH_BOTTOM),
                      )}
                      style={isPinned(i) ? { left: pinLefts[i] } : undefined}
                    >
                      <AttrHeader
                        col={c}
                        dir={dirFor(c.id)}
                        filter={colFilters[String(c.id)]}
                        options={filterOptions.get(String(c.id))}
                        onSort={() => setSort((p) => cycleSort(p, c.id))}
                        onFilter={(next) =>
                          setColFilters((prev) => {
                            const out = { ...prev }
                            if (next) out[String(c.id)] = next
                            else delete out[String(c.id)]
                            return out
                          })
                        }
                      />
                      <span
                        onMouseDown={(e) => startResize(e, c.id, cw(c))}
                        onDoubleClick={() => resetWidth(c.id)}
                        title="ドラッグで列幅を変更（ダブルクリックで自動幅に戻す）"
                        className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-[var(--green-l)]/40"
                      />
                    </th>
                  ))}
                  <th className={`${TH} px-3`} />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    className="group/row border-b border-[var(--line2)] hover:bg-[#FCFBF7]"
                  >
                    <td className={cn(TD_PIN, 'px-2 py-1')} style={{ left: 0 }}>
                      {/* Icon-only, and only inked on row hover: one of these sits
                          on every row, so a boxed 「開く」 button turned the whole
                          left edge into visual noise. */}
                      <button
                        title="このレコードを開く（詳細・編集）"
                        aria-label="このレコードを開く"
                        onClick={() => setModalRowId(row.id)}
                        className="flex h-6 w-6 items-center justify-center rounded text-[var(--line)] transition-colors hover:bg-[var(--line2)] hover:text-[var(--ink)] group-hover/row:text-[var(--ink3)]"
                      >
                        <ExpandIcon className="h-[14px] w-[14px]" />
                      </button>
                    </td>
                    <td
                      className={cn(TD_PIN, pinnedCount === 0 && SH_RIGHT, 'px-1 py-1')}
                      style={{ left: OPEN_W }}
                    >
                      <IdCell row={row} onSave={(v) => saveKey(row, v)} />
                    </td>
                    {columns.map((c, i) => (
                      <td
                        key={c.id}
                        className={cn(
                          // overflow-hidden: a cell must never spill into its
                          // neighbour when the column is dragged narrow.
                          'overflow-hidden px-0 py-1',
                          isPinned(i) && TD_PIN,
                          isPinned(i) && i === lastPinnedAttr && SH_RIGHT,
                        )}
                        style={isPinned(i) ? { left: pinLefts[i] } : undefined}
                      >
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
        'flex min-w-0 items-center overflow-hidden font-medium hover:text-[var(--ink2)]' +
        (dir ? ' text-[var(--ink)]' : '')
      }
    >
      <span className="truncate">{label}</span>
      <SortArrow dir={dir} />
    </button>
  )
}

/** Attribute column header: the TITLE sorts, the ⋮ on the right opens the
 *  filter menu (要望: タイトルクリックはソート、右の点クリックで絞り込み). Keeping the
 *  two apart means sorting never costs an extra click through a menu. */
function AttrHeader({
  col,
  dir,
  filter,
  options,
  onSort,
  onFilter,
}: {
  col: Column
  dir: SortDir | null
  filter: ColFilter | undefined
  options: ColFilterOptions | undefined
  onSort: () => void
  onFilter: (next: ColFilter | undefined) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const opts: ColFilterOptions = options ?? {
    kind: filterKindOf(col),
    values: [],
    hasBlank: false,
    numMin: null,
    numMax: null,
  }
  return (
    <div ref={ref} className="flex min-w-0 items-center gap-1">
      <SortHeader label={col.name} dir={dir} onClick={onSort} />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={filter ? '絞り込み中（クリックで変更・解除）' : 'クリックで絞り込み'}
        className={cn(
          'ml-auto flex-shrink-0 rounded px-0.5 text-[12px] leading-none hover:bg-[var(--line2)]',
          filter ? 'text-[var(--green-d)]' : 'text-[var(--ink3)]',
        )}
      >
        {filter ? '⏷' : '⋮'}
      </button>
      {open && (
        <ColumnHeaderMenu
          colName={col.name}
          kind={filterKindOf(col)}
          options={opts}
          filter={filter}
          // Sorting lives on the title, so the menu is filter-only here.
          sortDir={null}
          filterable
          sortable={false}
          anchorRef={ref}
          onSort={() => {}}
          onFilter={onFilter}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}


