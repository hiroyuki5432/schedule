// 属性セルの範囲操作（コピー・貼り付け・まとめて消去・フィル）の「中身」の部分。
// 画面の操作（選択・ドラッグ）は hooks/useCellRange.ts、ここは純粋な変換だけ。
//
// 要望: Excel と比べて「1セルずつしか触れない」のが面倒。テーブル型シートと
// スケジュールの属性列で、Excel と同じようにコピペ・Delete・フィルができるように。

import { isComputed } from '@/lib/computed'
import type { CellValue, Column, Member } from '@/types/api'

/** ID 列を範囲の中で表すキー（列ID と衝突しない）。 */
export const ID_CELL = '__id__'

// ---- TSV（Excel とのクリップボードのやり取り） -------------------------------

/**
 * Excel がクリップボードに書く TSV を2次元配列に。
 *
 * セルの中に改行・タブ・" があると、Excel はそのセルを "…" で囲み、中の " を "" に
 * する。素直に改行で割ると、Alt+Enter の入ったセルが2行に化ける。
 */
export function parseTsv(text: string): string[][] {
  const src = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  let quoted = false
  let atCellStart = true
  while (i < src.length) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      cell += ch
      i += 1
      continue
    }
    if (ch === '"' && atCellStart) {
      quoted = true
      atCellStart = false
      i += 1
      continue
    }
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      atCellStart = true
      i += 1
      continue
    }
    if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
      i += 1
      continue
    }
    cell += ch
    atCellStart = false
    i += 1
  }
  // 末尾の改行は「最後の行の終わり」なので、空の行を足さない。
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** 2次元配列 → Excel にそのまま貼れる TSV。 */
export function toTsv(matrix: string[][]): string {
  const esc = (v: string) =>
    /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return matrix.map((r) => r.map(esc).join('\t')).join('\n')
}

// ---- 貼り付けた文字 → 保存する値 ---------------------------------------------

export type ParseResult =
  | { ok: true; value: CellValue; /** 選択肢に無い値（プルダウン） */ unlisted?: boolean }
  | { ok: false; reason: string }

/** 全角の数字・記号を半角に（Excel から来る値は全角が混ざりやすい）。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[０-９．－＋，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[／]/g, '/')
}

/** 日付の書き方をいくつか受け付けて 'YYYY-MM-DD' に。読めなければ null。 */
export function parseDateText(raw: string, today: Date = new Date()): string | null {
  const s = toHalfWidth(raw.trim())
  const pad = (n: number) => String(n).padStart(2, '0')
  const build = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
      return null
    return `${y}-${pad(m)}-${pad(d)}`
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/)
  if (m) return build(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
  if (m) return build(+m[1], +m[2], +m[3])
  // 年なし（10/3）は Excel と同じく今年とみなす。
  m = s.match(/^(\d{1,2})[/](\d{1,2})$/)
  if (m) return build(today.getFullYear(), +m[1], +m[2])
  return null
}

/**
 * 貼り付けられた1セルの文字を、その列に保存する値に変換する。
 * 空文字は「空にする」。変換できないものは理由つきで断る（黙って捨てない）。
 */
