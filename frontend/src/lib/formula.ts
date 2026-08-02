// 数式列 (formula) の式エンジン。
//
// 要望: 列に対して同じ計算をさせたい（単価×数量、完了日−開始日 など）。Excel の
// A1 参照は使えない — このアプリの行は並べ替え・絞り込みで動くうえ、セル番地という
// 概念自体がない。代わりに「同じ行の、名前で指した列」を参照する:
//
//   [単価] * [数量]
//   IF([完了日]="", "", [完了日] - [開始日]) & "日"
//   ROUND([予定工数] / [人数], 1)
//
// 評価はブラウザ側だけ（参照(LOOKUP)列と同じ）。式そのものだけが保存され、計算結果は
// DB に入らない。`eval` は使わず、自前のトークナイザ＋Pratt パーサで解釈する。
//
// 日付は 'YYYY-MM-DD' 文字列。日付−日付＝日数、日付±数値＝日付 として扱うので、
// 期間の計算がそのまま書ける。

export type FormulaValue = number | string | boolean | null

export interface FormulaAst {
  node: Node
  /** 参照している列名（重複なし）。循環参照の検出とエディタの検証に使う。 */
  refs: string[]
}

export interface ParseResult {
  ast: FormulaAst | null
  /** 日本語のエラーメッセージ。null なら成功。 */
  error: string | null
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; name: string }
  | { k: 'un'; op: string; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; name: string; args: Node[] }

/** 評価に必要な外側の情報。 */
export interface FormulaContext {
  /** 同じ行の列の値。列名が存在しないときは undefined を返すこと。 */
  value: (columnName: string) => FormulaValue | undefined
  /** TODAY() が返す日付。既定は今日。 */
  today?: string
}

/** 式の評価に失敗したときに投げる（メッセージはそのままセルに出る）。 */
class FormulaError extends Error {}

// --------------------------------------------------------------------------- //
// トークナイザ
// --------------------------------------------------------------------------- //
interface Token {
  t: 'num' | 'str' | 'ref' | 'name' | 'op'
  v: string
}

const OPS_2 = ['<=', '>=', '<>']
const OPS_1 = '+-*/^&=<>(),'

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    // [列名] — 中身はそのまま列名。閉じ括弧までを1つとして読む。
    if (c === '[') {
      const end = src.indexOf(']', i + 1)
      if (end < 0) throw new FormulaError('列名の「]」が閉じていません')
      out.push({ t: 'ref', v: src.slice(i + 1, end).trim() })
      i = end + 1
      continue
    }
    // "文字列" / '文字列'（同じ引用符を2つ重ねるとその引用符自身）
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= src.length) throw new FormulaError('文字列の引用符が閉じていません')
        if (src[j] === c) {
          if (src[j + 1] === c) {
            s += c
            j += 2
            continue
          }
          break
        }
        s += src[j]
        j++
      }
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      const raw = src.slice(i, j)
      if ((raw.match(/\./g) || []).length > 1) throw new FormulaError(`数値が読めません：${raw}`)
      out.push({ t: 'num', v: raw })
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS_2.includes(two)) {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if (OPS_1.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    // 関数名（英字・数字・アンダースコア）。日本語の列名は [] で囲む決まりなので
    // ここには来ない。
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++
      out.push({ t: 'name', v: src.slice(i, j) })
      i = j
      continue
    }
    // 日本語の列名を [] なしで書いたときは、そう言ってあげる（一番ありがちな間違い）。
    let j = i
    while (j < src.length && !/[\s[\]]/.test(src[j]) && !OPS_1.includes(src[j])) j++
    throw new FormulaError(`列名は [ ] で囲んでください：${src.slice(i, j)}`)
  }
  return out
}

// --------------------------------------------------------------------------- //
// パーサ（優先順位つき）
// --------------------------------------------------------------------------- //
const BINDING: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '<=': 1,
  '>': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
}

