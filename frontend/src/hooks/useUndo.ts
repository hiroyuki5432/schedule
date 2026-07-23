// Undo / redo stack for grid edits (Ctrl+Z / Ctrl+Y).
//
// Entries are plain DATA, never closures over row objects: applying an undo
// minutes later must use the row's CURRENT version, or the optimistic lock
// rejects it. The caller supplies an `apply` that resolves rows at call time.

import { useCallback, useEffect, useRef, useState } from 'react'

export type UndoDirection = 'undo' | 'redo'

export interface UndoEntryBase {
  /** Shown in the toast: 「担当 を元に戻しました」. */
  label: string
}

export interface UndoApi<E extends UndoEntryBase> {
  push: (entry: E) => void
  undo: () => E | null
  redo: () => E | null
  clear: () => void
  canUndo: boolean
  canRedo: boolean
}

/**
 * @param apply    Performs the entry in the given direction ('undo' restores the
 *                 previous value, 'redo' re-applies the new one).
 * @param resetKey Clearing key — the stack empties when it changes (e.g. moving
 *                 to another sheet, where the recorded row ids no longer apply).
 */
export function useUndo<E extends UndoEntryBase>(
  apply: (entry: E, dir: UndoDirection) => void,
  resetKey?: string,
  limit = 100,
): UndoApi<E> {
  const undoRef = useRef<E[]>([])
  const redoRef = useRef<E[]>([])
  // Depth counters exist purely so toolbar buttons re-render when they change.
  const [depths, setDepths] = useState({ u: 0, r: 0 })

  // Keep the latest `apply` without making the callbacks change identity.
  const applyRef = useRef(apply)
  applyRef.current = apply

  const sync = useCallback(() => {
    setDepths({ u: undoRef.current.length, r: redoRef.current.length })
  }, [])

  const clear = useCallback(() => {
    undoRef.current = []
    redoRef.current = []
    sync()
  }, [sync])

  useEffect(() => {
    clear()
  }, [resetKey, clear])

  const push = useCallback(
    (entry: E) => {
      undoRef.current = [...undoRef.current, entry].slice(-limit)
      // A fresh edit invalidates the redo branch, as in every editor.
      redoRef.current = []
      sync()
    },
    [limit, sync],
  )

  const undo = useCallback(() => {
    const entry = undoRef.current[undoRef.current.length - 1]
    if (!entry) return null
    undoRef.current = undoRef.current.slice(0, -1)
    redoRef.current = [...redoRef.current, entry]
    sync()
    applyRef.current(entry, 'undo')
    return entry
  }, [sync])

  const redo = useCallback(() => {
    const entry = redoRef.current[redoRef.current.length - 1]
    if (!entry) return null
    redoRef.current = redoRef.current.slice(0, -1)
    undoRef.current = [...undoRef.current, entry]
    sync()
    applyRef.current(entry, 'redo')
    return entry
  }, [sync])

  return { push, undo, redo, clear, canUndo: depths.u > 0, canRedo: depths.r > 0 }
}

/**
 * Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) at the window level.
 *
 * Skipped while a text field has focus so the browser's own text undo keeps
 * working inside a cell editor.
 */
export function useUndoHotkeys(onUndo: () => void, onRedo: () => void) {
  useEffect(() => {
    const isTextField = (el: EventTarget | null) => {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName
      return (
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
      )
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      if (isTextField(e.target)) return
      e.preventDefault()
      if (k === 'y' || e.shiftKey) onRedo()
      else onUndo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onUndo, onRedo])
}
