import { expect, it } from 'bun:test'
import { createBrowserRecruitingTool } from './BrowserRecruitingTool.js'

it('cannot confirm or execute recruiting side effects', () => {
  const bridge = {
    listPages: () => [],
    getAction: async () => undefined,
    prepareAction: async () => ({ state: 'awaiting_confirmation' }),
  }
  const tool = createBrowserRecruitingTool('product_task_1234', bridge as never)
  const variants = (tool.inputSchema as { _def?: { options?: Array<{ shape?: Record<string, { value?: string }> }> } })._def?.options ?? []
  const actions = variants.map(option => option.shape?.action?.value).filter(Boolean)
  expect(actions).toEqual(['get_current_pages', 'prepare_recruiting_action', 'get_recruiting_action'])
  expect(actions).not.toContain('confirm')
  expect(actions).not.toContain('execute')
})
