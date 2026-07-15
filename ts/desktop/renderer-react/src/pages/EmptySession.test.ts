import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./EmptySession.tsx', import.meta.url), 'utf8')

test('empty session uses the same full-strength brand mark as the sidebar', () => {
  expect(source).toContain('<Smiley size={40} />')
  expect(source).not.toContain('Smiley size={40} className="opacity-40"')
})
