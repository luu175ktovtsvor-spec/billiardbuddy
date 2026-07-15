import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Modal } from './Modal'

const source = readFileSync(new URL('./Modal.tsx', import.meta.url), 'utf8')

test('Modal uses the current Codex Electron dialog surface and accessible dialog semantics', () => {
  const html = renderToStaticMarkup(
    <Modal open onClose={() => undefined} title="确认">
      <div>内容</div>
    </Modal>,
  )

  expect(html).toContain('background:#00000022')
  expect(html).toContain('rounded-3xl')
  expect(html).toContain('backdrop-blur-xl')
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-modal="true"')
  expect(html).toContain('aria-label="关闭"')
  expect(source).toContain('createPortal(modal, document.body)')
})
