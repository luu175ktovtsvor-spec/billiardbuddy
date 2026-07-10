import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../types/message'
import { textBlock } from '../../types/message'
import type { ToolContext } from '../../tools/Tool'
import { Workspace } from '../../workspace/workspace'
import { loadFileHistory, recordFileSnapshot } from '../../tools/fileHistory'
import { runAgentLoop } from '../../harness/loop'
import { scriptedModel } from '../../harness/fakeModel'
import { buildGeneralRegistry } from '../../tools/generalTools'
import { SessionService, TurnRegistry } from './sessionService'
import { SessionRewindService } from './sessionRewindService'

async function collect(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ev of gen) { /* 只关心副作用(落盘/文件写入),不需要事件本身 */ }
}

let stateRoot: string
let workspaceRoot: string
let sessions: SessionService
let turns: TurnRegistry
let rewind: SessionRewindService

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'rewind-state-'))
  workspaceRoot = mkdtempSync(join(tmpdir(), 'rewind-ws-'))
  sessions = new SessionService(stateRoot)
  turns = new TurnRegistry()
  rewind = new SessionRewindService(sessions, turns, stateRoot)
})

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/** 造一个两轮会话:轮1 新建 note.txt(existed:false);轮2 改 note.txt(existed:true) + 新建 b.txt(existed:false)。 */
async function seedTwoTurnSession(sessionId: string): Promise<{ u1Uuid: string; u2Uuid: string }> {
  await sessions.create({ id: sessionId, title: '测试会话', workspaceRoot })
  const transcript = sessions.transcript(sessionId, workspaceRoot)

  const u1: Message = { role: 'user', content: [textBlock('u1')] }
  const a1: Message = { role: 'assistant', content: [textBlock('a1')], uuid: 'msg-a1' }
  const u2: Message = { role: 'user', content: [textBlock('u2')] }
  const a2: Message = { role: 'assistant', content: [textBlock('a2')], uuid: 'msg-a2' }
  await transcript.append([u1, a1, u2, a2])

  const ctx1: ToolContext = { workspace: new Workspace(workspaceRoot), conversationId: sessionId, stateRoot, messageId: 'msg-a1' }
  await recordFileSnapshot(ctx1, 'note.txt', join(workspaceRoot, 'note.txt'), 'write_file') // existed:false
  writeFileSync(join(workspaceRoot, 'note.txt'), 'v1\n')

  const ctx2: ToolContext = { ...ctx1, messageId: 'msg-a2' }
  await recordFileSnapshot(ctx2, 'note.txt', join(workspaceRoot, 'note.txt'), 'write_file') // existed:true, backup v1
  writeFileSync(join(workspaceRoot, 'note.txt'), 'v2\n')
  await recordFileSnapshot(ctx2, 'b.txt', join(workspaceRoot, 'b.txt'), 'write_file') // existed:false
  writeFileSync(join(workspaceRoot, 'b.txt'), 'B1\n')

  const history = await transcript.loadFullHistoryStamped()
  const u1Uuid = history.find(r => r.message.role === 'user' && r.message.content[0] && (r.message.content[0] as { text?: string }).text === 'u1')!.uuid
  const u2Uuid = history.find(r => r.message.role === 'user' && r.message.content[0] && (r.message.content[0] as { text?: string }).text === 'u2')!.uuid
  return { u1Uuid, u2Uuid }
}

describe('SessionRewindService.listTurnCheckpoints', () => {
  test('按轮次聚合 fileHistory 记录,没有变更的轮次跳过,数字对齐 diff', async () => {
    await seedTwoTurnSession('s-list')
    const checkpoints = await rewind.listTurnCheckpoints('s-list')
    expect(checkpoints.length).toBe(2)

    expect(checkpoints[0]!.target.userMessageIndex).toBe(0)
    expect(checkpoints[0]!.code.available).toBe(true)
    expect(checkpoints[0]!.code.filesChanged).toEqual([join(workspaceRoot, 'note.txt')])
    expect(checkpoints[0]!.code.insertions).toBe(1)
    expect(checkpoints[0]!.code.deletions).toBe(0)
    expect(checkpoints[0]!.workDir).toBe(workspaceRoot)

    expect(checkpoints[1]!.target.userMessageIndex).toBe(1)
    expect(checkpoints[1]!.code.filesChanged).toEqual([join(workspaceRoot, 'b.txt'), join(workspaceRoot, 'note.txt')])
    expect(checkpoints[1]!.code.insertions).toBe(2)
    expect(checkpoints[1]!.code.deletions).toBe(1)
  })

  test('没有 user 消息的会话返回空列表', async () => {
    await sessions.create({ id: 's-empty', title: '空会话', workspaceRoot })
    expect(await rewind.listTurnCheckpoints('s-empty')).toEqual([])
  })
})

