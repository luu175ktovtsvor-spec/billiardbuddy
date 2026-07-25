import { getChromeSessionBridge } from '../services/chromeSessionBridge.js'
import { timingSafeEqual } from 'node:crypto'

function safeTaskId(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{8,128}$/.test(value))
}

export async function handleBrowserApi(req: Request, _url: URL, segments: string[]): Promise<Response> {
  const bridge = getChromeSessionBridge()

  if (req.method === 'GET' && segments.length === 3 && segments[2] === 'status') {
    return Response.json(bridge.status())
  }

  if (req.method === 'POST' && segments.length === 4 && segments[2] === 'native' && segments[3] === 'sync') {
    try {
      const payload = await req.json()
      const result = await bridge.handleNativeSync(req.headers.get('x-bb-browser-token'), payload)
      return Response.json(result)
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BROWSER_NATIVE_INVALID'
      return Response.json({ error: code }, { status: code === 'BROWSER_NATIVE_UNAUTHORIZED' ? 401 : 400 })
    }
  }

  const taskId = segments[2] === 'tasks' ? segments[3] : undefined
  if (!safeTaskId(taskId) || segments[4] !== 'actions') return Response.json({ error: 'Not Found' }, { status: 404 })
  const expectedCapability = process.env.BB_BROWSER_UI_CAPABILITY
  const actualCapability = req.headers.get('x-bb-browser-ui-capability')
  if (!expectedCapability || !actualCapability) return Response.json({ error: 'Forbidden' }, { status: 403 })
  const expectedBytes = Buffer.from(expectedCapability)
  const actualBytes = Buffer.from(actualCapability)
  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return Response.json({ error: 'Forbidden' }, { status: 403 })

  if (req.method === 'GET' && segments.length === 5) {
    return Response.json({ actions: await bridge.listActions(taskId) })
  }

  const actionId = segments[5]
  if (req.method === 'POST' && segments.length === 7 && actionId && segments[6] === 'resolve') {
    try {
      const body = await req.json() as Record<string, unknown>
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'approved,expected_revision' || !Number.isSafeInteger(body.expected_revision) || typeof body.approved !== 'boolean') return Response.json({ error: 'BROWSER_ACTION_INVALID' }, { status: 400 })
      const action = await bridge.resolveAction(taskId, actionId, body.expected_revision as number, body.approved)
      return Response.json({ action })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'BROWSER_ACTION_INVALID'
      const status = code === 'BROWSER_ACTION_NOT_FOUND' ? 404 : code === 'BROWSER_ACTION_CONFLICT' || code === 'BROWSER_ACTION_ALREADY_RESOLVED' ? 409 : 400
      return Response.json({ error: code }, { status })
    }
  }

  return Response.json({ error: 'Method Not Allowed' }, { status: 405 })
}
