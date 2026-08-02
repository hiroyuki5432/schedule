// Attribute-column widths, shared by the schedule grid and the table view.
//
// A column's width is, in order of precedence:
//   1. a manual override (drag the header edge) — persisted in localStorage,
//   2. a content fit measured from the header + the longest cell value,
//   3. a per-type fallback.
//
// Overrides are keyed by column id (a globally unique DB pk), so one map covers
// every sheet AND both views: resize 「担当」 in the schedule and the table shows
// the same width (要望: Excelのように変えて固定したい).

import { useCallback, useEffect, useState } from 'react'
import type { Column } from '@/types/api'

// Manual drag limits. The minimum is deliberately far below "the text still
// fits": squeezing a column down to a sliver is a normal way to park a column you
// do not need right now without hiding it (要望: 文字が見えるところまでしか縮められない).
// Values just clip — the full text stays in the cell's tooltip.
export const RESIZE_MIN = 24
export const RESIZE_MAX = 640

/** Hard ceiling for any CONTENT-fit width. One very long value must not be able
 *  to push a column out to the horizon (要望: 幅が永遠に広がる) — past this it is
 *  clipped, and the full value is on hover / in the record modal. */
export const FIT_MAX = 320

const COLW_KEY = 'gantt.colWidths'

/** Width-map key for the ID (key_value) column.
 *
 *  The ID column is not a `Column` row in the DB, so it used to be a hard-coded
 *  constant with no drag handle — which is why *some* columns could be squeezed
 *  and this one could not (要望: 縮められない列がある). Giving it a key in the same
 *  map makes it behave like every other column, and the width persists and is
 *  shared between the schedule and the table just like the rest. */
export const ID_COL_KEY = '__id__'

/** Fallback width by type, used before content is measured. */
export function defaultColWidth(c: Column): number {
  switch (c.type) {
    case 'status':
      return 96
    case 'member':
      return 124
    case 'date':
      return 116
    case 'number':
      return 96
    case 'text':
      return 176
    case 'lookup':
    case 'formula':
      return 150
    default:
      return 128
  }
}

/** [min, max] clamp per column type — keeps content-fit from running too wide. */
export function widthRange(t: Column['type']): [number, number] {
  switch (t) {
    case 'status':
      return [72, 140]
    case 'member':
      return [92, 150]
    case 'date':
      return [96, 124]
    case 'number':
      return [60, 110]
    case 'text':
      return [96, 240]
    case 'lookup':
    case 'formula':
      return [96, 200]
    default:
      return [80, 150]
  }
}

/** Rough text width: CJK ~9px, other ~6px per char (for content-fit columns). */
export function textPx(s: string): number {
  let px = 0
  for (const ch of s) px += ch.charCodeAt(0) > 0x2e7f ? 9 : 6
  return px
}

/** Padding a column needs on top of its widest text, by type. */
export function widthPad(t: Column['type']): number {
  if (t === 'member') return 54
  if (t === 'status' || t === 'dropdown') return 34
  return 24
}

/** Content-fit width for one column from its header + every rendered value.
 *
 *  Multi-line values are measured by their LONGEST LINE, not the whole string:
 *  an imported 備考 with three lines wraps in the cell, so sizing it to the joined
 *  length would make the column absurdly wide for no reason. */
export function fitWidth(c: Column, values: Iterable<string>): number {
  let maxPx = textPx(c.name)
  for (const v of values) {
    for (const line of v.split('\n')) maxPx = Math.max(maxPx, textPx(line))
  }
  const [min, max] = widthRange(c.type)
  return Math.round(Math.max(min, Math.min(max, FIT_MAX, widthPad(c.type) + maxPx)))
}

function loadColWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLW_KEY)
    const obj = raw ? JSON.parse(raw) : null
    return obj && typeof obj === 'object' ? (obj as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Manual width overrides + a mouse-drag resize handler for header edges. */
export function useColumnWidths() {
  const [colW, setColW] = useState<Record<string, number>>(loadColWidths)

  useEffect(() => {
    try {
      localStorage.setItem(COLW_KEY, JSON.stringify(colW))
    } catch {
      /* storage full / unavailable — overrides just won't persist */
    }
  }, [colW])

  // The move/up handlers are defined locally so removeEventListener gets the
  // same references back.
  const startResize = useCallback(
    (e: React.MouseEvent, colId: string, startW: number) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const move = (ev: MouseEvent) => {
        const next = Math.max(RESIZE_MIN, Math.min(RESIZE_MAX, startW + (ev.clientX - startX)))
        setColW((prev) => ({ ...prev, [colId]: next }))
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [],
  )

  /** Drop a column's override so it returns to the auto (content) fit. */
  const resetWidth = useCallback((colId: string) => {
    setColW((prev) => {
      if (!(colId in prev)) return prev
      const next = { ...prev }
      delete next[colId]
      return next
    })
  }, [])

  return { colW, startResize, resetWidth }
}
