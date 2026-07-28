import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useSheets, useColumns } from '@/hooks/useSheets'
import { usePersistentState } from '@/hooks/usePersistentState'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { Tabs } from '@/components/ui/Tabs'
import type { TabDef } from '@/components/ui/Tabs'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableSkeleton } from '@/components/ui/Skeleton'
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from '@/components/ui/icons'
import { DropdownOptionsEditor } from '@/components/settings/DropdownOptionsEditor'
import { StatusRuleBuilder } from '@/components/settings/StatusRuleBuilder'
import { LookupConfigEditor } from '@/components/settings/LookupConfigEditor'
import { ExcelToolbar } from '@/components/ExcelToolbar'
import { PlusIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import { toast } from '@/lib/toast'
import { ApiError } from '@/lib/http'
import type { Column, ColumnType, DefaultMilestone, SheetSettings } from '@/types/api'

const TYPE_LABEL: Record<ColumnType, string> = {
  text: '自由入力',
  number: '数値',
  date: '日付',
  dropdown: 'プルダウン',
  status: '条件付きステータス',
  member: 'メンバー',
  lookup: '参照(LOOKUP)',
}

export function SheetSettingsPage() {
  const { sheetId } = useParams<{ sheetId: string }>()
  const qc = useQueryClient()
  const sheetsQ = useSheets()
  const sheet = sheetsQ.data?.find((s) => String(s.id) === String(sheetId))

  const columnsQ = useColumns(sheetId)
  const columns = useMemo(
    () => [...(columnsQ.data ?? [])].sort((a, b) => a.order - b.order),
    [columnsQ.data],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = columns.find((c) => String(c.id) === String(selectedId)) ?? null
  const [tab, setTab] = usePersistentState<TabKey>('view:sheetSettings:tab', 'columns')

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['columns', sheetId] })
    void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
  }

  // Move a column to a new position (drag & drop, or the up/down buttons).
  // Rewrites the whole sequence to 0..n-1 and PATCHes only what actually moved,
  // which also repairs sheets whose columns share duplicate order values.
  const reorder = useMutation({
    mutationFn: async ({ from, to }: { from: number; to: number }) => {
      if (from === to || from < 0 || to < 0 || from >= columns.length || to >= columns.length)
        return
      const next = columns.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      await Promise.all(
        next
          .map((c, i) => ({ c, i }))
          .filter(({ c, i }) => c.order !== i)
          .map(({ c, i }) => api.updateColumn(c.id, { order: i })),
      )
    },
    onSuccess: invalidate,
    onError: () => toast.show('列の並べ替えを保存できませんでした。', 'error'),
  })

  if (!sheetId) {
    return <PageHeader title="シート設定" subtitle="シートが選択されていません。" />
  }

  const tabs: ReadonlyArray<TabDef<TabKey>> = [
    { key: 'columns', label: '列', hint: '表に出す項目と、その型・選択肢を決めます。行をドラッグすると並び順を変えられます。' },
    {
      key: 'display',
      label: '表示',
      hint: sheet?.has_week_grid
        ? '固定する列、完了とみなす条件、ガントのフェーズ（◇）などの見え方を設定します。'
        : '固定する列や完了とみなす条件など、一覧の見え方を設定します。',
    },
    { key: 'io', label: '入出力', hint: 'Excel への書き出しと、Excel からの取り込み。' },
    { key: 'danger', label: '危険な操作', hint: '取り消せない操作です。実行前に内容をよく確認してください。' },
  ]

  return (
    <>
      <PageHeader
        title="シート設定"
        subtitle={sheet?.name ?? '—'}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-[22px] pb-6">
        <Tabs tabs={tabs} active={tab} onChange={setTab} className="mb-4" />

        {tab === 'columns' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>列一覧</CardTitle>
              </CardHeader>
              <CardBody className="px-0 py-0">
                {columnsQ.isLoading ? (
                  <TableSkeleton rows={5} cols={4} />
                ) : columns.length === 0 ? (
                  <EmptyState
                    compact
                    title="まだ列がありません"
                    body="「件名」「担当」「ステータス」あたりから作ると、すぐ使える形になります。"
                  />
                ) : (
                  <ColumnList
                    columns={columns}
                    selectedId={selectedId}
                    busy={reorder.isPending}
                    onSelect={setSelectedId}
                    onMove={(from, to) => reorder.mutate({ from, to })}
                    onDeleted={invalidate}
                  />
                )}
                <div className="border-t border-[var(--line)] px-5 py-4">
                  <AddColumnForm
                    sheetId={sheetId}
                    onDone={invalidate}
                    onCreated={setSelectedId}
                  />
                </div>
              </CardBody>
            </Card>

            {selected ? (
              <ColumnDetailEditor
                key={selected.id}
                column={selected}
                columns={columns}
                sheetId={sheetId}
                onDone={invalidate}
              />
            ) : (
              <Card>
                <CardBody>
                  <EmptyState
                    compact
                    title="列を選んでください"
                    body="左の一覧から列をクリックすると、名前・型・型ごとの細かい設定（選択肢やルールなど）を編集できます。"
                  />
                </CardBody>
              </Card>
            )}
          </div>
        )}

        {tab === 'display' && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {sheet && (
              <SheetLevelSettings
                sheetId={sheetId}
                columns={columns}
                hasWeekGrid={sheet.has_week_grid}
                keyColumnId={sheet.key_column_id}
                colorBasisColumnId={sheet.color_basis_column_id}
                settings={sheet.settings ?? {}}
              />
            )}
            {/* Milestones (gantt phases) are schedule-only — hidden for table sheets. */}
            {sheet && sheet.has_week_grid && (
              <DefaultMilestonesEditor sheetId={sheetId} settings={sheet.settings ?? {}} />
            )}
          </div>
        )}

        {tab === 'io' && (
          <div className="max-w-[720px]">
            <ExcelIOCard sheetId={sheetId} />
          </div>
        )}

        {tab === 'danger' && (
          <div className="max-w-[720px]">
            {sheet && <DangerZone sheetId={sheetId} sheetName={sheet.name} />}
          </div>
        )}
      </div>
    </>
  )
}

