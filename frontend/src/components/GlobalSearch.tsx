// Cross-sheet task search — answers 「P26-001 ってどのシートだっけ」.
//
// Opens with Ctrl+K (or the button in the sidebar). Picking a result navigates
// to that sheet with ?focus=<rowId>, which the schedule already understands:
// it scrolls the task into view and flashes it.

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { SearchIcon } from '@/components/ui/icons'
import { cn } from '@/lib/format'
import type { SearchHit } from '@/types/api'

/** Wait this long after the last keystroke before querying the server. */
const DEBOUNCE_MS = 200

export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [text])

  const q = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.searchRows(query),
    enabled: query.length > 0,
    staleTime: 10_000,
  })

  const hits = q.data ?? []
  useEffect(() => {
    setActive(0)
  }, [query])

  function open(hit: SearchHit) {
    onClose()
    // The nonce makes re-picking the same task flash it again.
    navigate(`/sheets/${hit.sheet_id}?focus=${hit.row_id}&t=${Date.now()}`)
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[620px] max-w-full overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--surface)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-3.5 py-3">
          <SearchIcon className="h-[16px] w-[16px] flex-shrink-0 text-[var(--ink3)]" />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(hits.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter' && hits[active]) {
                e.preventDefault()
                open(hits[active])
              }
            }}
            placeholder="すべてのシートから探す（ID・件名・担当など）"
            className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--ink3)]"
          />
          <kbd className="flex-shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--ink3)]">
            Esc
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-auto">
          {query === '' ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-[var(--ink3)]">
              探したいことばを入力してください。タスクIDの一部でも見つかります。
            </p>
          ) : q.isLoading ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-[var(--ink3)]">検索中…</p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-[var(--ink3)]">
              「{query}」に一致するタスクは見つかりませんでした。
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={`${hit.sheet_id}:${hit.row_id}`}
                onClick={() => open(hit)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  'flex w-full items-center gap-3 border-b border-[var(--line2)] px-4 py-2.5 text-left',
                  i === active ? 'bg-[var(--green-l)]/15' : 'hover:bg-[var(--line2)]',
                )}
              >
                <span className="w-[120px] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-semibold">
                  {hit.key_value || '(IDなし)'}
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px]">
                  {hit.title || <span className="text-[var(--ink3)]">（件名なし）</span>}
                  {hit.matched_field && hit.matched_field !== 'ID' && (
                    <span className="ml-2 text-[11px] text-[var(--ink3)]">
                      {hit.matched_field} が一致
                    </span>
                  )}
                </span>
                <span className="flex-shrink-0 rounded bg-[var(--line2)] px-1.5 py-0.5 text-[10.5px] text-[var(--ink3)]">
                  {hit.sheet_name}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--ink3)]">
          ↑↓ で選択・Enter で開く（該当タスクまでスクロールして光ります）
        </div>
      </div>
    </div>
  )
}

/** Ctrl+K / Cmd+K anywhere in the app. */
export function useGlobalSearchHotkey(onOpen: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpen])
}