describe('SessionRewindService.getSessionTurnCheckpointDiff(P1 补齐:单文件 diff)', () => {
  test('轮1 对 note.txt 的单文件 diff:从不存在到 v1(下一轮首条记录当后像)', async () => {
    const { u1Uuid } = await seedTwoTurnSession('s-diff-1')
    const result = await rewind.getSessionTurnCheckpointDiff('s-diff-1', { targetUserMessageId: u1Uuid }, join(workspaceRoot, 'note.txt'))
    expect(result.state).toBe('ok')
    expect(result.path).toBe(join(workspaceRoot, 'note.txt'))
    expect(result.workDir).toBe(workspaceRoot)
    expect(result.diff).toContain('+v1')
  })

  test('轮2 对 note.txt 的单文件 diff:从 v1 到当前盘上内容 v2(无下一轮,读盘上当前内容)', async () => {
    const { u2Uuid } = await seedTwoTurnSession('s-diff-2')
    // 传相对路径(不带 workspaceRoot 前缀)也要能正确归一定位到同一条记录。
    const result = await rewind.getSessionTurnCheckpointDiff('s-diff-2', { targetUserMessageId: u2Uuid }, 'note.txt')
    expect(result.state).toBe('ok')
    expect(result.diff).toContain('-v1')
    expect(result.diff).toContain('+v2')
  })

  test('轮1 对 b.txt(该轮完全没碰过)返回 missing', async () => {
    const { u1Uuid } = await seedTwoTurnSession('s-diff-3')
    const result = await rewind.getSessionTurnCheckpointDiff('s-diff-3', { targetUserMessageId: u1Uuid }, 'b.txt')
    expect(result.state).toBe('missing')
    expect(result.diff).toBeUndefined()
  })

  test('轮2 对 b.txt(该轮新建)的单文件 diff:从不存在到 B1', async () => {
    const { u2Uuid } = await seedTwoTurnSession('s-diff-4')
    const result = await rewind.getSessionTurnCheckpointDiff('s-diff-4', { targetUserMessageId: u2Uuid }, join(workspaceRoot, 'b.txt'))
    expect(result.state).toBe('ok')
    expect(result.diff).toContain('+B1')
  })

  test('回退目标无效时按 resolveTarget 规则抛错(与其余方法一致)', async () => {
    await seedTwoTurnSession('s-diff-5')
    await expect(rewind.getSessionTurnCheckpointDiff('s-diff-5', { userMessageIndex: 99 }, 'note.txt')).rejects.toThrow()
  })
})