type TabKey = 'columns' | 'display' | 'io' | 'danger'

/** The column list. Rows drag to reorder; the ▲▼ buttons do the same thing for
 *  anyone not using a mouse. */
function ColumnList({
  columns,
  selectedId,
  busy,
  onSelect,
  onMove,
  onDeleted,
}: {
  columns: Column[]
  selectedId: string | null
  busy: boolean
  onSelect: (id: string) => void
  onMove: (from: number, to: number) => void
  onDeleted: () => void
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead>
        <tr className="border-b border-[var(--line)] text-left text-[var(--ink3)]">
          <th className="px-3 py-2.5 font-medium">並び</th>
          <th className="px-5 py-2.5 font-medium">名前</th>
          <th className="px-5 py-2.5 font-medium">型</th>
          <th className="px-5 py-2.5 font-medium">キー</th>
          <th className="px-5 py-2.5" />
        </tr>
      </thead>
      <tbody>
        {columns.map((c, i) => (
          <tr
            key={c.id}
            draggable={!busy}
            onDragStart={(e) => {
              setDragIndex(i)
              e.dataTransfer.effectAllowed = 'move'
              // Firefox refuses to start a drag without payload.
              e.dataTransfer.setData('text/plain', String(c.id))
            }}
            onDragOver={(e) => {
              if (dragIndex == null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOverIndex(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex != null && dragIndex !== i) onMove(dragIndex, i)
              setDragIndex(null)
              setOverIndex(null)
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
            onClick={() => onSelect(c.id)}
            className={cn(
              'cursor-pointer border-b border-[var(--line2)] hover:bg-[#FCFBF7]',
              String(c.id) === String(selectedId) && 'bg-[#FCFBF7]',
              dragIndex === i && 'opacity-40',
              overIndex === i && dragIndex !== i && 'shadow-[inset_0_2px_0_var(--green)]',
            )}
          >
            <td className="px-3 py-2.5">
              <div className="flex items-center gap-1">
                <span
                  title="ドラッグして並べ替え"
                  className="cursor-grab select-none text-[13px] leading-none text-[var(--ink3)]"
                  aria-hidden
                >
                  ⠿
                </span>
                <div className="flex flex-col">
                  <button
                    title="上へ"
                    disabled={i === 0 || busy}
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMove(i, i - 1)
                    }}
                  >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    title="下へ"
                    disabled={i === columns.length - 1 || busy}
                    className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                    onClick={(e) => {
                      e.stopPropagation()
                      onMove(i, i + 1)
                    }}
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </td>
            <td className="px-5 py-2.5">{c.name}</td>
            <td className="px-5 py-2.5 text-[var(--ink2)]">
              {TYPE_LABEL[c.type]}
              {/* A dropdown with no options can't be picked from — say so here
                  instead of leaving an empty select in the grid. */}
              {c.type === 'dropdown' && (c.config?.options?.length ?? 0) === 0 && (
                <span className="ml-1.5 text-[11px] text-[#A8442B]">選択肢 未設定</span>
              )}
            </td>
            <td className="px-5 py-2.5">
              {c.is_key && (
                <Badge bg="#E3EFEA" color="#266B53">
                  キー
                </Badge>
              )}
            </td>
            <td className="px-5 py-2.5 text-right">
              <DeleteColumnButton columnId={c.id} onDone={onDeleted} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DeleteColumnButton({
  columnId,
  onDone,
}: {
  columnId: string
  onDone: () => void
}) {
  const mutation = useMutation({
    mutationFn: () => api.deleteColumn(columnId),
    onSuccess: onDone,
  })
  return (
    <button
      title="列を削除"
      className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
      onClick={(e) => {
        e.stopPropagation()
        if (confirm('この列を削除しますか？')) mutation.mutate()
      }}
    >
      <TrashIcon className="h-4 w-4" />
    </button>
  )
}

function AddColumnForm({
  sheetId,
  onDone,
  onCreated,
}: {
  sheetId: string
  onDone: () => void
  /** Select the new column so its type-specific editor (選択肢 / ルール / 参照先)
   *  opens immediately — otherwise "プルダウンを追加したのに選択肢が入れられない". */
  onCreated: (columnId: string) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ColumnType>('text')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => api.createColumn(sheetId, { name: name.trim(), type }),
    onSuccess: (col) => {
      setName('')
      setType('text')
      onDone()
      onCreated(String(col.id))
      toast.show(`「${col.name}」を追加しました`, 'success', 2000)
    },
    // Without this a rejected request looked like "追加しても効かない" — nothing
    // moved and nothing was said.
    onError: (e) => {
      const msg = e instanceof ApiError ? e.message : '列を追加できませんでした。'
      setError(msg)
      toast.show(msg, 'error')
    },
  })

  function submit() {
    setError(null)
    if (!name.trim()) {
      setError('列名を入力してください。')
      return
    }
    mutation.mutate()
  }

  return (
    <div>
      <div className="mb-2 text-[12px] font-medium text-[var(--ink2)]">列を追加</div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Input
          placeholder="列名"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          className="flex-1"
        />
        <Select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
          {(Object.keys(TYPE_LABEL) as ColumnType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? '追加中…' : '追加'}
        </Button>
      </form>
      {error && <div className="mt-2 text-[11.5px] text-[#A8442B]">{error}</div>}
      {type === 'dropdown' && !error && (
        <div className="mt-2 text-[11.5px] text-[var(--ink3)]">
          追加すると右側に「選択肢」の編集欄が開きます。そこで値を入れて「保存」してください。
        </div>
      )}
    </div>
  )
}

function ColumnDetailEditor({
  column,
  columns,
  sheetId,
  onDone,
}: {
  column: Column
  columns: Column[]
  sheetId: string
  onDone: () => void
}) {
  const [name, setName] = useState(column.name)
  const [type, setType] = useState<ColumnType>(column.type)

  const meta = useMutation({
    mutationFn: () => api.updateColumn(column.id, { name: name.trim(), type }),
    onSuccess: () => {
      onDone()
      toast.show('保存しました', 'success', 2000)
    },
    onError: () => toast.show('保存に失敗しました', 'error'),
  })
  const weeklyResetMut = useMutation({
    mutationFn: (v: boolean) =>
      api.updateColumn(column.id, { config: { ...(column.config ?? {}), weekly_reset: v } }),
    onSuccess: () => {
      onDone()
      toast.show('保存しました', 'success', 2000)
    },
    onError: () => toast.show('保存に失敗しました', 'error'),
  })
  const multilineMut = useMutation({
    mutationFn: (v: boolean) =>
      api.updateColumn(column.id, { config: { ...(column.config ?? {}), multiline: v } }),
    onSuccess: () => {
      onDone()
      toast.show('保存しました', 'success', 2000)
    },
    onError: () => toast.show('保存に失敗しました', 'error'),
  })
  const canWeeklyReset = ['text', 'number', 'date', 'dropdown'].includes(type)

  const dirty = name.trim() !== column.name || type !== column.type

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{column.name} — 基本</CardTitle>
        </CardHeader>
        <CardBody>
          <div className="flex flex-col gap-3">
            <label className="text-[12px] text-[var(--ink2)]">
              名前
              <Input
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="text-[12px] text-[var(--ink2)]">
              型
              <Select
                className="mt-1 w-full"
                value={type}
                onChange={(e) => setType(e.target.value as ColumnType)}
              >
                {(Object.keys(TYPE_LABEL) as ColumnType[]).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </label>
            {canWeeklyReset && (
              <label className="flex items-start gap-2 text-[12px] text-[var(--ink2)]">
                <input
                  type="checkbox"
                  checked={!!column.config?.weekly_reset}
                  className="mt-0.5 h-4 w-4 accent-[var(--green)]"
                  onChange={(e) => weeklyResetMut.mutate(e.target.checked)}
                />
                <span>
                  週次リセット
                  <span className="block text-[11px] text-[var(--ink3)]">
                    毎週、未入力（空）から再入力。先週分は基準週を戻すと表示されます。
                  </span>
                </span>
              </label>
            )}
            {type === 'text' && (
              <label className="flex items-start gap-2 text-[12px] text-[var(--ink2)]">
                <input
                  type="checkbox"
                  checked={!!column.config?.multiline}
                  className="mt-0.5 h-4 w-4 accent-[var(--green)]"
                  onChange={(e) => multilineMut.mutate(e.target.checked)}
                />
                <span>
                  複数行入力（大規模入力）
                  <span className="block text-[11px] text-[var(--ink3)]">
                    セルをクリックすると広いテキストエリア（モーダル）で複数行入力できます。
                  </span>
                </span>
              </label>
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!dirty || meta.isPending}
                onClick={() => meta.mutate()}
              >
                変更を保存
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {column.type === 'dropdown' && (
        <DropdownOptionsEditor column={column} onDone={onDone} />
      )}
      {column.type === 'status' && (
        <StatusRuleBuilder column={column} columns={columns} onDone={onDone} />
      )}
      {column.type === 'lookup' && (
        <LookupConfigEditor column={column} sheetId={sheetId} onDone={onDone} />
      )}
    </>
  )
}

function SheetLevelSettings({
  sheetId,
  columns,
  hasWeekGrid,
  keyColumnId,
  colorBasisColumnId,
  settings,
}: {
  sheetId: string
  columns: Column[]
  hasWeekGrid: boolean
  keyColumnId: string | null
  colorBasisColumnId: string | null
  settings: SheetSettings
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (body: {
      key_column_id?: string | null
      color_basis_column_id?: string | null
      settings?: SheetSettings
    }) => api.updateSheet(sheetId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sheets'] })
      void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
    },
  })

  // Freezable = attribute columns + the 4 summary columns (予定計/実績計/差/進捗),
  // so the freeze can extend up to 進捗.
  const SUMMARY_LABELS = ['予定計', '実績計', '差', '進捗', '予実差']
  const pinned = settings.pinned_columns ?? 1
  const nCols = columns.length
  const freezeOptions = Array.from({ length: nCols + 1 + SUMMARY_LABELS.length }, (_, n) => {
    let label: string
    if (n === 0) label = 'ID のみ固定'
    else if (n <= nCols) label = `ID ＋ 先頭${n}列を固定`
    else label = `ID ＋ 全${nCols}列 ＋ ${SUMMARY_LABELS.slice(0, n - nCols).join('・')}`
    return (
      <option key={n} value={String(n)}>
        {label}
      </option>
    )
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>シート設定</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          {/* Frozen columns / filters / progress / color basis are schedule-only. */}
          {hasWeekGrid && (
            <>
          <label className="text-[12px] text-[var(--ink2)]">
            左端に固定する列
            <Select
              className="mt-1 w-full"
              value={String(pinned)}
              onChange={(e) =>
                mutation.mutate({
                  settings: { ...settings, pinned_columns: Number(e.target.value) },
                })
              }
            >
              {freezeOptions}
            </Select>
            <span className="mt-1 block text-[11px] text-[var(--ink3)]">
              通常時の固定列（IDは常に固定／進捗まで指定可）。
            </span>
          </label>
          <label className="text-[12px] text-[var(--ink2)]">
            左端に固定する列（最小化時）
            <Select
              className="mt-1 w-full"
              value={String(settings.pinned_columns_narrow ?? Math.min(1, pinned))}
              onChange={(e) =>
                mutation.mutate({
                  settings: { ...settings, pinned_columns_narrow: Number(e.target.value) },
                })
              }
            >
              {freezeOptions}
            </Select>
            <span className="mt-1 block text-[11px] text-[var(--ink3)]">
              「固定列: 通常／最小」ボタンで切替。
            </span>
          </label>

          <label className="text-[12px] text-[var(--ink2)]">
            マイルストン◇の表示
            <Select
              className="mt-1 w-full"
              value={settings.milestone_display ?? 'all'}
              onChange={(e) =>
                mutation.mutate({
                  settings: {
                    ...settings,
                    milestone_display: e.target.value as 'all' | 'none' | 'last',
                  },
                })
              }
            >
              <option value="all">すべて表示</option>
              <option value="last">最後のマイルストンのみ</option>
              <option value="none">非表示</option>
            </Select>
            <span className="mt-1 block text-[11px] text-[var(--ink3)]">
              ガントの◇（節目）の表示。シート共通で全員に反映されます。
            </span>
          </label>

          <label className="flex items-start gap-2 text-[12px] text-[var(--ink2)]">
            <input
              type="checkbox"
              checked={!!settings.progress_weekly_reset}
              className="mt-0.5 h-4 w-4 accent-[var(--green)]"
              onChange={(e) =>
                mutation.mutate({
                  settings: { ...settings, progress_weekly_reset: e.target.checked },
                })
              }
            />
            <span>
              進捗を週次リセット
              <span className="block text-[11px] text-[var(--ink3)]">
                毎週、進捗は未入力（—）から再入力。
              </span>
            </span>
          </label>

          <DoneFilterEditor
            columns={columns}
            settings={settings}
            onChange={(done_filter) => mutation.mutate({ settings: { ...settings, done_filter } })}
          />
            </>
          )}
          <label className="text-[12px] text-[var(--ink2)]">
            キー列（採番・参照キー）
            <Select
              className="mt-1 w-full"
              value={keyColumnId == null ? '' : String(keyColumnId)}
              onChange={(e) =>
                mutation.mutate({
                  key_column_id: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">（自動キー）</option>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          {hasWeekGrid && (
          <label className="text-[12px] text-[var(--ink2)]">
            色基準列（ガントのフェーズ色）
            <Select
              className="mt-1 w-full"
              value={colorBasisColumnId == null ? '' : String(colorBasisColumnId)}
              onChange={(e) =>
                mutation.mutate({
                  color_basis_column_id: e.target.value === '' ? null : e.target.value,
                })
              }
            >
              <option value="">（未設定）</option>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

/** Lets the admin define what counts as "完了" for the 完了を隠す toggle: a column
 *  and one or more values. Candidate values come from a dropdown's options or a
 *  status column's rule labels. Empty selection = fall back to status === '完了'. */
function DoneFilterEditor({
  columns,
  settings,
  onChange,
}: {
  columns: Column[]
  settings: SheetSettings
  onChange: (done_filter: { column_id: string; values: string[] } | undefined) => void
}) {
  // Only dropdown / status columns make sense as a completion basis.
  const candidates = columns.filter((c) => c.type === 'dropdown' || c.type === 'status')
  const current = settings.done_filter
  const colId = current?.column_id ?? ''
  const col = columns.find((c) => String(c.id) === String(colId))
  const values = current?.values ?? []

  const valueOptions: string[] =
    col?.type === 'dropdown'
      ? (col.config?.options ?? []).map((o) => o.value)
      : col?.type === 'status'
        ? (col.config?.rules ?? []).map((r) => r.label)
        : []

  function setColumn(id: string) {
    if (!id) return onChange(undefined)
    onChange({ column_id: id, values: [] })
  }
  function toggleValue(v: string) {
    const next = values.includes(v) ? values.filter((x) => x !== v) : [...values, v]
    onChange({ column_id: colId, values: next })
  }

  return (
    <div className="text-[12px] text-[var(--ink2)]">
      完了とみなす条件（「完了を隠す」の基準）
      <Select
        className="mt-1 w-full"
        value={colId}
        onChange={(e) => setColumn(e.target.value)}
      >
        <option value="">（既定：ステータス＝「完了」）</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      {col && (
        <div className="mt-2 flex flex-wrap gap-2">
          {valueOptions.length === 0 && (
            <span className="text-[11px] text-[var(--ink3)]">
              この列に選択肢/ルールがありません。
            </span>
          )}
          {valueOptions.map((v) => {
            const on = values.includes(v)
            return (
              <label
                key={v}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-[8px] border px-2 py-1 text-[12px]',
                  on
                    ? 'border-[var(--green)] bg-[var(--green-l)]/10'
                    : 'border-[var(--line)] hover:bg-[var(--line2)]',
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  className="h-3.5 w-3.5 accent-[var(--green)]"
                  onChange={() => toggleValue(v)}
                />
                {v}
              </label>
            )
          })}
        </div>
      )}
      <span className="mt-1 block text-[11px] text-[var(--ink3)]">
        指定した値の行を「完了」として隠せます（複数選択可）。未設定ならステータス＝「完了」。
      </span>
    </div>
  )
}

/** Editor for the sheet's default milestones (phases): name + color. These
 *  prefill a row's milestone editor and seed the gantt legend. */
function DefaultMilestonesEditor({
  sheetId,
  settings,
}: {
  sheetId: string
  settings: SheetSettings
}) {
  const qc = useQueryClient()
  const [items, setItems] = useState<DefaultMilestone[]>(
    () => settings.default_milestones ?? [],
  )

  const save = useMutation({
    mutationFn: () =>
      api.updateSheet(sheetId, {
        settings: {
          ...settings,
          default_milestones: items
            .map((m) => ({
              name: m.name.trim(),
              color: m.color,
              kind: m.kind === 'milestone' ? ('milestone' as const) : ('phase' as const),
              ...(m.kind === 'milestone' ? {} : { weight: m.weight ?? 1 }),
            }))
            .filter((m) => m.name !== ''),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sheets'] })
      void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
    },
  })

  const dirty =
    JSON.stringify(items) !== JSON.stringify(settings.default_milestones ?? [])

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setItems(next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>既定マイルストン（フェーズ・節目）</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-[12px] text-[var(--ink3)]">
          新しい行の初期値。フェーズ＝色付き区間、マイルストン＝◇の節目。各行で開始日・完了日を入れると、
          フェーズの「割合」に応じて間のマイルストン日付が自動配置されます。
        </p>
        <div className="flex flex-col gap-2">
          {items.length === 0 && (
            <div className="rounded-[10px] border border-dashed border-[var(--line)] px-3 py-3 text-center text-[12px] text-[var(--ink3)]">
              既定マイルストンが未設定です。下の「追加」で作成します。
            </div>
          )}
          {items.map((m, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-[10px] border border-[var(--line)] px-2.5 py-1.5"
            >
              <div className="flex flex-col">
                <button
                  title="上へ"
                  disabled={i === 0}
                  className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                  onClick={() => move(i, -1)}
                >
                  <ChevronUpIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  title="下へ"
                  disabled={i === items.length - 1}
                  className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                  onClick={() => move(i, 1)}
                >
                  <ChevronDownIcon className="h-3.5 w-3.5" />
                </button>
              </div>
              <Select
                className="w-[104px] flex-shrink-0"
                value={m.kind ?? 'phase'}
                onChange={(e) =>
                  setItems(
                    items.map((x, j) =>
                      j === i
                        ? { ...x, kind: e.target.value as DefaultMilestone['kind'] }
                        : x,
                    ),
                  )
                }
              >
                <option value="phase">フェーズ</option>
                <option value="milestone">マイルストン</option>
              </Select>
              {(m.kind ?? 'phase') === 'phase' ? (
                <input
                  type="color"
                  className="h-7 w-9 flex-shrink-0 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0.5"
                  value={m.color}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))
                  }
                  title="色を選択"
                />
              ) : (
                <span
                  className="h-[13px] w-[13px] flex-shrink-0 border-[1.6px] border-[var(--ink)] bg-white"
                  style={{ transform: 'rotate(45deg)' }}
                  title="マイルストン（◇の節目）"
                />
              )}
              <Input
                className="flex-1"
                placeholder={
                  (m.kind ?? 'phase') === 'phase'
                    ? 'フェーズ名（例: 設計）'
                    : 'マイルストン名（例: 確認）'
                }
                value={m.name}
                onChange={(e) =>
                  setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              {(m.kind ?? 'phase') === 'phase' && (
                <label
                  className="flex flex-shrink-0 items-center gap-1 text-[11px] text-[var(--ink3)]"
                  title="割合：各行の開始〜完了の間で、この区間が占める長さの比率"
                >
                  割合
                  <Input
                    type="number"
                    min={1}
                    className="w-[56px]"
                    value={String(m.weight ?? 1)}
                    onChange={(e) =>
                      setItems(
                        items.map((x, j) =>
                          j === i ? { ...x, weight: Number(e.target.value) || 1 } : x,
                        ),
                      )
                    }
                  />
                </label>
              )}
              <button
                className="rounded p-1 text-[var(--ink3)] hover:bg-[#FAE6E0] hover:text-[#A8442B]"
                title="削除"
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => setItems([...items, { name: '', color: '#a7d0be', kind: 'phase' }])}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            <PlusIcon className="h-[15px] w-[15px]" />
            フェーズを追加
          </button>
          <button
            onClick={() =>
              setItems([...items, { name: '', color: '#cfd8e6', kind: 'milestone' }])
            }
            className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
          >
            <PlusIcon className="h-[15px] w-[15px]" />
            マイルストンを追加
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            既定マイルストンを保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** Excel入出力（一覧の主画面から設定へ移設）。属性＋週次工数を .xlsx で
 *  出力／取込（取込は ID で照合して upsert、参照(LOOKUP)列は無視）。 */
function ExcelIOCard({ sheetId }: { sheetId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Excel入出力</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-[12px] text-[var(--ink3)]">
          このシートを Excel（.xlsx）で出力／取込します。取込は ID で照合し、一致する行は更新・無い行は新規追加します。
          属性列・週次工数に加え<b>進捗・先行タスク</b>、<b>既定マイルストン（テンプレ）の◇ごとの「予定／実績」列</b>も往復できます
          （開始日・完了日は通常の列として出力。フェーズの境界は開始日と◇から自動復元。先行タスクはID(key_value)で復元）。
          参照(LOOKUP)列は計算列のため取込対象外です。
        </p>
        <ExcelToolbar sheetId={sheetId} />
      </CardBody>
    </Card>
  )
}

function DangerZone({ sheetId, sheetName }: { sheetId: string; sheetName: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const clear = useMutation({
    mutationFn: () => api.clearSheetRows(sheetId),
    onSuccess: async (res) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['sheet', sheetId] }),
        qc.invalidateQueries({ queryKey: ['effort', sheetId] }),
        qc.invalidateQueries({ queryKey: ['sheet-milestones', sheetId] }),
        qc.invalidateQueries({ queryKey: ['snapshot', sheetId] }),
      ])
      toast.show(`データを削除しました（${res.deleted} 行）`, 'success')
    },
    onError: () => toast.show('データの削除に失敗しました', 'error'),
  })

  const del = useMutation({
    mutationFn: () => api.deleteSheet(sheetId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['sheets'] })
      navigate('/dashboard')
    },
  })

  return (
    <Card className="border-[#E7C7BC]">
      <CardHeader>
        <CardTitle>データ管理（要注意）</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          {/* Clear rows only — keeps columns / settings. For repeated import tests. */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-[var(--ink2)]">
              このシートのデータ（行・工数・マイルストン）をすべて削除し、
              <b>列定義とシート設定は残します</b>。インポートのやり直し用（採番は1から）。
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={clear.isPending}
              className="flex-shrink-0 border-[#E1A18C] text-[#A8442B] hover:bg-[#FAE6E0]"
              onClick={() => {
                if (
                  confirm(
                    `シート「${sheetName}」のデータをすべて削除しますか？（列・設定は残ります）この操作は取り消せません。`,
                  )
                )
                  clear.mutate()
              }}
            >
              <TrashIcon className="h-[15px] w-[15px]" />
              データを空にする
            </Button>
          </div>

          <div className="border-t border-[var(--line2)]" />

          {/* Delete the whole sheet. */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-[var(--ink2)]">
              このシートと行・工数・マイルストンをすべて削除します。元に戻せません。
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={del.isPending}
              className="flex-shrink-0 border-[#E1A18C] text-[#A8442B] hover:bg-[#FAE6E0]"
              onClick={() => {
                if (
                  confirm(
                    `シート「${sheetName}」を削除しますか？この操作は取り消せません。`,
                  )
                )
                  del.mutate()
              }}
            >
              <TrashIcon className="h-[15px] w-[15px]" />
              シート削除
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
