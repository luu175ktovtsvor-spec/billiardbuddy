import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { userText } from '../../types/message'
import { SessionService, TurnRegistry } from './sessionService'

test('SessionService:create/list/touch/get 持久化 metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-'))
  try {
    const svc = new SessionService(root)
    const created = await svc.create({ id: 's1', title: '第一轮', workspaceRoot: '/tmp/ws' })
    expect(created.id).toBe('s1')
    expect(await svc.get('s1')).toMatchObject({ title: '第一轮', workspaceRoot: '/tmp/ws' })
    await svc.touch('s1', { title: '更新后' })
    expect((await svc.list())[0]).toMatchObject({ id: 's1', title: '更新后' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:list 按 workspaceRoot 过滤 + recentProjects 按项目聚合', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-proj-'))
  try {
    const svc = new SessionService(root)
    await svc.create({ id: 'a1', title: 'A1', workspaceRoot: '/ws/a' })
    await svc.create({ id: 'a2', title: 'A2', workspaceRoot: '/ws/a' })
    await svc.create({ id: 'b1', title: 'B1', workspaceRoot: '/ws/b' })
    expect((await svc.list({ workspaceRoot: '/ws/a' })).map(m => m.id).sort()).toEqual(['a1', 'a2'])
    expect((await svc.list()).length).toBe(3)
    const projects = await svc.recentProjects()
    expect(projects.length).toBe(2)
    expect(projects.find(p => p.workspaceRoot === '/ws/a')?.sessionCount).toBe(2)
    expect(projects.find(p => p.workspaceRoot === '/ws/b')?.sessionCount).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:fork 用新 id 拷贝源会话 transcript,源不受影响,源不存在报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-fork-'))
  try {
    const svc = new SessionService(root)
    await svc.create({ id: 'src', title: '原会话', workspaceRoot: '/ws/x' })
    await svc.transcript('src').save([userText('历史消息1'), userText('历史消息2')])
    const forked = await svc.fork('src', { title: '分叉' })
    expect(forked.id).not.toBe('src')
    expect(forked.workspaceRoot).toBe('/ws/x')
    expect(forked.title).toBe('分叉')
    expect((await svc.transcript(forked.id).load()).length).toBe(2)
    expect((await svc.transcript('src').load()).length).toBe(2) // 源不受影响
    await expect(svc.fork('missingsession')).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:坏 index 安全退空,非法 id 拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-bad-'))
  try {
    writeFileSync(join(root, 'sessions.json'), 'not-json')
    const svc = new SessionService(root)
    expect(await svc.list()).toEqual([])
    await expect(svc.get('../bad')).rejects.toThrow('非法 session id')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:Transcript 走同一 root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-transcript-'))
  try {
    const svc = new SessionService(root)
    await svc.transcript('s1').save([userText('hi')])
    expect(await svc.loadTranscript('s1')).toEqual([userText('hi')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:events JSONL append/replay supports after and bad-line recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-events-'))
  try {
    const svc = new SessionService(root)
    await svc.create({ id: 's1', title: '事件会话', workspaceRoot: root })
    const first = await svc.appendEvent('s1', { type: 'thinking', text: '想一下' })
    const second = await svc.appendEvent('s1', { type: 'final', text: '完成' })
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(await svc.get('s1')).toMatchObject({ lastEventSeq: 2 })

    writeFileSync(svc.eventPath('s1'), 'bad-json\n', { flag: 'a' })
    expect((await svc.loadEvents('s1')).map(e => e.seq)).toEqual([1, 2])
    expect((await svc.loadEvents('s1', { after: 1 })).map(e => e.event.type)).toEqual(['final'])
    expect((await svc.loadEvents('s1', { limit: 1 })).map(e => e.seq)).toEqual([1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:appendEvent uses metadata seq before scanning event log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-events-meta-'))
  try {
    const svc = new SessionService(root)
    await svc.create({ id: 's1', title: '事件会话', workspaceRoot: root })
    await svc.touch('s1', { lastEventSeq: 99 })
    mkdirSync(join(root, 'events'), { recursive: true })
    writeFileSync(
      svc.eventPath('s1'),
      `${JSON.stringify({ seq: 3, ts: new Date().toISOString(), event: { type: 'thinking', text: 'old' } })}\n`,
    )

    const next = await svc.appendEvent('s1', { type: 'final', text: '完成' })
    expect(next.seq).toBe(100)
    expect(await svc.get('s1')).toMatchObject({ lastEventSeq: 100 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:appendEvent falls back to event log for legacy metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-events-legacy-'))
  try {
    const timestamp = new Date().toISOString()
    mkdirSync(join(root, 'events'), { recursive: true })
    writeFileSync(join(root, 'sessions.json'), `${JSON.stringify({
      sessions: [{
        id: 's1',
        title: '旧事件会话',
        workspaceRoot: root,
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
    })}\n`)
    const svc = new SessionService(root)
    writeFileSync(
      svc.eventPath('s1'),
      [
        JSON.stringify({ seq: 1, ts: timestamp, event: { type: 'thinking', text: 'old 1' } }),
        'bad-json',
        JSON.stringify({ seq: 7, ts: timestamp, event: { type: 'final', text: 'old 7' } }),
        '',
      ].join('\n'),
    )

    const next = await svc.appendEvent('s1', { type: 'final', text: '完成' })
    expect(next.seq).toBe(8)
    expect(await svc.get('s1')).toMatchObject({ lastEventSeq: 8 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SessionService:touch can mark turn status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessions-status-'))
  try {
    const svc = new SessionService(root)
    await svc.touch('s1', { title: '状态会话', workspaceRoot: root, status: 'running' })
    expect(await svc.get('s1')).toMatchObject({ id: 's1', status: 'running' })
    await svc.touch('s1', { status: 'interrupted' })
    expect(await svc.get('s1')).toMatchObject({ status: 'interrupted' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TurnRegistry:同 session 新 turn 会中断旧 turn,finish 只清自己的 controller', () => {
  const reg = new TurnRegistry()
  const c1 = reg.start('s1')
  const c2 = reg.start('s1')
  expect(c1.signal.aborted).toBe(true)
  expect(c2.signal.aborted).toBe(false)
  reg.finish('s1', c1)
  expect(reg.interrupt('s1')).toBe(true)
  expect(c2.signal.aborted).toBe(true)
  expect(reg.interrupt('s1')).toBe(false)
})