describe('SessionRewindService.previewRewind', () => {
  test('预览回退到 u2:算出会改动的文件与 diff 统计,但不真的动文件', async () => {
    const { u2Uuid } = await seedTwoTurnSession('s-preview')
    const preview = await rewind.previewRewind('s-preview', { targetUserMessageId: u2Uuid })

    expect(preview.target.userMessageIndex).toBe(1)
    expect(preview.conversation.messagesRemoved).toBe(2) // u2 + a2
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([join(workspaceRoot, 'b.txt'), join(workspaceRoot, 'note.txt')])
    expect(preview.code.insertions).toBe(1)
    expect(preview.code.deletions).toBe(2)

    // 预览不改动实际文件
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v2\n')
    expect(existsSync(join(workspaceRoot, 'b.txt'))).toBe(true)
  })

  test('无 fileHistory 记录时 available:false', async () => {
    await sessions.create({ id: 's-nofh', title: '无快照会话', workspaceRoot })
    const transcript = sessions.transcript('s-nofh', workspaceRoot)
    const u1: Message = { role: 'user', content: [textBlock('u1')] }
    const a1: Message = { role: 'assistant', content: [textBlock('a1')] }
    await transcript.append([u1, a1])

    const preview = await rewind.previewRewind('s-nofh', { userMessageIndex: 0 })
    expect(preview.code.available).toBe(false)
    expect(preview.code.reason).toBe('No file checkpoints were recorded for this session.')
    expect(preview.code.filesChanged).toEqual([])
  })

  test('expectedContent 不匹配报错', async () => {
    const { u2Uuid } = await seedTwoTurnSession('s-expected')
    await expect(
      rewind.previewRewind('s-expected', { targetUserMessageId: u2Uuid, expectedContent: '不是 u2 的内容' }),
    ).rejects.toThrow()
  })

  test('userMessageIndex 越界报错', async () => {
    await seedTwoTurnSession('s-oob')
    await expect(rewind.previewRewind('s-oob', { userMessageIndex: 99 })).rejects.toThrow()
  })

  test('目标不是 user 消息报错', async () => {
    const { u1Uuid } = await seedTwoTurnSession('s-not-user')
    // msg-a1 是 assistant 消息的 uuid,不是 user
    await expect(rewind.previewRewind('s-not-user', { targetUserMessageId: 'msg-a1' })).rejects.toThrow()
    void u1Uuid
  })
})

describe('SessionRewindService 边界:同轮多次改同一文件 / skippedReason 记录', () => {
  test('同一轮内同一文件多次修改:恢复源取该轮最早一条记录的前像', async () => {
    await sessions.create({ id: 's-multi', title: '同轮多改', workspaceRoot })
    const transcript = sessions.transcript('s-multi', workspaceRoot)
    const u1: Message = { role: 'user', content: [textBlock('u1')] }
    const a1: Message = { role: 'assistant', content: [textBlock('a1')], uuid: 'mm-a1' }
    const u2: Message = { role: 'user', content: [textBlock('u2')] }
    const a2: Message = { role: 'assistant', content: [textBlock('a2')], uuid: 'mm-a2' }
    await transcript.append([u1, a1, u2, a2])

    writeFileSync(join(workspaceRoot, 'note.txt'), 'v1\n')
    const ctx: ToolContext = { workspace: new Workspace(workspaceRoot), conversationId: 's-multi', stateRoot, messageId: 'mm-a2' }
    // 轮 2 内连改两次:第一次前像 v1,第二次前像 v2
    await recordFileSnapshot(ctx, 'note.txt', join(workspaceRoot, 'note.txt'), 'write_file')
    writeFileSync(join(workspaceRoot, 'note.txt'), 'v2\n')
    await recordFileSnapshot(ctx, 'note.txt', join(workspaceRoot, 'note.txt'), 'edit_file')
    writeFileSync(join(workspaceRoot, 'note.txt'), 'v3\n')

    const history = await transcript.loadFullHistoryStamped()
    const u2Uuid = history.find(r => (r.message.content[0] as { text?: string })?.text === 'u2')!.uuid

    // 预览:diff(当前 v3, 最早前像 v1)= 1 增 1 删,只算一个文件(不因两条记录重复计数)
    const preview = await rewind.previewRewind('s-multi', { targetUserMessageId: u2Uuid })
    expect(preview.code.filesChanged).toEqual([join(workspaceRoot, 'note.txt')])
    expect(preview.code.insertions).toBe(1)
    expect(preview.code.deletions).toBe(1)

    // 执行:恢复到最早前像 v1(不是第二次记录的 v2)
    await rewind.executeRewind('s-multi', { targetUserMessageId: u2Uuid })
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v1\n')
  })

  test('skippedReason 记录(无真实备份):预览/恢复循环如实跳过、不抛错,其余文件正常恢复', async () => {
    await sessions.create({ id: 's-skip', title: '跳过快照', workspaceRoot })
    const transcript = sessions.transcript('s-skip', workspaceRoot)
    const u1: Message = { role: 'user', content: [textBlock('u1')] }
    const a1: Message = { role: 'assistant', content: [textBlock('a1')], uuid: 'sk-a1' }
    await transcript.append([u1, a1])

    const ctx: ToolContext = { workspace: new Workspace(workspaceRoot), conversationId: 's-skip', stateRoot, messageId: 'sk-a1' }
    // 正常记录:note.txt(existed:false,新建)
    await recordFileSnapshot(ctx, 'note.txt', join(workspaceRoot, 'note.txt'), 'write_file')
    writeFileSync(join(workspaceRoot, 'note.txt'), 'v1\n')
    // skippedReason 记录:目录不是普通文件,recordFileSnapshot 只记 'not a regular file'、不留备份内容
    mkdirSync(join(workspaceRoot, 'somedir'))
    const skipped = await recordFileSnapshot(ctx, 'somedir', join(workspaceRoot, 'somedir'), 'write_file')
    expect(skipped.skippedReason).toBe('not a regular file')

    const history = await transcript.loadFullHistoryStamped()
    const u1Uuid = history.find(r => r.message.role === 'user')!.uuid

    // 预览:skippedReason 的 path 不进 filesChanged(读不到可靠前像,不编数字)
    const preview = await rewind.previewRewind('s-skip', { targetUserMessageId: u1Uuid })
    expect(preview.code.available).toBe(true)
    expect(preview.code.filesChanged).toEqual([join(workspaceRoot, 'note.txt')])

    // 执行:不抛错;note.txt(existed:false)被删,somedir 原样保留
    await rewind.executeRewind('s-skip', { targetUserMessageId: u1Uuid })
    expect(existsSync(join(workspaceRoot, 'note.txt'))).toBe(false)
    expect(existsSync(join(workspaceRoot, 'somedir'))).toBe(true)
  })
})

