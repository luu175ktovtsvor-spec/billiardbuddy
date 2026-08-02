import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    // Electron's Chromium renderer supports ES2021. Keep the target explicit
    // so production output does not silently drift with Vite defaults.
    target: 'es2021',
    chunkSizeWarningLimit: 2200,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT') return
        warn(warning)
      },
    },
  },
  // Keep local renderer logs visible while Electron starts the app shell.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/runtime-assets/**'],
    },
  },
})
