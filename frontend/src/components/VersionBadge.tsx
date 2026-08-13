// サイドバー下部のバージョン表示（要望: 今のシステムがどのバージョンなのか分かるように）。
//
// 目的は「番号を飾ること」ではなく、"直したはずなのに直っていない" を切り分けられる
// ようにすること。だから出すのは3つ:
//   ・画面（フロント）のビルド      … ブラウザが読み込んでいる JS
//   ・サーバ（バック）のビルド      … API が動いているコンテナ
//   ・両者のズレ警告                … 片方だけ更新／ブラウザのキャッシュ
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as api from '@/api/client'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import {
  FRONTEND_BUILD,
  fmtBuiltAt,
  isMismatched,
  shortLabel,
} from '@/lib/version'
import type { BuildInfo } from '@/lib/version'

/** サーバのビルド情報。滅多に変わらないので長めにキャッシュする。 */
function useServerBuild() {
  return useQuery({
    queryKey: ['server-version'],
    queryFn: api.getServerVersion,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function VersionBadge() {
  const [open, setOpen] = useState(false)
  const serverQ = useServerBuild()
  const server = serverQ.data as BuildInfo | undefined
  const mismatch = isMismatched(FRONTEND_BUILD, server)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="バージョン情報（画面とサーバのビルドを確認）"
        className="mt-1 flex w-full items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-left text-[10.5px] text-[#8FB0A2] hover:bg-[var(--green-line)] hover:text-white"
      >
        <span className="truncate">{shortLabel(FRONTEND_BUILD)}</span>
        {mismatch && (
          <span
            title="画面とサーバのビルドが違います"
            className="ml-auto flex-shrink-0 rounded-full bg-[#E9B44C] px-1.5 text-[9.5px] font-semibold text-[#4A3411]"
          >
            !
          </span>
        )}
      </button>

      {open && (
        <Modal title="バージョン情報" onClose={() => setOpen(false)} widthClass="w-[420px]">
          <BuildRow
            label="画面（このブラウザ）"
            build={FRONTEND_BUILD}
            hint="ブラウザが読み込んでいる JavaScript。古い場合は再読み込みで直ります。"
          />
          <div className="my-3 border-t border-[var(--line2)]" />
          <BuildRow
            label="サーバ（API）"
            build={server}
            loading={serverQ.isLoading}
            error={serverQ.isError}
            hint="バックエンドのコンテナ。ここが古いなら再ビルド／再起動が必要です。"
          />

          {mismatch && (
            <div className="mt-3 rounded-[9px] border border-[#E4C9A8] bg-[#FBF3E6] px-3 py-2 text-[11.5px] leading-relaxed text-[#8A5A1E]">
              画面とサーバのビルドが一致していません。まず <b>Ctrl+Shift+R</b>{' '}
              で強制再読み込みしてください。それでも変わらないときは、フロント側のコンテナが
              古いままです（<code>docker compose up -d --build</code>）。
            </div>
          )}

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => window.location.reload()}
              className="text-[11.5px] text-[var(--green-d)] hover:underline"
            >
              画面を再読み込み
            </button>
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
              閉じる
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}

function BuildRow({
  label,
  build,
  hint,
  loading,
  error,
}: {
  label: string
  build: BuildInfo | undefined
  hint: string
  loading?: boolean
  error?: boolean
}) {
  return (
    <div>
      <div className="text-[12px] font-medium text-[var(--ink)]">{label}</div>
      {loading ? (
        <div className="mt-1 text-[12px] text-[var(--ink3)]">確認中…</div>
      ) : error || !build ? (
        <div className="mt-1 text-[12px] text-[#A8442B]">取得できませんでした</div>
      ) : (
        <dl className="mt-1 grid grid-cols-[76px_1fr] gap-x-2 gap-y-0.5 text-[12px]">
          <dt className="text-[var(--ink3)]">バージョン</dt>
          <dd className="text-[var(--ink2)]">{build.version}</dd>
          <dt className="text-[var(--ink3)]">コミット</dt>
          <dd className="font-mono text-[11.5px] text-[var(--ink2)]">{build.commit}</dd>
          <dt className="text-[var(--ink3)]">ビルド日時</dt>
          <dd className="text-[var(--ink2)]">{fmtBuiltAt(build.built_at)}</dd>
        </dl>
      )}
      <div className="mt-1 text-[11px] leading-relaxed text-[var(--ink3)]">{hint}</div>
    </div>
  )
}