function parseTokens(tokens: Token[]): Node {
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (v: string) => {
    const t = tokens[pos]
    if (!t || t.t !== 'op' || t.v !== v) throw new FormulaError(`「${v}」が必要です`)
    pos++
  }

  function primary(): Node {
    const t = tokens[pos]
    if (!t) throw new FormulaError('式が途中で終わっています')
    pos++
    if (t.t === 'num') return { k: 'num', v: Number(t.v) }
    if (t.t === 'str') return { k: 'str', v: t.v }
    if (t.t === 'ref') {
      if (!t.v) throw new FormulaError('列名が空です')
      return { k: 'ref', name: t.v }
    }
    if (t.t === 'name') {
      const upper = t.v.toUpperCase()
      if (upper === 'TRUE') return { k: 'num', v: 1 }
      if (upper === 'FALSE') return { k: 'num', v: 0 }
      if (!peek() || peek().t !== 'op' || peek().v !== '(') {
        throw new FormulaError(`列名は [ ] で囲んでください：${t.v}`)
      }
      eat('(')
      const args: Node[] = []
      if (peek() && peek().t === 'op' && peek().v === ')') {
        pos++
      } else {
        for (;;) {
          args.push(expr(0))
          const n = peek()
          if (n && n.t === 'op' && n.v === ',') {
            pos++
            continue
          }
          eat(')')
          break
        }
      }
      return { k: 'call', name: upper, args }
    }
    if (t.v === '(') {
      const e = expr(0)
      eat(')')
      return e
    }
    if (t.v === '-' || t.v === '+') return { k: 'un', op: t.v, e: primary() }
    throw new FormulaError(`ここには書けません：${t.v}`)
  }

  function expr(min: number): Node {
    let left = primary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op') break
      const bp = BINDING[t.v]
      if (bp === undefined || bp < min) break
      pos++
      // ^ だけ右結合（2^3^2 = 2^(3^2)）。
      const right = expr(t.v === '^' ? bp : bp + 1)
      left = { k: 'bin', op: t.v, l: left, r: right }
    }
    return left
  }

  const node = expr(0)
  if (pos < tokens.length) throw new FormulaError(`余分な「${tokens[pos].v}」があります`)
  return node
}

function collectRefs(n: Node, into: Set<string>): void {
  switch (n.k) {
    case 'ref':
      into.add(n.name)
      break
    case 'un':
      collectRefs(n.e, into)
      break
    case 'bin':
      collectRefs(n.l, into)
      collectRefs(n.r, into)
      break
    case 'call':
      n.args.forEach((a) => collectRefs(a, into))
      break
  }
}

/** 式を解析する。エラーは日本語メッセージで返す（例外は投げない）。 */
export function parseFormula(src: string): ParseResult {
  const text = (src ?? '').trim()
  if (!text) return { ast: null, error: null }
  try {
    const node = parseTokens(tokenize(text))
    const refs = new Set<string>()
    collectRefs(node, refs)
    return { ast: { node, refs: [...refs] }, error: null }
  } catch (e) {
    return { ast: null, error: e instanceof Error ? e.message : '式を読み取れません' }
  }
}

// --------------------------------------------------------------------------- //
// 値の変換
// --------------------------------------------------------------------------- //
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
const DAY_MS = 86_400_000

