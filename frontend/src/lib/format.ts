// Small presentation helpers.

/** First character of a name, for avatar chips. */
export function initial(name: string | undefined | null): string {
  if (!name) return '?'
  return name.trim().charAt(0)
}

const AVATAR_BG = ['#DCEAE3', '#F3E7CC', '#E7DDEA', '#DCE6EA', '#EAE2DC']

/** Stable-ish background color for an avatar from an id/name. */
export function avatarBg(seed: string | undefined | null): string {
  if (!seed) return AVATAR_BG[0]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_BG[h % AVATAR_BG.length]
}

/** Display format for 工数 (hours): whole numbers only (要望: 工数の表示は小数いらない).
 *  Stored values keep their precision — this is presentation only, so a 0.5h
 *  entry still adds 0.5 to every total; it just isn't printed with a decimal.
 *  Use `round1` where the exact value matters (tooltips, editors). */
export function fmtHours(n: number): string {
  return String(Math.round(n))
}

// cn — join class names, with last-one-wins for conflicting Tailwind utilities.
//
// Why the merge: which of two conflicting utilities applies is decided by the
// order Tailwind emits them in the stylesheet, NOT by their order in the class
// attribute. `.py-2` is emitted after `.py-0`, so `<Select className="h-7 py-0">`
// kept the base `py-2` — 16px of padding inside a 28px box — and clipped its own
// text (Excel一括取り込みの取り込み先が読めなかった件). Dropping the earlier class
// of a conflicting pair makes the override actually win.
//
// Only utilities whose group can be identified unambiguously are merged; anything
// unrecognised is passed through untouched, so this can never silently eat a class.

/** Utility prefixes where `<prefix>-<value>` sets one property. Longest match wins. */
const PREFIX_GROUPS = [
  'min-w',
  'min-h',
  'max-w',
  'max-h',
  'gap-x',
  'gap-y',
  'px',
  'py',
  'pt',
  'pr',
  'pb',
  'pl',
  'mx',
  'my',
  'mt',
  'mr',
  'mb',
  'ml',
  'gap',
  'rounded',
  'leading',
  'tracking',
  'opacity',
  'p',
  'm',
  'w',
  'h',
  'z',
].sort((a, b) => b.length - a.length)

const FONT_SIZES = new Set([
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
])
const TEXT_ALIGNS = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])
/** `text-*` utilities that are neither size, colour nor alignment — left alone. */
const TEXT_OTHER = new Set(['ellipsis', 'clip', 'wrap', 'nowrap', 'balance', 'pretty'])
const FONT_WEIGHTS = new Set([
  'thin',
  'extralight',
  'light',
  'normal',
  'medium',
  'semibold',
  'bold',
  'extrabold',
  'black',
])
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'none', 'hidden'])
const NAMED_COLORS = new Set(['transparent', 'current', 'inherit', 'white', 'black'])

/** An arbitrary length like [11.5px] / [1.2rem] / [50%]. */
const ARBITRARY_LEN = /^\[-?[\d.]+(px|rem|em|pt|%|vh|vw|ch)?\]$/

function isColorValue(v: string): boolean {
  if (NAMED_COLORS.has(v)) return true
  // [#fff] / [var(--x)] / [rgb(...)] — but not a bare length such as [2px].
  if (v.startsWith('[')) return !ARBITRARY_LEN.test(v)
  // red-500, ink-2, green (theme colours, with or without a shade)
  return /^[a-z]+-\d+$/.test(v) || /^(ink|line|green|phase)$/.test(v)
}

/** The conflict group of one class, or null when it should never be dropped. */
function groupOf(cls: string): string | null {
  // Variants scope the conflict: hover:bg-x must not displace bg-y.
  const cut = cls.lastIndexOf(':')
  const variant = cut >= 0 ? cls.slice(0, cut + 1) : ''
  let base = cut >= 0 ? cls.slice(cut + 1) : cls
  base = base.replace(/^!/, '')
  const negative = base.startsWith('-')
  if (negative) base = base.slice(1)

  // Bare utilities that a later value overrides.
  if (base === 'border') return `${variant}border-w`
  if (base === 'rounded') return `${variant}rounded`

  if (base.startsWith('text-')) {
    const v = base.slice(5)
    if (TEXT_OTHER.has(v)) return null
    if (TEXT_ALIGNS.has(v)) return `${variant}text-align`
    if (FONT_SIZES.has(v) || ARBITRARY_LEN.test(v)) return `${variant}font-size`
    if (isColorValue(v)) return `${variant}text-color`
    return null
  }
  if (base.startsWith('font-')) {
    const v = base.slice(5)
    return FONT_WEIGHTS.has(v) ? `${variant}font-weight` : null
  }
  if (base.startsWith('bg-')) {
    const v = base.slice(3)
    return isColorValue(v) ? `${variant}bg-color` : null
  }
  if (base.startsWith('border-')) {
    const v = base.slice(7)
    if (/^(x|y|t|r|b|l|s|e)(-|$)/.test(v)) return null // 片側指定 (border-b-0) は触らない
    if (BORDER_STYLES.has(v)) return `${variant}border-style`
    if (/^\d+$/.test(v)) return `${variant}border-w`
    if (isColorValue(v)) return `${variant}border-color`
    return null // border-t-2 などの片側指定は触らない
  }
  // 角ごとの指定 (rounded-t-lg) は全体指定 (rounded-[14px]) を置き換えない。
  if (/^rounded-(t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee)(-|$)/.test(base)) return null

  for (const p of PREFIX_GROUPS) {
    if (base.startsWith(`${p}-`)) return `${variant}${p}`
  }
  return null
}

/** cn — join class names, dropping falsy and earlier conflicting utilities. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  const classes = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  const winner = new Map<string, number>()
  const groups = classes.map(groupOf)
  groups.forEach((g, i) => {
    if (g) winner.set(g, i)
  })
  return classes.filter((_, i) => groups[i] === null || winner.get(groups[i]!) === i).join(' ')
}

// A date cell may hold a literal placeholder dash (「-」全角/半角・ダッシュ各種) to
// mean "no date". For sorting we want those treated as empty so they always sort
// to the bottom (要望: 日付ソートは「-」を常に下に), regardless of asc/desc.
const DATE_PLACEHOLDER = /^[-‐-―－−ー\s]+$/

/** Normalize a date column value for sorting: placeholder dashes → '' (=empty). */
export function normalizeDateForSort(v: unknown): string {
  if (v == null) return ''
  const s = String(v).trim()
  if (s === '' || DATE_PLACEHOLDER.test(s)) return ''
  return s
}
