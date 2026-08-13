import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// ---- ビルド情報（要望: 今のシステムがどのバージョンか分かるようにしてほしい）----
// 本番イメージには .git が入らないので、CI/Docker からは APP_COMMIT を渡す。
// 渡されなければ手元の git から拾い、それも無理なら 'dev'。
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version: string }

function gitCommit(): string {
  if (process.env.APP_COMMIT) return process.env.APP_COMMIT
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILT_AT__: JSON.stringify(
      process.env.APP_BUILT_AT || new Date().toISOString(),
    ),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    port: 5173,
    // Windows + Docker bind mounts don't emit fs events into the container;
    // poll so edits on the host trigger HMR.
    watch: { usePolling: true, interval: 150 },
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:8100',
        changeOrigin: true,
      },
    },
  },
})
