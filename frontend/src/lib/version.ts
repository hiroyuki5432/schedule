// このビルドの正体（要望: 今のシステムがどのバージョンなのか分かるようにしてほしい）。
//
// 値は vite.config.ts の `define` がビルド時に埋め込む。開発サーバでは 'dev' に
// なることがあるが、それ自体が「これは配布物ではない」という情報になる。

export interface BuildInfo {
  version: string
  /** git の短縮ハッシュ。'dev' はビルド情報が埋まっていない（ソース直実行）。 */
  commit: string
  /** ISO8601。空文字なら不明。 */
  built_at: string
}

export const FRONTEND_BUILD: BuildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev',
  built_at: typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : '',
}

/** 画面に出す短い表記。例: 'v1.1.0 (bef6949)' */
export function shortLabel(b: BuildInfo): string {
  return b.commit && b.commit !== 'dev'
    ? `v${b.version} (${b.commit})`
    : `v${b.version} (開発)`
}

/** ISO8601 → 'YYYY-MM-DD HH:mm'。空・不正なら '—'。 */
export function fmtBuiltAt(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 画面（フロント）とサーバ（バック）がズレているか。
 *
 * ズレは「直したはずなのに直っていない」の一番よくある原因 — ブラウザが古い JS を
 * キャッシュしている／片方だけ再ビルドした、のどちらか。commit が両方とも実ビルド
 * （'dev' でない）のときだけ判定する。
 */
export function isMismatched(front: BuildInfo, back: BuildInfo | undefined): boolean {
  if (!back) return false
  if (front.commit === 'dev' || back.commit === 'dev') return false
  return front.commit !== back.commit
}