describe('SessionRewindService.executeRewind', () => {
  test('真恢复文件内容,existed:false 的文件被删,transcript 活跃链正确掰短', async () => {
    const { u1Uuid, u2Uuid } = await seedTwoTurnSession('s-exec')
    const result = await rewind.executeRewind('s-exec', { targetUserMessageId: u2Uuid })

    // note.txt 恢复回 u2 之前的状态(v1);b.txt(u2 轮才新建)被删
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v1\n')
    expect(existsSync(join(workspaceRoot, 'b.txt'))).toBe(false)

    // 返回的 code 是恢复前算好的预览(与 previewRewind 同形数字),不是恢复后的(那样会变成全 0)
    expect(result.code.available).toBe(true)
    expect(result.code.insertions).toBe(1)
    expect(result.code.deletions).toBe(2)
    expect(result.conversation.removedMessageIds.length).toBe(2)
    expect(result.conversation.messagesRemoved).toBe(2)

    // transcript 活跃链掰短到 u1/a1
    const remaining = await sessions.transcript('s-exec', workspaceRoot).load()
    expect(remaining.map(m => m.role)).toEqual(['user', 'assistant'])
    expect((remaining[0]!.content[0] as { text?: string }).text).toBe('u1')

    // 会话状态回到 idle,且记了一条 context_note
    const meta = await sessions.get('s-exec')
    expect(meta?.status).toBe('idle')
    const events = await sessions.loadEvents('s-exec', { limit: 10 })
    expect(events.some(e => e.event.type === 'context_note')).toBe(true)
    void u1Uuid
  })
})

