// Editor for a lookup column's config (XLOOKUP-style):
//   { target_sheet_id, local_key_column_id, match_key_column_id, return_column_id }
// Four selectors: target sheet / this sheet's key (default ID) / target match
// column (default ID) / target return column. Each key/match/return lists ID
// first, then the relevant sheet's columns.
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { useSheets, useColumns } from '@/hooks/useSheets'
import { ID_KEY } from '@/lib/lookup'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import type { Column } from '@/types/api'

export function LookupConfigEditor({
  column,
  sheetId,
  onDone,
}: {
  column: Column
  sheetId: string
  onDone: () => void
}) {
  const sheetsQ = useSheets()
  const otherSheets = (sheetsQ.data ?? []).filter((s) => String(s.id) !== String(sheetId))

  // This sheet's own columns (for the local-key selector).
  const localColsQ = useColumns(sheetId)
  const localCols = localColsQ.data ?? []

  const [targetSheetId, setTargetSheetId] = useState<string>(
    column.config?.target_sheet_id != null ? String(column.config.target_sheet_id) : '',
  )
  // Backward compat: if local_key is absent on old data, default to "__id__".
  const [localKeyColId, setLocalKeyColId] = useState<string>(
    column.config?.local_key_column_id != null
      ? String(column.config.local_key_column_id)
      : ID_KEY,
  )
  const [matchColId, setMatchColId] = useState<string>(
    column.config?.match_key_column_id != null
      ? String(column.config.match_key_column_id)
      : ID_KEY,
  )
  const [returnColId, setReturnColId] = useState<string>(
    column.config?.return_column_id != null ? String(column.config.return_column_id) : '',
  )

  const targetColsQ = useQuery({
    queryKey: ['columns', targetSheetId],
    queryFn: () => api.getColumns(targetSheetId),
    enabled: !!targetSheetId,
  })
  const targetCols = targetColsQ.data ?? []

  // Reset target column pickers when the target sheet is cleared.
  useEffect(() => {
    if (!targetSheetId) {
      setMatchColId(ID_KEY)
      setReturnColId('')
    }
  }, [targetSheetId])

  const mutation = useMutation({
    mutationFn: () =>
      api.updateColumn(column.id, {
        config: {
          ...column.config,
          target_sheet_id: targetSheetId || undefined,
          local_key_column_id: localKeyColId || ID_KEY,
          match_key_column_id: matchColId || ID_KEY,
          return_column_id: returnColId || undefined,
        },
      }),
    onSuccess: onDone,
  })

  const sorted = (cols: Column[]) => [...cols].sort((a, b) => a.order - b.order)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{column.name} — 参照設定（XLOOKUP）</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          <label className="text-[12px] text-[var(--ink2)]">
            対象シート
            <Select
              className="mt-1 w-full"
              value={targetSheetId}
              onChange={(e) => setTargetSheetId(e.target.value)}
            >
              <option value="">（未選択）</option>
              {otherSheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="text-[12px] text-[var(--ink2)]">
            このシートのキー（既定: ID）
            <Select
              className="mt-1 w-full"
              value={localKeyColId}
              onChange={(e) => setLocalKeyColId(e.target.value)}
            >
              <option value={ID_KEY}>ID（行のキー値）</option>
              {sorted(localCols).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="text-[12px] text-[var(--ink2)]">
            照合する対象列（既定: ID）
            <Select
              className="mt-1 w-full"
              value={matchColId}
              onChange={(e) => setMatchColId(e.target.value)}
              disabled={!targetSheetId}
            >
              <option value={ID_KEY}>ID（対象行のキー値）</option>
              {sorted(targetCols).map((c: Column) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="text-[12px] text-[var(--ink2)]">
            取得する対象列
            <Select
              className="mt-1 w-full"
              value={returnColId}
              onChange={(e) => setReturnColId(e.target.value)}
              disabled={!targetSheetId}
            >
              <option value="">（先頭の列）</option>
              <option value={ID_KEY}>ID（対象行のキー値）</option>
              {sorted(targetCols).map((c: Column) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>

          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !targetSheetId}
            >
              保存
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
