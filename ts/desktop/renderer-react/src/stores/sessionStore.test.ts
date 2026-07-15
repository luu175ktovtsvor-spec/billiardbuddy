import { afterEach, expect, test } from 'bun:test'
import { getBaseUrl, setBaseUrl } from '../api/client'
import { useSessionStore } from './sessionStore'

const originalBaseUrl = getBaseUrl()

afterEach(() => {
  setBaseUrl(originalBaseUrl)
  useSessionStore.setState({ sessions: [], loading: false, deletingIds: [], archiveBusyIds: [] })
})

test('sessionStore:归档和删除只在服务端成功后更新本地状态', async () => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const url = new URL(request.url)
      const body = request.method === 'PATCH' ? await request.json() : undefined
      requests.push({ method: request.method, path: url.pathname, body })
      if (url.pathname === '/sessions/delete-fails') return Response.json({ error: 'failed' }, { status: 500 })
      if (request.method === 'PATCH') return Response.json({ session: { archived: (body as { archived: boolean }).archived } })
      if (request.method === 'DELETE') return Response.json({ ok: true })
      return Response.json({ sessions: [] })
    },
  })
  setBaseUrl(`http://127.0.0.1:${server.port}`)
  useSessionStore.setState({
    sessions: [
      { id: 'kept', title: 'Keep', updatedAt: 1 },
      { id: 'delete-fails', title: 'Keep on failure', updatedAt: 2, archived: true },
    ],
    deletingIds: [],
    archiveBusyIds: [],
  })

  try {
    expect(await useSessionStore.getState().setArchived('kept', true)).toBe(true)
    expect(useSessionStore.getState().sessions.find(session => session.id === 'kept')?.archived).toBe(true)

    expect(await useSessionStore.getState().removeSession('delete-fails')).toBe(false)
    expect(useSessionStore.getState().sessions.some(session => session.id === 'delete-fails')).toBe(true)

    expect(await useSessionStore.getState().removeSession('kept')).toBe(true)
    expect(useSessionStore.getState().sessions.some(session => session.id === 'kept')).toBe(false)
    expect(requests).toEqual(expect.arrayContaining([
      { method: 'PATCH', path: '/sessions/kept', body: { archived: true } },
      { method: 'DELETE', path: '/sessions/delete-fails', body: undefined },
      { method: 'DELETE', path: '/sessions/kept', body: undefined },
    ]))
  } finally {
    server.stop(true)
  }
})