describe('端到端集成(F1 回归,非手工硬编码 messageId 的假阳性):真实 runAgentLoop 驱动两轮 → checkpoint 非空 → rewind 真恢复文件', () => {
  test('write_file 走真实 loop:fileHistory.messageId 绑定真实 transcript uuid,listTurnCheckpoints 非空,executeRewind 真的把文件内容改回去', async () => {
    const sessionId = 's-e2e-loop'
    await sessions.create({ id: sessionId, title: 'e2e', workspaceRoot })
    const transcript = sessions.transcript(sessionId, workspaceRoot)

    // 轮 1:真实 runAgentLoop 驱动 write_file 新建 note.txt(existed:false)。
    await collect(runAgentLoop({
      model: scriptedModel([
        { kind: 'tool_calls', text: '新建笔记', calls: [{ id: 'call-1', name: 'write_file', input: { path: 'note.txt', content: 'v1\n' } }] },
        { kind: 'final', text: '已创建' },
      ]),
      registry: buildGeneralRegistry(),
      workspace: new Workspace(workspaceRoot),
      systemPrompt: 'SYS',
      userMessage: '新建 note.txt',
      permissionMode: 'acceptEdits',
      conversationId: sessionId,
      stateRoot,
      transcript,
    }))
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v1\n')

    // 轮 2:同一 transcript 续跑,真实 runAgentLoop 驱动 write_file 改 note.txt(existed:true,备份 v1)。
    // write_file 覆盖已存在文件前要求先 read_file(assertFreshOverwrite 防止覆盖外部改动),故先读再写。
    await collect(runAgentLoop({
      model: scriptedModel([
        { kind: 'tool_calls', text: '先读一下', calls: [{ id: 'read-2', name: 'read_file', input: { path: 'note.txt' } }] },
        { kind: 'tool_calls', text: '改笔记', calls: [{ id: 'call-2', name: 'write_file', input: { path: 'note.txt', content: 'v2\n' } }] },
        { kind: 'final', text: '已修改' },
      ]),
      registry: buildGeneralRegistry(),
      workspace: new Workspace(workspaceRoot),
      systemPrompt: 'SYS',
      userMessage: '把 note.txt 改成 v2',
      permissionMode: 'acceptEdits',
      conversationId: sessionId,
      stateRoot,
      transcript,
    }))
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v2\n')

    // —— F1 回归断言:fileHistory 记录的 messageId 真的等于 transcript 里"发起那次 write_file 调用"的
    // assistant 消息 uuid ——此前 ctx.messageId 全仓从未被赋值,这里恒为 undefined;修复后必须真绑定到
    // 各自那一批 tool_calls 的 assistant uuid,不是像旧测试那样手工塞 `messageId: 'msg-a1'` 断言
    // "如果传对了逻辑对不对"这种假阳性。
    const history = await transcript.loadFullHistoryStamped()
    // 轮1(write call-1)+ 轮2(read read-2 → write call-2):共 3 批带 tool_use 的 assistant 消息。
    const assistantWithToolUse = history.filter(r => r.message.role === 'assistant' && r.message.content.some(b => b.type === 'tool_use'))
    expect(assistantWithToolUse.length).toBe(3)
    const uuidForToolCallId = (callId: string): string =>
      assistantWithToolUse.find(r => r.message.content.some(b => b.type === 'tool_use' && b.id === callId))!.uuid
    const write1Uuid = uuidForToolCallId('call-1')
    const write2Uuid = uuidForToolCallId('call-2')
    expect(write1Uuid).not.toBe(write2Uuid) // 两次 write_file 分属不同轮次/不同批,各自的 uuid 必须不同

    const ctx: ToolContext = { workspace: new Workspace(workspaceRoot), conversationId: sessionId, stateRoot }
    const records = await loadFileHistory(ctx)
    expect(records.length).toBe(2) // 只有 write_file 记 file-history,read_file 不记
    expect(records.every(r => r.messageId !== undefined)).toBe(true)
    // 按写入顺序:第一条 = 轮1的 write(existed:false),第二条 = 轮2的 write(existed:true)。
    expect(records[0]!.messageId).toBe(write1Uuid)
    expect(records[1]!.messageId).toBe(write2Uuid)

    // —— 下游回归:checkpoint 列表此前恒为 []([]是因为四处消费点全靠 messageId!==undefined 过滤)——
    const checkpoints = await rewind.listTurnCheckpoints(sessionId)
    expect(checkpoints.length).toBe(2)
    expect(checkpoints.every(c => c.code.available)).toBe(true)
    expect(checkpoints[1]!.code.filesChanged).toEqual([join(workspaceRoot, 'note.txt')])

    // —— rewind 真恢复文件内容:回退到第 2 轮之前,note.txt 应恢复回 v1(此前恒 available:false、恢复循环从未真正跑过)——
    const result = await rewind.executeRewind(sessionId, { userMessageIndex: 1 })
    expect(result.code.available).toBe(true)
    expect(readFileSync(join(workspaceRoot, 'note.txt'), 'utf8')).toBe('v1\n')
  })
})
