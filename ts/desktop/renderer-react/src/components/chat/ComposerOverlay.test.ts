import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

test('composer menus escape the clipped input surface through a body portal', () => {
  expect(source).toContain('createPortal(popover, document.body)')
  expect(source).toContain('className="fixed z-50 min-w-[220px]')
  expect(source).not.toContain('className="absolute bottom-full z-50')
})

test('slash discovery uses venue-owner language instead of implementation jargon', () => {
  expect(source).toContain("return cmd.kind === 'skill' ? '专项工作' : null")
  expect(source).toContain("bundled: '内置'")
  expect(source).toContain("user: '我的'")
  expect(source).toContain("workspace: '当前门店'")
  expect(source).toContain("if (cmd.source === 'pack') return '球房运营'")
  expect(source).toContain('没有匹配的工作或文件')
  expect(source).not.toContain("return cmd.kind === 'skill' ? '技能' : null")
  expect(source).not.toContain("if (cmd.source === 'pack') return '专家'")
})
