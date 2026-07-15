import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./workbuddy-tokens.css', import.meta.url), 'utf8')

test('theme keeps Codex-neutral primary actions while restoring restrained blue accents', () => {
  expect(css).toContain('--color-primary: var(--cx-accent);')
  expect(css).toContain('--color-brand: var(--cx-blue);')
  expect(css).toContain('--color-brand: var(--cx-blue-dark);')
  expect(css).toContain('--color-surface-selected: color-mix(in oklab, var(--cx-blue) 11%, transparent);')
})
