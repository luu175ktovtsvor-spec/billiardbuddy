import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

test('composer menus escape the clipped input surface through a body portal', () => {
  expect(source).toContain('createPortal(popover, document.body)')
  expect(source).toContain('className="fixed z-50 min-w-[220px]')
  expect(source).not.toContain('className="absolute bottom-full z-50')
})