export function parseCellText(column: Column, raw: string, members: Member[]): ParseResult {
  const text = raw.replace(/\r\n?/g, '\n')
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (isComputed(column)) return { ok: false, reason: `「${column.name}」は計算列` }
  switch (column.type) {
    case 'number': {
      const s = toHalfWidth(trimmed).replace(/,/g, '').replace(/\s+/g, '')
      const n = Number(s)
      if (s === '' || !Number.isFinite(n)) return { ok: false, reason: `数値でない「${trimmed}」` }
      return { ok: true, value: n }
    }
    case 'date': {
      const iso = parseDateText(trimmed)
      if (!iso) return { ok: false, reason: `日付として読めない「${trimmed}」` }
      return { ok: true, value: iso }
    }
    case 'member': {
      // 画面に出ている名前で貼られる。同名が2人いたら、どちらか決められないので断る。
      const hits = members.filter((m) => m.name === trimmed)
      if (hits.length === 1) return { ok: true, value: Number(hits[0].id) }
      if (hits.length > 1) return { ok: false, reason: `同じ名前のメンバーが複数「${trimmed}」` }
      const byId = members.find((m) => String(m.id) === trimmed)
      if (byId) return { ok: true, value: Number(byId.id) }
      return { ok: false, reason: `メンバーにいない「${trimmed}」` }
    }
    case 'dropdown': {
      const opts = column.config?.options ?? []
      const listed = opts.some((o) => o.value === trimmed)
      // 選択肢に無い値も入れる（取り込みと同じ扱い。一覧では「未登録」と分かる形で出る）。
      return { ok: true, value: trimmed, unlisted: !listed }
    }
    default:
      // 自由入力・手動のステータス。複数行はそのまま（セルの中の改行を保つ）。
      return { ok: true, value: column.config?.multiline ? text.trim() : trimmed }
  }
}

// ---- フィル（Excel のフィルハンドル） ------------------------------------------

/** 末尾の数字を増やせる文字列（P26-001 → P26-002）の分解。 */
function splitTrailingNumber(s: string): { head: string; num: number; width: number } | null {
  const m = s.match(/^(.*?)(\d+)$/)
  if (!m) return null
  return { head: m[1], num: Number(m[2]), width: m[2].length }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
}

const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/**
 * フィルハンドルで伸ばしたときの値（Excel の既定の動きに合わせる）:
 *  - 数値: 1つなら同じ値をコピー、2つ以上なら等差で続ける
 *  - 日付: 1つなら1日ずつ、2つ以上なら同じ間隔で続ける
 *  - 末尾が数字の文字（P26-001）: 1つなら +1、2つ以上で同じ頭なら同じ間隔
 *  - それ以外: 元の並びを繰り返す
 *
 * `source` は元にするセル（上から順）、`count` は埋める数、`backward` は上へ伸ばす
 * とき（元の先頭から遡る）。
 */
export function fillSeries(
  source: CellValue[],
  count: number,
  backward = false,
): CellValue[] {
  if (count <= 0 || source.length === 0) return []
  const src = backward ? [...source].reverse() : source
  const nonEmpty = src.every((v) => v !== null && v !== '')
  const out: CellValue[] = []
  const sign = backward ? -1 : 1

  if (nonEmpty && src.every((v) => typeof v === 'number')) {
    const nums = src as number[]
    if (nums.length === 1) return Array(count).fill(nums[0])
    const step = (nums[nums.length - 1] - nums[0]) / (nums.length - 1)
    const round = (x: number) => Math.round(x * 1e9) / 1e9
    for (let i = 1; i <= count; i++) out.push(round(nums[nums.length - 1] + step * i))
    return out
  }
  if (nonEmpty && src.every(isIsoDate)) {
    const ds = src as string[]
    const step =
      ds.length === 1 ? sign : Math.round(daysBetween(ds[0], ds[ds.length - 1]) / (ds.length - 1))
    for (let i = 1; i <= count; i++) out.push(addDays(ds[ds.length - 1], step * i))
    return out
  }
  if (nonEmpty && src.every((v) => typeof v === 'string')) {
    const parts = (src as string[]).map(splitTrailingNumber)
    if (parts.every((p) => p !== null) && parts.every((p) => p!.head === parts[0]!.head)) {
      const ps = parts as Array<{ head: string; num: number; width: number }>
      const step =
        ps.length === 1 ? sign : Math.round((ps[ps.length - 1].num - ps[0].num) / (ps.length - 1))
      const last = ps[ps.length - 1]
      for (let i = 1; i <= count; i++) {
        const n = last.num + step * i
        if (n < 0) {
          out.push(src[(i - 1) % src.length])
          continue
        }
        out.push(last.head + String(n).padStart(last.width, '0'))
      }
      return out
    }
  }
  for (let i = 0; i < count; i++) out.push(src[i % src.length])
  return out
}
