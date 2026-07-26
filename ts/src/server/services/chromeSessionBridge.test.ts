import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { ChromeSessionBridge } from './chromeSessionBridge.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-browser-'))
  roots.push(root)
  let now = new Date('2026-07-26T08:00:00.000Z')
  const scheduler = new ProductResourceScheduler({
    statePath: path.join(root, 'scheduler.json'),
    now: () => now,
    processId: 'test',
    processGeneration: 'test-generation',
  })
  const descriptorPath = path.join(root, 'native-bridge.json')
  const bridge = new ChromeSessionBridge({
    statePath: path.join(root, 'actions.json'),
    descriptorPath,
    scheduler,
    now: () => now,
  })
  await bridge.activate('http://127.0.0.1:4567')
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8')) as { token: string; endpoint: string }
  const sync = (payload: Record<string, unknown>) => bridge.handleNativeSync(descriptor.token, {
    protocol_version: 1,
    type: 'sync',
    session_id: 'browser_session_1234',
    ...payload,
  })
  const page = {
    page_revision: 'page_revision_1234',
    url: 'https://www.zhipin.com/web/geek/recommend',
    title: '候选人推荐',
    candidates: [{
      candidate_ref: 'candidate_ref_1234',
      display_name: '示例候选人',
      headline: '台球助教',
      experience_summary: '两年门店服务经验',
      skills: ['客户接待', '基础教学'],
    }],
  }
  return { bridge, descriptor, scheduler, sync, page, advance(ms: number) { now = new Date(now.getTime() + ms) } }
}

describe('ChromeSessionBridge', () => {
  it('exposes only job-relevant evidence and rejects undeclared protected fields', async () => {
    const { bridge, sync, page } = await fixture()
    await sync({ page })
    expect(bridge.status()).toMatchObject({ state: 'connected', connected_sessions: 1 })
    expect(bridge.listPages()).toEqual([{
      session_id: 'browser_session_1234',
      page_revision: 'page_revision_1234',
      url: page.url,
      title: page.title,
      captured_at: '2026-07-26T08:00:00.000Z',
      candidates: [{
        candidate_ref: 'candidate_ref_1234',
        headline: '台球助教',
        experience_summary: '两年门店服务经验',
        skills: ['客户接待', '基础教学'],
      }],
    }])
    await expect(sync({
      page: {
        ...page,
        candidates: [{ ...page.candidates[0], gender: '女' }],
      },
    })).rejects.toThrow('BROWSER_NATIVE_INVALID')
  })

  it('requires a task-scoped human confirmation before one fenced dispatch', async () => {
    const { bridge, sync, page, scheduler } = await fixture()
    await sync({ page })
    const prepared = await bridge.prepareAction('product_task_1234', {
      session_id: 'browser_session_1234',
      page_revision: 'page_revision_1234',
      candidate_ref: 'candidate_ref_1234',
      kind: 'send_message',
      message: '你好，想邀请你聊聊门店助教岗位。',
      client_operation_id: 'client_operation_1234',
    })
    expect(prepared).toMatchObject({ state: 'awaiting_confirmation', revision: 0, target_label: '示例候选人' })
    await expect(bridge.purgeTaskActions('product_task_1234')).rejects.toThrow('BROWSER_ACTION_ACTIVE')
    expect(await sync({})).toEqual({ ok: true, acknowledged_operation_ids: [] })
    expect(await bridge.getAction('other_task_1234', prepared.id)).toBeUndefined()

    const approved = await bridge.resolveAction('product_task_1234', prepared.id, 0, true)
    expect(approved.state).toBe('dispatching')
    const dispatched = await sync({})
    expect(dispatched.command).toMatchObject({
      operation_id: prepared.id,
      action: 'send_message',
      candidate_ref: 'candidate_ref_1234',
      message: '你好，想邀请你聊聊门店助教岗位。',
    })
    expect((await sync({})).command).toBeUndefined()

    const result = {
      operation_id: prepared.id,
      command_id: dispatched.command!.command_id,
      outcome: 'succeeded',
    }
    expect(await sync({ results: [result] })).toMatchObject({ acknowledged_operation_ids: [prepared.id] })
    expect((await bridge.getAction('product_task_1234', prepared.id))?.state).toBe('succeeded')
    expect(await sync({ results: [result] })).toMatchObject({ acknowledged_operation_ids: [prepared.id] })
    await bridge.purgeTaskActions('product_task_1234')
    expect(await bridge.listActions('product_task_1234')).toEqual([])
    expect(await scheduler.hasBlockingOwnerJobs('product_task_1234')).toBeFalse()
  })

  it('replays the same prepared action and fails closed when the page revision changed', async () => {
    const { bridge, sync, page } = await fixture()
    await sync({ page })
    const input = {
      session_id: 'browser_session_1234',
      page_revision: 'page_revision_1234',
      candidate_ref: 'candidate_ref_1234',
      kind: 'invite' as const,
      client_operation_id: 'client_operation_5678',
    }
    const first = await bridge.prepareAction('product_task_1234', input)
    expect(await bridge.prepareAction('product_task_1234', input)).toEqual(first)
    await sync({ page: { ...page, page_revision: 'page_revision_5678' } })
    const resolved = await bridge.resolveAction('product_task_1234', first.id, 0, true)
    expect(resolved).toMatchObject({ state: 'failed', failure_code: 'BROWSER_PAGE_STALE' })
    expect((await sync({})).command).toBeUndefined()
  })

  it('does not retry an unacknowledged side effect and accepts its late exact result', async () => {
    const { bridge, sync, page, advance } = await fixture()
    await sync({ page })
    const prepared = await bridge.prepareAction('product_task_1234', {
      session_id: 'browser_session_1234',
      page_revision: 'page_revision_1234',
      candidate_ref: 'candidate_ref_1234',
      kind: 'reject',
      client_operation_id: 'client_operation_9012',
    })
    await bridge.resolveAction('product_task_1234', prepared.id, 0, true)
    const dispatched = await sync({})
    advance(60_001)

    expect(await bridge.getAction('product_task_1234', prepared.id)).toMatchObject({
      state: 'outcome_unknown',
      failure_code: 'BROWSER_RESULT_TIMEOUT',
    })
    expect((await sync({})).command).toBeUndefined()

    expect(await sync({ results: [{
      operation_id: prepared.id,
      command_id: dispatched.command!.command_id,
      outcome: 'succeeded',
    }] })).toMatchObject({ acknowledged_operation_ids: [prepared.id] })
    expect(await bridge.getAction('product_task_1234', prepared.id)).toMatchObject({ state: 'succeeded' })
    expect((await bridge.getAction('product_task_1234', prepared.id))?.failure_code).toBeUndefined()
  })
})
