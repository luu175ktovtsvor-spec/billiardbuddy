import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('legacy Core-session REST routes, including special handlers, stay retired', async () => {
  const requests = [
    ['GET', '/api/sessions'],
    ['POST', '/api/sessions'],
    ['POST', '/api/sessions/batch-delete'],
    ['GET', '/api/sessions/recent-projects?limit=20'],
    ['GET', '/api/sessions/repository-context?workDir=%2Ftmp%2Fproject'],
    ['GET', '/api/sessions/session-1'],
    ['PATCH', '/api/sessions/session-1'],
    ['DELETE', '/api/sessions/session-1'],
    ['GET', '/api/sessions/session-1/messages'],
    ['GET', '/api/sessions/session-1/git-info'],
    ['GET', '/api/sessions/session-1/workspace/status'],
    ['GET', '/api/sessions/session-1/workspace/tree?path=src'],
    ['GET', '/api/sessions/session-1/workspace/file?path=src%2Findex.ts'],
    ['GET', '/api/sessions/session-1/workspace/diff?path=src%2Findex.ts'],
    ['GET', '/api/sessions/session-1/turn-checkpoints'],
    ['GET', '/api/sessions/session-1/turn-checkpoints/diff?targetUserMessageId=user-1&path=src%2Findex.ts'],
    ['POST', '/api/sessions/session-1/rewind'],
    ['GET', '/api/sessions/session-1/slash-commands'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)
    expect(response.status).toBe(404)
  }
})
