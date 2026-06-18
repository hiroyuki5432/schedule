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
