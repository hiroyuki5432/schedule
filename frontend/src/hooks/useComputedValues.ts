// 計算列（参照(LOOKUP)／数式）の値を出す resolver を返す。参照先シートは
// ここでまとめて取ってくる。
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import * as api from '@/api/client'
import { makeComputedResolver } from '@/lib/computed'
import { lookupTargetSheetIds } from '@/lib/lookup'
import type { TargetSheets } from '@/lib/lookup'
import type { Column, Member, SheetDetail } from '@/types/api'

export function useComputedValues(columns: Column[], members: Member[] = []) {
  const targetIds = useMemo(() => lookupTargetSheetIds(columns), [columns])

  const queries = useQueries({
    queries: targetIds.map((id) => ({
      queryKey: ['sheet', id],
      queryFn: () => api.getSheet(id),
    })),
  })

  const targets: TargetSheets = useMemo(() => {
    const map: TargetSheets = {}
    targetIds.forEach((id, i) => {
      map[id] = queries[i]?.data as SheetDetail | undefined
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIds, queries.map((q) => q.dataUpdatedAt).join(',')])

  // 列の「中身」が変わったときだけ resolver を作り直す。呼び出し側が毎レンダー
  // 新しい配列を渡してくることがあり、参照で比較すると resolver が毎回変わって、
  // これに依存する列幅・並べ替えの useMemo まで丸ごと再計算されてしまう。
  const signature = columns
    .map((c) => `${c.id}:${c.type}:${c.name}:${JSON.stringify(c.config ?? {})}`)
    .join('|')

  const computedValue = useMemo(
    () => makeComputedResolver(columns, targets, members),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature, targets, members],
  )

  return { computedValue }
}
