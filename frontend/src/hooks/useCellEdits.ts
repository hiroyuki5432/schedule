// 範囲の書き込み（貼り付け・まとめて消去・フィル・その取り消し）を1回の API にまとめる。
// テーブル型シートとスケジュールの両方で使う。
//
// 画面はすぐ書き換える（数百セルの貼り付けでも待たせない）。失敗したら読み直して
// 元の値に戻し、そう伝える。

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'
import { ID_CELL } from '@/lib/cellRange'
import { toast } from '@/lib/toast'
import type { CellEdit } from '@/hooks/useCellRange'
import type { CellValue, SheetDetail } from '@/types/api'

export type EditSide = 'after' | 'before'

/** 行ごとにまとめた書き込み。ID は key_value、それ以外は data の差分。 */
export function groupEdits(
  edits: CellEdit[],
  side: EditSide,
  extra?: (rowId: string, colKey: string, value: CellValue) => Record<string, CellValue>,
): Array<{ id: string; data: Record<string, CellValue>; key_value?: string }> {
  const byRow = new Map<string, { id: string; data: Record<string, CellValue>; key_value?: string }>()
  for (const e of edits) {
    const v = side === 'after' ? e.after : e.before
    const item = byRow.get(e.rowId) ?? { id: e.rowId, data: {} }
    if (e.colKey === ID_CELL) {
      // ID は空にできない（空は「変えない」の意味になる）ので、文字のときだけ。
      if (typeof v === 'string' && v.trim() !== '') item.key_value = v.trim()
    } else {
      item.data[e.colKey] = v
      if (extra) Object.assign(item.data, extra(e.rowId, e.colKey, v))
    }
    byRow.set(e.rowId, item)
  }
  return [...byRow.values()].filter((x) => x.key_value !== undefined || Object.keys(x.data).length > 0)
}

export function useApplyCellEdits(
  sheetId: string,
  extra?: (rowId: string, colKey: string, value: CellValue) => Record<string, CellValue>,
) {
  const qc = useQueryClient()
  return useCallback(
    async (edits: CellEdit[], side: EditSide): Promise<boolean> => {
      const items = groupEdits(edits, side, extra)
      if (items.length === 0) return true
      const key = ['sheet', sheetId]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SheetDetail>(key)
      if (prev) {
        const byId = new Map(items.map((i) => [String(i.id), i]))
        qc.setQueryData<SheetDetail>(key, {
          ...prev,
          rows: prev.rows.map((r) => {
            const it = byId.get(String(r.id))
            if (!it) return r
            return {
              ...r,
              data: { ...r.data, ...it.data },
              ...(it.key_value !== undefined ? { key_value: it.key_value } : {}),
            }
          }),
        })
      }
      try {
        await api.bulkUpdateRows(items)
        return true
      } catch (e) {
        if (prev) qc.setQueryData(key, prev)
        toast.show(
          `まとめて保存できませんでした：${e instanceof Error ? e.message : '通信状況を確認してください'}`,
          'error',
        )
        return false
      } finally {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
    [qc, sheetId, extra],
  )
}
