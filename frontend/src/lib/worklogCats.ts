// 実績入力の分類（大分類→中分類→…）のヘルパー。段数も名称も org 設定で変えられる
// ため、画面側はこの関数越しに扱う（保存先は work_logs.cat1/cat2/cat3 の3枠まで）。
import type { WorkLogCategoryNode, WorkLogMaster } from '@/types/api'

/** Storage fields, in level order. The 3 slots cap how many levels can exist. */
export const CAT_FIELDS = ['cat1', 'cat2', 'cat3'] as const
export type CatField = (typeof CAT_FIELDS)[number]

/** Level names when the org hasn't configured any. */
export const DEFAULT_CATEGORY_LEVELS = ['大分類', '中分類']

/** Level names in use (1〜3段). */
export function categoryLevels(master: WorkLogMaster | undefined): string[] {
  const raw = master?.category_levels
  if (!Array.isArray(raw)) return [...DEFAULT_CATEGORY_LEVELS]
  const names = raw.map((s) => String(s).trim()).filter(Boolean).slice(0, CAT_FIELDS.length)
  return names.length ? names : [...DEFAULT_CATEGORY_LEVELS]
}

/** Children of `name` within `nodes` (the options for the next level). */
export function childrenOf(
  nodes: WorkLogCategoryNode[] | undefined,
  name: string | null,
): WorkLogCategoryNode[] {
  if (!nodes || !name) return []
  return nodes.find((n) => n.name === name)?.children ?? []
}

/** Option lists for every level, given the values picked so far. */
export function optionsPerLevel(
  master: WorkLogMaster | undefined,
  values: Array<string | null>,
  levelCount: number,
): WorkLogCategoryNode[][] {
  const out: WorkLogCategoryNode[][] = []
  let nodes = master?.categories ?? []
  for (let i = 0; i < levelCount; i++) {
    out.push(nodes)
    nodes = childrenOf(nodes, values[i] ?? null)
  }
  return out
}

/** Patch that sets level `i` and clears every deeper level (they no longer fit). */
export function pickPatch(
  levelIndex: number,
  value: string | null,
  levelCount: number,
): Record<string, string | null> {
  const patch: Record<string, string | null> = { [CAT_FIELDS[levelIndex]]: value }
  for (let i = levelIndex + 1; i < Math.min(levelCount, CAT_FIELDS.length); i++) {
    patch[CAT_FIELDS[i]] = null
  }
  return patch
}
