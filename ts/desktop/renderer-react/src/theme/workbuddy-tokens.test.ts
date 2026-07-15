import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./workbuddy-tokens.css', import.meta.url), 'utf8')

test('theme keeps the established light-blue accent across primary and selected surfaces', () => {
  expect(css).toContain('--cx-accent: var(--cx-blue);')
  expect(css).toContain('--cx-accent: var(--cx-blue-dark);')
  expect(css).toContain('--color-primary: var(--cx-accent);')
  expect(css).toContain('--color-brand: var(--cx-accent);')
  expect(css).toContain('--color-surface-selected: color-mix(in oklab, var(--cx-accent) 13%, transparent);')
  expect(css).toContain('--color-surface-selected: color-mix(in oklab, var(--cx-accent) 24%, transparent);')
})
