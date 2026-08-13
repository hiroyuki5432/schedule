/// <reference types="vite/client" />

// ビルド時に vite.config.ts の `define` が埋める値（lib/version.ts が読む）。
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
declare const __APP_BUILT_AT__: string
