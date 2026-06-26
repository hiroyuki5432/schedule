// Small localStorage-backed useState so a view's settings survive reloads and
// navigation (要望: 前回の表示から開始). When `key` is null nothing persists and it
// behaves like a plain useState(initial).
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

export function usePersistentState<T>(
  key: string | null,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(key, initial))

  // If the key changes (e.g. switching sheets without unmount), reload its value.
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current !== key) {
      lastKey.current = key
      setValue(read(key, initial))
    }
    // initial is intentionally not a dependency (read only when the key changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (!key) return
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* storage full / unavailable — ignore */
    }
  }, [key, value])

  return [value, setValue]
}

function read<T>(key: string | null, initial: T): T {
  if (!key) return initial
  try {
    const raw = localStorage.getItem(key)
    return raw != null ? (JSON.parse(raw) as T) : initial
  } catch {
    return initial
  }
}

// --- Last opened sheet (root redirect resumes here) -------------------------
const LAST_SHEET_KEY = 'view:lastSheetId'

export function rememberLastSheet(id: string): void {
  try {
    localStorage.setItem(LAST_SHEET_KEY, id)
  } catch {
    /* ignore */
  }
}

export function getLastSheet(): string | null {
  try {
    return localStorage.getItem(LAST_SHEET_KEY)
  } catch {
    return null
  }
}