function asDate(v: FormulaValue): number | null {
  if (typeof v !== 'string') return null
  const m = DATE_RE.exec(v.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(t) ? null : t / DAY_MS
}

function dateText(days: number): string {
  const d = new Date(Math.round(days) * DAY_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

function isBlank(v: FormulaValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

/** 数値として読む。空欄は 0（Excel と同じ）。日付は通算日数になる。 */
function num(v: FormulaValue): number {
  if (isBlank(v)) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const d = asDate(v)
  if (d !== null) return d
  // 「1,200」「1200 円」のような表記も拾う（取り込んだ値がそのまま入っていることがある）
  const cleaned = v.replace(/[,\s]/g, '').replace(/^[¥￥$]/, '')
  const n = Number(cleaned)
  if (Number.isFinite(n) && cleaned !== '') return n
  throw new FormulaError(`数値として計算できません：${v}`)
}

function text(v: FormulaValue): string {
  // 空欄は空文字。ただし " " のような書いた空白はそのまま残す（連結の区切りに使う）。
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function truthy(v: FormulaValue): boolean {
  if (typeof v === 'boolean') return v
  if (isBlank(v)) return false
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toUpperCase()
  if (s === 'FALSE' || s === '0') return false
  return true
}

/** 表示用の文字列。数値の浮動小数点ノイズはここで落とす。 */
export function formatFormulaValue(v: FormulaValue, decimals?: number | null): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '#エラー'
    if (decimals != null && decimals >= 0) return v.toFixed(Math.min(decimals, 10))
    return String(Math.round(v * 1e10) / 1e10)
  }
  return v
}

// --------------------------------------------------------------------------- //
// 評価
// --------------------------------------------------------------------------- //
function compare(l: FormulaValue, r: FormulaValue): number {
  const ln = typeof l === 'number' || (!isBlank(l) && Number.isFinite(Number(l)))
  const rn = typeof r === 'number' || (!isBlank(r) && Number.isFinite(Number(r)))
  if (ln && rn) return num(l) - num(r)
  const ls = text(l)
  const rs = text(r)
  return ls === rs ? 0 : ls < rs ? -1 : 1
}

function binary(op: string, l: FormulaValue, r: FormulaValue): FormulaValue {
  switch (op) {
    case '&':
      return text(l) + text(r)
    case '=':
      return compare(l, r) === 0
    case '<>':
      return compare(l, r) !== 0
    case '<':
      return compare(l, r) < 0
    case '<=':
      return compare(l, r) <= 0
    case '>':
      return compare(l, r) > 0
    case '>=':
      return compare(l, r) >= 0
  }
  // 日付の足し引きだけ特別扱い: 日付−日付＝日数、日付±数値＝日付。
  const ld = asDate(l)
  const rd = asDate(r)
  if (op === '-' && ld !== null && rd !== null) return ld - rd
  if ((op === '+' || op === '-') && ld !== null && rd === null && !isBlank(r)) {
    return dateText(op === '+' ? ld + num(r) : ld - num(r))
  }
  if (op === '+' && ld === null && rd !== null && !isBlank(l)) return dateText(rd + num(l))

  const a = num(l)
  const b = num(r)
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (b === 0) throw new FormulaError('0 で割りました')
      return a / b
    case '^':
      return a ** b
  }
  throw new FormulaError(`使えない演算子です：${op}`)
}

function round(n: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const f = 10 ** digits
  const x = n * f
  const r =
    mode === 'half'
      ? Math.sign(x) * Math.round(Math.abs(x))
      : mode === 'up'
        ? Math.sign(x) * Math.ceil(Math.abs(x))
        : Math.sign(x) * Math.floor(Math.abs(x))
  return r / f
}

const ARITY: Record<string, [number, number]> = {
  IF: [2, 3],
  IFERROR: [2, 2],
  AND: [1, 99],
  OR: [1, 99],
  NOT: [1, 1],
  ISBLANK: [1, 1],
  SUM: [1, 99],
  AVERAGE: [1, 99],
  COUNT: [1, 99],
  MIN: [1, 99],
  MAX: [1, 99],
  ABS: [1, 1],
  INT: [1, 1],
  ROUND: [1, 2],
  ROUNDUP: [1, 2],
  ROUNDDOWN: [1, 2],
  LEN: [1, 1],
  LEFT: [1, 2],
  RIGHT: [1, 2],
  MID: [3, 3],
  CONCAT: [1, 99],
  TRIM: [1, 1],
  TODAY: [0, 0],
  DAYS: [2, 2],
  DATE: [3, 3],
  YEAR: [1, 1],
  MONTH: [1, 1],
  DAY: [1, 1],
}

/** 関数一覧（エディタのヒント用）。 */
export const FORMULA_FUNCTIONS = Object.keys(ARITY)

function dateParts(v: FormulaValue): { y: number; m: number; d: number } {
  const days = asDate(v)
  if (days === null) throw new FormulaError(`日付として読めません：${text(v)}`)
  const dt = new Date(days * DAY_MS)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function call(name: string, args: FormulaValue[], ctx: FormulaContext): FormulaValue {
  const nums = () => args.filter((a) => !isBlank(a)).map(num)
  switch (name) {
    case 'ISBLANK':
      return isBlank(args[0])
    case 'AND':
      return args.every(truthy)
    case 'OR':
      return args.some(truthy)
    case 'NOT':
      return !truthy(args[0])
    case 'SUM':
      return nums().reduce((a, b) => a + b, 0)
    case 'AVERAGE': {
      const v = nums()
      if (!v.length) throw new FormulaError('平均する値がありません')
      return v.reduce((a, b) => a + b, 0) / v.length
    }
    case 'COUNT':
      return args.filter((a) => !isBlank(a)).length
    case 'MIN':
    case 'MAX': {
      const v = nums()
      if (!v.length) return 0
      return name === 'MIN' ? Math.min(...v) : Math.max(...v)
    }
    case 'ABS':
      return Math.abs(num(args[0]))
    case 'INT':
      return Math.floor(num(args[0]))
    case 'ROUND':
      return round(num(args[0]), args.length > 1 ? num(args[1]) : 0, 'half')
    case 'ROUNDUP':
      return round(num(args[0]), args.length > 1 ? num(args[1]) : 0, 'up')
    case 'ROUNDDOWN':
      return round(num(args[0]), args.length > 1 ? num(args[1]) : 0, 'down')
    case 'LEN':
      return text(args[0]).length
    case 'LEFT':
      return text(args[0]).slice(0, args.length > 1 ? num(args[1]) : 1)
    case 'RIGHT': {
      const n = args.length > 1 ? num(args[1]) : 1
      return n <= 0 ? '' : text(args[0]).slice(-n)
    }
    case 'MID': {
      const start = Math.max(1, num(args[1]))
      return text(args[0]).substr(start - 1, num(args[2]))
    }
    case 'CONCAT':
      return args.map(text).join('')
    case 'TRIM':
      return text(args[0]).trim()
    case 'TODAY':
      return ctx.today ?? dateText(Math.floor(Date.now() / DAY_MS))
    case 'DAYS': {
      const a = asDate(args[0])
      const b = asDate(args[1])
      if (a === null || b === null) throw new FormulaError('DAYS は日付を2つ指定します')
      return a - b
    }
    case 'DATE': {
      const t = Date.UTC(num(args[0]), num(args[1]) - 1, num(args[2]))
      if (Number.isNaN(t)) throw new FormulaError('日付にできません')
      return dateText(t / DAY_MS)
    }
    case 'YEAR':
      return dateParts(args[0]).y
    case 'MONTH':
      return dateParts(args[0]).m
    case 'DAY':
      return dateParts(args[0]).d
  }
  throw new FormulaError(`知らない関数です：${name}`)
}

function run(n: Node, ctx: FormulaContext): FormulaValue {
  switch (n.k) {
    case 'num':
      return n.v
    case 'str':
      return n.v
    case 'ref': {
      const v = ctx.value(n.name)
      if (v === undefined) throw new FormulaError(`「${n.name}」という列がありません`)
      return v
    }
    case 'un': {
      const v = run(n.e, ctx)
      return n.op === '-' ? -num(v) : num(v)
    }
    case 'bin':
      return binary(n.op, run(n.l, ctx), run(n.r, ctx))
    case 'call': {
      const range = ARITY[n.name]
      if (!range) throw new FormulaError(`知らない関数です：${n.name}`)
      if (n.args.length < range[0] || n.args.length > range[1]) {
        throw new FormulaError(`${n.name} の引数の数が違います`)
      }
      // IF / IFERROR は必要な枝だけ評価する（0除算を IF で避けられるように）。
      if (n.name === 'IF') {
        if (truthy(run(n.args[0], ctx))) return run(n.args[1], ctx)
        return n.args.length > 2 ? run(n.args[2], ctx) : ''
      }
      if (n.name === 'IFERROR') {
        try {
          return run(n.args[0], ctx)
        } catch {
          return run(n.args[1], ctx)
        }
      }
      return call(
        n.name,
        n.args.map((a) => run(a, ctx)),
        ctx,
      )
    }
  }
}

export interface EvalResult {
  value: FormulaValue
  /** 計算できなかった理由（セルに表示する）。null なら成功。 */
  error: string | null
}

/** 解析済みの式を1行ぶん評価する。例外は投げず、エラーは文言で返す。 */
export function evalFormula(ast: FormulaAst | null, ctx: FormulaContext): EvalResult {
  if (!ast) return { value: null, error: null }
  try {
    return { value: run(ast.node, ctx), error: null }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : '計算できません' }
  }
}
