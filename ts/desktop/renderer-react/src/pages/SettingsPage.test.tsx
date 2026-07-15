import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { PERMISSION_MODE_LABEL, SettingsNavRow } from './SettingsPage'

const source = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8')

test('设置导航使用 Codex 的内容高度和圆角行', () => {
  const html = renderToStaticMarkup(
    <SettingsNavRow icon={<span>i</span>} label="常规" active onClick={() => undefined} />,
  )

  expect(html).toContain('aria-current="page"')
  expect(html).toContain('min-h-[32px]')
  expect(html).toContain('rounded-lg')
  expect(html).toContain('px-2 py-1.5')
  expect(html).not.toContain('rounded-[10px]')
  expect(html).not.toContain('h-[30px]')
})

test('设置页展示真实权限档名称而不是禁用的假开关', () => {
  expect(PERMISSION_MODE_LABEL.default).toBe('默认权限')
  expect(PERMISSION_MODE_LABEL.acceptEdits).toBe('接受修改')
  expect(PERMISSION_MODE_LABEL.bypassPermissions).toBe('完全访问')
})

test('已归档任务明确区分打开、恢复和永久删除', () => {
  expect(source).toContain('恢复')
  expect(source).toContain('打开')
  expect(source).toContain('永久删除已归档任务？')
  expect(source).toContain('历史压缩备份都会从本机删除')
  expect(source).toContain("onClick={() => { setNav('chat'); openExistingConversation(s.id, s.title) }}")
  expect(source).not.toContain("toggleArchive(s.id); setNav('chat')")
  expect(source).not.toContain('window.confirm')
})
