import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { configureChromeSessionBridge } from '../services/chromeSessionBridge.js'
import { handleBrowserApi } from './browser.js'

const roots: string[] = []
const originalCapability = process.env.BB_BROWSER_UI_CAPABILITY

afterEach(async () => {
  if (originalCapability === undefined) delete process.env.BB_BROWSER_UI_CAPABILITY
  else process.env.BB_BROWSER_UI_CAPABILITY = originalCapability
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

function request(pathname: string, init?: RequestInit) {
  const req = new Request(`http://127.0.0.1:4567${pathname}`, init)
  const url = new URL(req.url)
  return handleBrowserApi(req, url, url.pathname.split('/').filter(Boolean))
}

describe('browser capability API', () => {
  it('separates native-host auth from the Electron-only human confirmation capability', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-browser-api-'))
    roots.push(root)
    const descriptorPath = path.join(root, 'descriptor.json')
    const bridge = configureChromeSessionBridge({
      statePath: path.join(root, 'actions.json'),
      descriptorPath,
      scheduler: new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json') }),
    })
    await bridge.activate('http://127.0.0.1:4567')
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) as { token: string }
    const payload = {
      protocol_version: 1,
      type: 'sync',
      session_id: 'browser_session_1234',
      page: {
        page_revision: 'page_revision_1234',
        url: 'https://www.zhipin.com/web/geek/recommend',
        title: '候选人推荐',
        candidates: [{ candidate_ref: 'candidate_ref_1234', display_name: '示例候选人', skills: ['门店服务'] }],
      },
    }
    expect((await request('/api/browser/native/sync', { method: 'POST', body: JSON.stringify(payload) })).status).toBe(401)
    expect((await request('/api/browser/native/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bb-browser-token': descriptor.token },
      body: JSON.stringify(payload),
    })).status).toBe(200)
    await bridge.prepareAction('product_task_1234', {
      session_id: 'browser_session_1234', page_revision: 'page_revision_1234', candidate_ref: 'candidate_ref_1234',
      kind: 'invite', client_operation_id: 'client_operation_1234',
    })

    process.env.BB_BROWSER_UI_CAPABILITY = 'electron-only-secret'
    expect((await request('/api/browser/tasks/product_task_1234/actions')).status).toBe(403)
    const allowed = await request('/api/browser/tasks/product_task_1234/actions', { headers: { 'x-bb-browser-ui-capability': 'electron-only-secret' } })
    expect(allowed.status).toBe(200)
    const action = (await allowed.json() as { actions: Array<{ id: string }> }).actions[0]!
    expect(action).toBeDefined()
    expect((await request(`/api/browser/tasks/product_task_1234/actions/${action.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bb-browser-ui-capability': 'electron-only-secret' },
      body: JSON.stringify({ expected_revision: 0, approved: true, bypass: true }),
    })).status).toBe(400)
  })
})
