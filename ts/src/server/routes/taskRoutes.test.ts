import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from '../../tasks/taskService'
import { createTaskRouteHandler } from './taskRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'task-routes-'))
  roots.push(root)
  const tasks = new TaskService(root)
  const handler = createTaskRouteHandler({ tasks })
  return { root, tasks, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createTaskRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('task routes', () => {
  test('ignores unrelated and invalid task paths while preserving method errors', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/tasks/bad.id'), request('/tasks/bad.id'))).toBeNull()
    expect(await handler(new URL('http://127.0.0.1/tasks/valid/unknown'), request('/tasks/valid/unknown'))).toBeNull()

    expect((await route(handler, '/tasks', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/tasks/valid', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/tasks/valid/events', { method: 'POST' })).status).toBe(405)
    expect((await route(handler, '/tasks/valid/cancel')).status).toBe(405)
    expect((await route(handler, '/tasks/valid/background')).status).toBe(405)
  })

  test('lists tasks with conversation, status and limit filters', async () => {
    const { tasks, handler } = createHarness()
    const completed = await tasks.create({ id: 'completed', title: 'completed', conversationId: 'conv-a' })
    await tasks.touch(completed.id, { status: 'completed' })
    const running = await tasks.create({ id: 'running', title: 'running', conversationId: 'conv-a' })
    await tasks.touch(running.id, { status: 'running' })
    const other = await tasks.create({ id: 'other', title: 'other', conversationId: 'conv-b' })
    await tasks.touch(other.id, { status: 'running' })

    const filtered = await (await route(handler, '/tasks?conversationId=conv-a&status=running&limit=1')).json() as { tasks: Array<{ id: string }> }
    expect(filtered.tasks.map(task => task.id)).toEqual(['running'])

    const invalidStatus = await (await route(handler, '/tasks?conversationId=conv-a&status=unknown&limit=bad')).json() as { tasks: Array<{ id: string }> }
    expect(invalidStatus.tasks.map(task => task.id).sort()).toEqual(['completed', 'running'])
  })

  test('resolves resumed descendants and stable agent ids for details and events', async () => {
    const { tasks, handler } = createHarness()
    const original = await tasks.create({
      id: 'chain_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'chain-conv',
      params: { agent: 'researcher', name: 'chain-name', task: 'initial' },
    })
    await tasks.touch(original.id, { status: 'completed', result: 'old result' })
    await tasks.appendEvent(original.id, { type: 'final', text: 'old result' })
    const latest = await tasks.create({
      id: 'chain_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'chain-conv',
      params: { agent_id: 'stable_agent', agent: 'researcher', name: 'chain-name', task: 'resumed', resumed_from: original.id },
    })
    await tasks.touch(latest.id, { status: 'completed', result: 'latest result' })
    await tasks.appendEvent(latest.id, { type: 'thinking', text: 'latest thinking' })
    await tasks.appendEvent(latest.id, { type: 'final', text: 'latest result' })

    const listed = await (await route(handler, '/tasks?conversationId=chain-conv')).json() as { tasks: Array<{ id: string }> }
    expect(listed.tasks.map(task => task.id)).toEqual([latest.id])

    const detail = await (await route(handler, `/tasks/${original.id}?includeEvents=1`)).json() as any
    expect(detail).toMatchObject({
      requestedTaskId: original.id,
      resolvedTaskId: latest.id,
      agentId: 'stable_agent',
      task: { id: latest.id },
    })
    expect(detail.events.map((record: any) => record.event.text)).toEqual(['latest thinking', 'latest result'])

    const events = await (await route(handler, `/tasks/${original.id}/events?after=1&limit=1`)).json() as any
    expect(events).toMatchObject({
      requestedTaskId: original.id,
      resolvedTaskId: latest.id,
      agentId: 'stable_agent',
      nextSeq: 2,
    })
    expect(events.events.map((record: any) => record.event.text)).toEqual(['latest result'])

    const byStableId = await (await route(handler, '/tasks/stable_agent?includeEvents=1')).json() as any
    expect(byStableId).toMatchObject({ requestedTaskId: 'stable_agent', resolvedTaskId: latest.id, task: { id: latest.id } })
    expect(byStableId.events.map((record: any) => record.event.text)).toEqual(['latest thinking', 'latest result'])
  })

  test('keeps missing-task responses and empty event cursors compatible', async () => {
    const { tasks, handler } = createHarness()
    expect((await route(handler, '/tasks/missing')).status).toBe(404)
    expect((await route(handler, '/tasks/missing/events')).status).toBe(404)

    await tasks.create({ id: 'empty', title: 'empty' })
    const events = await (await route(handler, '/tasks/empty/events?after=7&limit=1')).json()
    expect(events).toEqual({ events: [], nextSeq: 7 })
    const malformed = await (await route(handler, '/tasks/empty/events?after=bad&limit=bad')).json()
    expect(malformed).toEqual({ events: [], nextSeq: 0 })
  })

  test('cancels the latest running task through its stable agent id', async () => {
    const { tasks, handler } = createHarness()
    const task = await tasks.create({
      id: 'running_task',
      title: 'running task',
      kind: 'background_agent',
      params: { agent_id: 'running_agent', agent: 'researcher' },
    })
    tasks.start(task.id, async ({ signal }) => {
      if (signal.aborted) return
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    })

    const response = await route(handler, '/tasks/running_agent/cancel', { method: 'POST' })
    expect(await response.json()).toEqual({ ok: true, cancelled: true, taskId: task.id, requestedTaskId: 'running_agent' })
    expect(await tasks.get(task.id)).toMatchObject({ status: 'cancelled' })

    expect(await (await route(handler, '/tasks/missing/cancel', { method: 'POST' })).json()).toEqual({
      ok: true,
      cancelled: false,
      taskId: 'missing',
    })
  })

  test('backgrounds a registered foreground agent once and fails closed afterwards', async () => {
    const { tasks, handler } = createHarness()
    const registration = await tasks.registerForegroundAgent({
      taskId: 'foreground_task',
      agentId: 'foreground_agent',
      agent: 'researcher',
      title: 'foreground task',
    })

    const response = await route(handler, '/tasks/foreground_task/background', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      agentId: 'foreground_agent',
      task: { id: 'foreground_task', status: 'running', stage: '已切换到后台运行' },
    })
    await registration.backgroundSignal

    expect((await route(handler, '/tasks/foreground_task/background', { method: 'POST' })).status).toBe(404)
    expect((await route(handler, '/tasks/missing/background', { method: 'POST' })).status).toBe(404)
  })
})
