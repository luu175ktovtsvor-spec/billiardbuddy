import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = dirname(fileURLToPath(import.meta.url))

describe('desktop build compatibility', () => {
  it('keeps production bundles loadable in the macOS 12 Safari 15 WebView', () => {
    const config = readFileSync(join(desktopRoot, 'vite.config.ts'), 'utf8')

    expect(config).toContain("target: ['es2021', 'safari15']")
  })

  it('defines the product shell palette with semantic surface tokens', () => {
    const css = readFileSync(join(desktopRoot, 'src', 'theme', 'globals.css'), 'utf8')

    expect(css).toContain('--color-app-main: #ffffff')
    expect(css).toContain('--color-app-sidebar: #f9f9f9')
    expect(css).toContain('--color-surface-selected: color-mix(')
  })
})
