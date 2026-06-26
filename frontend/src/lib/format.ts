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

/** cn — join class names, dropping falsy. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
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
