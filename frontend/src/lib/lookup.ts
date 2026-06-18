// Lookup (XLOOKUP-style) resolution. A lookup column has config:
//   { target_sheet_id, local_key_column_id, match_key_column_id, return_column_id }
// For a given row we take a LOCAL key value (local_key_column_id), find the first
// row in the target sheet whose match column equals it, then return that target
// row's return_column value.
//
// Any of local_key / match / return may be the literal string "__id__", meaning
// the row's key_value (the ID) rather than a column in row.data.
//
// Defaults (when a field is unset):
//   local_key_column_id -> "__id__"  (this row's key_value)
//   match_key_column_id -> "__id__"  (match against target row's key_value / ID)
//   return_column_id    -> first target column
//
// Runtime note: ids are numbers; data keys are stringified column ids.

import type { Column, Member, Row, SheetDetail } from '@/types/api'

export type TargetSheets = Record<string, SheetDetail | undefined>

/** Sentinel meaning "use the row's key_value (the ID)" instead of a column. */
export const ID_KEY = '__id__'

/** Read the value selected by `key` (a column id or the ID sentinel) from a row. */
function valueFor(key: string, row: Row): unknown {
  if (key === ID_KEY) return row.key_value
  return row.data[key]
}

/**
 * Resolve a lookup column's display value for `row`.
 * `members` (optional) lets us resolve a `member`-type return column to a name.
 */
export function resolveLookup(
  column: Column,
  row: Row,
  targets: TargetSheets,
  members: Member[] = [],
): string | null {
  const cfg = column.config
  if (!cfg?.target_sheet_id) return null

  const target = targets[String(cfg.target_sheet_id)]
  if (!target) return null

  const localKey = cfg.local_key_column_id ? String(cfg.local_key_column_id) : ID_KEY
  const matchKey = cfg.match_key_column_id ? String(cfg.match_key_column_id) : ID_KEY
  // Default return column: first target column.
  const returnKey = cfg.return_column_id
    ? String(cfg.return_column_id)
    : target.columns.length > 0
      ? String([...target.columns].sort((a, b) => a.order - b.order)[0].id)
      : ID_KEY

  const localVal = valueFor(localKey, row)
  const localStr = String(localVal ?? '')
  if (localStr === '') return null

  const hit = target.rows.find((t) => {
    const targetVal = valueFor(matchKey, t)
    return String(targetVal ?? '') === localStr
  })
  if (!hit) return null

  const out = valueFor(returnKey, hit)
  if (out == null || out === '') return null

  // If the return column is a member type, resolve the id to the member name.
  if (returnKey !== ID_KEY) {
    const retCol = target.columns.find((c) => String(c.id) === returnKey)
    if (retCol?.type === 'member') {
      const m = members.find((x) => String(x.id) === String(out))
      return m ? m.name : String(out)
    }
  }
  return String(out)
}

/** Target sheet ids referenced by any lookup column in `columns`. */
export function lookupTargetSheetIds(columns: Column[]): string[] {
  const ids = new Set<string>()
  for (const c of columns) {
    if (c.type === 'lookup' && c.config?.target_sheet_id != null) {
      ids.add(String(c.config.target_sheet_id))
    }
  }
  return [...ids]
}
