import { afterEach, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { configureChromeSessionBridge } from '../services/chromeSessionBridge.js'
import { StandardProductTaskMcpHost } from './mcpHost.js'

let root: string | undefined
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined })

it('adds one task-scoped recruiting tool only to ProductTask Core runs', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-browser-mcp-'))
  configureChromeSessionBridge({
    statePath: path.join(root, 'actions.json'),
    descriptorPath: path.join(root, 'descriptor.json'),
    scheduler: new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json') }),
  })
  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => ({ servers: {} }),
    connect: async () => undefined,
  })
  expect((await host.connect('/workspace')).tools.map(tool => tool.name)).not.toContain('RecruitingBrowser')
  expect((await host.connect('/workspace', { taskId: 'product_task_1234' })).tools.map(tool => tool.name)).toEqual(['RecruitingBrowser'])
})
