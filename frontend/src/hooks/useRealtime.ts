// リアルタイム更新（要望: Excel 365 の共同編集のように、他の人の更新がすぐ見えてほしい）。
//
// サーバの GET /api/events（Server-Sent Events）から「どのシートが変わったか」を
// 受け取り、そのシートを表示している画面のデータを React Query で読み直す。値は
// 通知に載っていない — 読み直しはいつもの API を通るので、権限の確認もいつもどおり。
//
// 細かい決めごと:
//  * 自分の画面（同じタブ）の変更は読み直さない — 保存した側がもう読み直している。
//    他のタブ・他の人の変更だけを拾う（lib/clientId）。
//  * 通知は 300ms まとめてから読み直す。連続入力で毎回全行を取り直さないため。
//  * タブが裏に回ったら接続を閉じる。http（HTTP/1.1）ではブラウザが1つのサーバへ同時に
//    張れる接続が6本しかなく、SSE はその1本を占有し続ける。タブを何枚も開くと、
//    普通の API 呼び出しが詰まってしまう。表に戻ったら、つなぎ直して全部読み直す
//    （裏にいた間の変更を取りこぼさないように）。
//  * 切れたらブラウザが自動でつなぎ直す。つなぎ直したときも全部読み直す。

import { useEffect, useSyncExternalStore } from 'react'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { CLIENT_ID } from '@/lib/clientId'

export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'paused' | 'off'

interface StatusSnapshot {
  state: RealtimeState
  /** 最後に他の人（他の画面）の変更を反映した時刻（ms）。 */
  lastRemoteAt: number | null
}

// ---- 接続状態（サイドバーの表示用）。モジュールに1つだけ持つ。 ----
let status: StatusSnapshot = { state: 'off', lastRemoteAt: null }
const listeners = new Set<() => void>()
function setStatus(next: Partial<StatusSnapshot>) {
  status = { ...status, ...next }
  for (const l of listeners) l()
}

export function useRealtimeStatus(): StatusSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => status,
  )
}

interface ChangeMsg {
  /** シートID（日報など、シートに属さない変更では無い）。 */
  s?: number
  /** 変わったテーブル。'resync' は「全部読み直して」。 */
  t?: string
  /** 変えた人（ユーザーID）。 */
  u?: string
  /** 変えた画面（X-Client-Id）。 */
  c?: string
}

/** 画面の入力に使う「解析の途中結果」などは読み直さない（読み直す意味が無く、重い）。 */
const NEVER_REFETCH = new Set([
  'worklog-inspect',
  'worklog-check',
  'workbook-inspect',
  'server-version',
  'maintenance-usage',
  'backups',
])

/** シートに関係なく、どこかが変われば読み直すもの。 */
const GLOBAL_KEYS: QueryKey[] = [['my-tasks'], ['search']]

function invalidate(qc: QueryClient, sheets: Set<string>, kinds: Set<string>, all: boolean) {
  if (all) {
    void qc.invalidateQueries({
      predicate: (q) => !NEVER_REFETCH.has(String(q.queryKey[0])),
    })
    return
  }
  if (sheets.size > 0) {
    void qc.invalidateQueries({
      predicate: (q) =>
        !NEVER_REFETCH.has(String(q.queryKey[0])) &&
        q.queryKey.length > 1 &&
        sheets.has(String(q.queryKey[1])),
    })
  }
  if (kinds.has('sheets')) void qc.invalidateQueries({ queryKey: ['sheets'] })
  if (kinds.has('row_milestones')) void qc.invalidateQueries({ queryKey: ['milestones'] })
  if (kinds.has('work_logs')) {
    // 日報は実績工数（全シート）と集計に効く。
    for (const k of ['worklogs', 'all-worklog', 'effort', 'aggregate', 'sheet'])
      void qc.invalidateQueries({ queryKey: [k] })
  }
  for (const k of GLOBAL_KEYS) void qc.invalidateQueries({ queryKey: k })
}

/** ログイン中の画面に1回だけ置く（AppLayout）。 */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient()

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setStatus({ state: 'off' })
      return
    }
    let es: EventSource | null = null
    let everOpened = false
    let timer: number | undefined
    const pendingSheets = new Set<string>()
    const pendingKinds = new Set<string>()
    let pendingAll = false

    const flush = () => {
      timer = undefined
      invalidate(qc, pendingSheets, pendingKinds, pendingAll)
      pendingSheets.clear()
      pendingKinds.clear()
      pendingAll = false
    }
    const schedule = () => {
      if (timer === undefined) timer = window.setTimeout(flush, 300)
    }

    const open = () => {
      if (es) return
      setStatus({ state: everOpened ? 'reconnecting' : 'connecting' })
      es = new EventSource('/api/events', { withCredentials: true })
      es.onopen = () => {
        // つなぎ直し（タブを表に戻した・切れて自動で戻った）なら、その間の変更を
        // 取りこぼしているかもしれないので全部読み直す。
        if (everOpened) {
          pendingAll = true
          schedule()
        }
        everOpened = true
        setStatus({ state: 'live' })
      }
      es.onerror = () => {
        // ブラウザが自動でつなぎ直す（サーバが retry: 3000 を指定）。
        setStatus({ state: 'reconnecting' })
      }
      es.onmessage = (ev) => {
        let msg: ChangeMsg
        try {
          msg = JSON.parse(ev.data) as ChangeMsg
        } catch {
          return
        }
        if (msg.t === 'resync') {
          pendingAll = true
          schedule()
          return
        }
        if (msg.c && msg.c === CLIENT_ID) return // 自分の画面の変更
        if (msg.s != null) pendingSheets.add(String(msg.s))
        if (msg.t) pendingKinds.add(msg.t)
        setStatus({ lastRemoteAt: Date.now() })
        schedule()
      }
    }
    const close = () => {
      es?.close()
      es = null
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        close()
        setStatus({ state: 'paused' })
      } else {
        open()
      }
    }

    if (document.visibilityState !== 'hidden') open()
    else setStatus({ state: 'paused' })
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearTimeout(timer)
      close()
      setStatus({ state: 'off' })
    }
  }, [enabled, qc])
}
