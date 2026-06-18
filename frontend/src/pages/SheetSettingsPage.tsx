import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useSheets, useColumns } from '@/hooks/useSheets'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Badge } from '@/components/ui/Badge'
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from '@/components/ui/icons'
import { DropdownOptionsEditor } from '@/components/settings/DropdownOptionsEditor'
import { StatusRuleBuilder } from '@/components/settings/StatusRuleBuilder'
import { LookupConfigEditor } from '@/components/settings/LookupConfigEditor'
import { PlusIcon } from '@/components/ui/icons'
import type { Column, ColumnType, DefaultMilestone, SheetSettings } from '@/types/api'

const TYPE_LABEL: Record<ColumnType, string> = {
  text: '自由入力',
  number: '数値',
  date: '日付',
  dropdown: 'プルダウン',
  status: '条件付きステータス',
  member: 'メンバー',
  lookup: '参照(XLOOKUP)',
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

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['columns', sheetId] })
    void qc.invalidateQueries({ queryKey: ['sheet', sheetId] })
  }

  // Reorder a column up/down by swapping its `order` with its neighbor's
  // (Feature 2). Persisted via PATCH /api/columns/{id}. Falls back to index-based
  // order values when neighbors happen to share the same order.
  const reorder = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const j = index + dir
      if (j < 0 || j >= columns.length) return
      const a = columns[index]
      const b = columns[j]
      // Distinct target orders even if a.order === b.order in the current data.
      const orderA = a.order !== b.order ? b.order : j
      const orderB = a.order !== b.order ? a.order : index
      await Promise.all([
        api.updateColumn(a.id, { order: orderA }),
        api.updateColumn(b.id, { order: orderB }),
      ])
    },
    onSuccess: invalidate,
  })

  if (!sheetId) {
    return <PageHeader title="シート設定" subtitle="シートが選択されていません。" />
  }

  return (
    <>
      <PageHeader
        title="シート設定"
        subtitle={`列定義・型・採番・色基準（${sheet?.name ?? '—'}）`}
      />

      <div className="grid grid-cols-1 gap-4 overflow-auto px-[22px] pb-6 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>列一覧</CardTitle>
            </CardHeader>
            <CardBody className="px-0 py-0">
              {columnsQ.isLoading ? (
                <div className="px-5 py-4 text-[var(--ink3)]">読み込み中…</div>
              ) : (
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
                        onClick={() => setSelectedId(c.id)}
                        className={
                          'cursor-pointer border-b border-[var(--line2)] hover:bg-[#FCFBF7]' +
                          (String(c.id) === String(selectedId) ? ' bg-[#FCFBF7]' : '')
                        }
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col">
                            <button
                              title="上へ"
                              disabled={i === 0 || reorder.isPending}
                              className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                              onClick={(e) => {
                                e.stopPropagation()
                                reorder.mutate({ index: i, dir: -1 })
                              }}
                            >
                              <ChevronUpIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              title="下へ"
                              disabled={i === columns.length - 1 || reorder.isPending}
                              className="text-[var(--ink3)] hover:text-[var(--ink)] disabled:opacity-30"
                              onClick={(e) => {
                                e.stopPropagation()
                                reorder.mutate({ index: i, dir: 1 })
                              }}
                            >
                              <ChevronDownIcon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                        <td className="px-5 py-2.5">{c.name}</td>
                        <td className="px-5 py-2.5 text-[var(--ink2)]">
                          {TYPE_LABEL[c.type]}
                        </td>
                        <td className="px-5 py-2.5">
                          {c.is_key && (
                            <Badge bg="#E3EFEA" color="#266B53">
                              キー
                            </Badge>
                          )}
                        </td>
                        <td className="px-5 py-2.5 text-right">
                          <DeleteColumnButton columnId={c.id} onDone={invalidate} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <AddColumnForm sheetId={sheetId} onDone={invalidate} />

          {sheet && (
            <SheetLevelSettings
              sheetId={sheetId}
              columns={columns}
              keyColumnId={sheet.key_column_id}
              colorBasisColumnId={sheet.color_basis_column_id}
              settings={sheet.settings ?? {}}
            />
          )}

          {sheet && (
            <DefaultMilestonesEditor sheetId={sheetId} settings={sheet.settings ?? {}} />
          )}

          {sheet && <DangerZone sheetId={sheetId} sheetName={sheet.name} />}
        </div>

        <div className="flex flex-col gap-4">
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
              <CardBody className="text-[var(--ink3)]">
                左の一覧から列を選択すると、名前・型・型別の設定を編集できます。
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
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

function AddColumnForm({ sheetId, onDone }: { sheetId: string; onDone: () => void }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ColumnType>('text')

  const mutation = useMutation({
    mutationFn: () => api.createColumn(sheetId, { name: name.trim(), type }),
    onSuccess: () => {
      setName('')
      onDone()
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>列を追加</CardTitle>
      </CardHeader>
      <CardBody>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) mutation.mutate()
          }}
        >
          <Input
            placeholder="列名"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
            追加
          </Button>
        </form>
      </CardBody>
    </Card>
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
    onSuccess: onDone,
  })

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
  keyColumnId,
  colorBasisColumnId,
  settings,
}: {
  sheetId: string
  columns: Column[]
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

  const pinned = settings.pinned_columns ?? 1
  const pinnedNarrow = settings.pinned_columns_narrow ?? Math.min(1, pinned)
  const freezeOptions = Array.from({ length: columns.length + 1 }, (_, n) => (
    <option key={n} value={String(n)}>
      {n === 0 ? 'ID のみ固定' : `ID ＋ 先頭${n}列を固定`}
    </option>
  ))

  return (
    <Card>
      <CardHeader>
        <CardTitle>シート設定</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          <label className="text-[12px] text-[var(--ink2)]">
            左端に固定する列数（通常）
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
          </label>
          <label className="text-[12px] text-[var(--ink2)]">
            左端に固定する列数（最小化時）
            <Select
              className="mt-1 w-full"
              value={String(pinnedNarrow)}
              onChange={(e) =>
                mutation.mutate({
                  settings: { ...settings, pinned_columns_narrow: Number(e.target.value) },
                })
              }
            >
              {freezeOptions}
            </Select>
            <span className="mt-1 block text-[11px] text-[var(--ink3)]">
              スケジュール画面の「固定列: 通常／最小」ボタンで、この2つの固定列数を切り替えられます。狭い画面で表が見えない時は「最小」に。
            </span>
          </label>
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
        </div>
      </CardBody>
    </Card>
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
            .map((m) => ({ name: m.name.trim(), color: m.color }))
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
        <CardTitle>既定マイルストン（フェーズ）</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-[12px] text-[var(--ink2)]">
          新しい行のフェーズの初期値・色になります（各行の◇から個別に変更可）。凡例にも表示されます。
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
              <input
                type="color"
                className="h-7 w-9 flex-shrink-0 cursor-pointer rounded border border-[var(--line)] bg-transparent p-0.5"
                value={m.color}
                onChange={(e) =>
                  setItems(items.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))
                }
                title="色を選択"
              />
              <Input
                className="flex-1"
                placeholder="フェーズ名（例: 設計）"
                value={m.name}
                onChange={(e) =>
                  setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
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
        <button
          onClick={() => setItems([...items, { name: '', color: '#a7d0be' }])}
          className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[var(--line)] py-2 text-[12.5px] text-[var(--ink2)] hover:bg-[var(--line2)]"
        >
          <PlusIcon className="h-[15px] w-[15px]" />
          フェーズを追加
        </button>
        <div className="mt-3 flex justify-end">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            既定マイルストンを保存
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

function DangerZone({ sheetId, sheetName }: { sheetId: string; sheetName: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()

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
        <CardTitle>シートを削除</CardTitle>
      </CardHeader>
      <CardBody>
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
            削除
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
