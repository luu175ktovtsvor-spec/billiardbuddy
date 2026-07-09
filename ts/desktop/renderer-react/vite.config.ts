import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// React 渲染器构建产线(对齐 cc-haha)。
// - root = 本目录(desktop/renderer-react),index.html 在此。
// - 产物输出到 desktop/renderer-dist(避开 electron-builder 的 desktop/dist)。
// - base './' 保证 file:// 加载时相对资源路径正确。
// dev:  bun run ui:dev   → Vite dev server(HMR)http://127.0.0.1:1420
// build:bun run ui:build → 出 desktop/renderer-dist/(Electron loadFile 加载)
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
    // 与 cc 一致:Vite 8 默认 baseline 需 macOS 13+;降到 safari15 兼容旧 WebView。
    target: ['es2021', 'safari15'],
    chunkSizeWarningLimit: 2200,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  clearScreen: false,
})
