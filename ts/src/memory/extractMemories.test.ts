/**
 * 回合末记忆抽取(后台兜底)行为对齐测试。
 * 硬闸:①主 agent 没写记忆 → 抽取 fork 后台跑、能把对话里的耐久事实存进记忆
 *       ②主 agent 这轮已调 save_memory → 节流跳过、不 fork(不浪费一整轮)
 *       ③env 关掉抽取 → 不 fork
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildGeneralRegistry } from '../tools/generalTools'
import { scriptedModel } from '../harness/fakeModel'
import { runAgentLoop } from '../harness/loop'
import { drainPendingExtraction, __resetExtractStateForTest } from './extractMemories'
import { getAutoMemDir } from '../harness/memoryNames'
import { scanMemoryFiles } from './relevantMemories'
import type { AgentEvent } from '../types/events'

let root: string
let configDir: string
let prev: Record<string, string | undefined> = {}
const ENV_KEYS = ['BILLIARDBUDDY_CONFIG_DIR', 'BILLIARDBUDDY_DISABLE_AUTO_MEMORY', 'BILLIARDBUDDY_DISABLE_MEMORY', 'BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT']

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-ext-'))
  configDir = mkdtempSync(join(tmpdir(), 'cfg-ext-'))
  for (const k of ENV_KEYS) prev[k] = process.env[k]
  process.env.BILLIARDBUDDY_CONFIG_DIR = configDir
  delete process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY
  delete process.env.BILLIARDBUDDY_DISABLE_MEMORY
  delete process.env.BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT
  __resetExtractStateForTest()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k]
    else process.env[k] = prev[k]
  }
  __resetExtractStateForTest()
})

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('主 agent 没写记忆 → 后台抽取 fork 跑、把对话里的耐久事实存进记忆', async () => {
  const workspace = new Workspace(root)
  // 主回合直接给最终答复(不写记忆);随后抽取 fork 调 save_memory 存下对话里的耐久事实。
  const model = scriptedModel([
    { kind: 'final', text: '好的,晚上黄金档我知道了。' },
    { kind: 'tool_calls', text: '把黄金档台费记下来', calls: [{ id: 'm1', name: 'save_memory', input: { name: 'golden_fee', description: '黄金档台费', type: 'project', content: '本店黄金档台费每小时 EXTRACT77 元。' } }] },
    { kind: 'final', text: '记好了。' },
  ])

  await collect(runAgentLoop({
    model,
    registry: buildGeneralRegistry(),
    workspace,
    systemPrompt: 'SYS',
    userMessage: '我们店黄金档台费是每小时 EXTRACT77 元。',
    conversationId: 'conv-ext-1',
  }))

  // 主回合只消费 1 步(memdir 空、无召回);抽取 fork 是 fire-and-forget,drain 等它跑完。
  await drainPendingExtraction('conv-ext-1')

  const headers = await scanMemoryFiles(getAutoMemDir(workspace.root))
  expect(headers.length).toBe(1)
  expect(headers[0]!.filename).toContain('golden_fee')
  // 主回合(1)+ 抽取 fork(save_memory 一步 + 收尾一步 = 2)= 3 次 model.step。
  expect(model.received.length).toBe(3)
})

test('主 agent 这轮已调 save_memory → 节流跳过、不 fork(不多打一整轮)', async () => {
  const workspace = new Workspace(root)
  // 主回合自己调了 save_memory,随后给最终答复;抽取应被节流,不再 fork。
  const model = scriptedModel([
    { kind: 'tool_calls', text: '记下来', calls: [{ id: 'a1', name: 'save_memory', input: { name: 'owner', description: '店主画像', type: 'user', content: '社区台球房店主。' } }] },
    { kind: 'final', text: '记好了。' },
  ])

  await collect(runAgentLoop({
    model,
    registry: buildGeneralRegistry(),
    workspace,
    systemPrompt: 'SYS',
    userMessage: '记一下我是社区台球房店主。',
    conversationId: 'conv-ext-2',
  }))
  await drainPendingExtraction('conv-ext-2')

  // 只有主回合的 2 步,没有额外的抽取 fork 步(节流生效)。
  expect(model.received.length).toBe(2)
  const headers = await scanMemoryFiles(getAutoMemDir(workspace.root))
  expect(headers.length).toBe(1) // 主 agent 自己写的那条,抽取没重复写。
})

test('BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT=1 → 不跑抽取兜底(召回仍可另开)', async () => {
  process.env.BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT = '1'
  const workspace = new Workspace(root)
  const model = scriptedModel([{ kind: 'final', text: '好的。' }])

  await collect(runAgentLoop({
    model,
    registry: buildGeneralRegistry(),
    workspace,
    systemPrompt: 'SYS',
    userMessage: '随便聊聊,我是店主。',
    conversationId: 'conv-ext-3',
  }))
  await drainPendingExtraction('conv-ext-3')

  expect(model.received.length).toBe(1) // 无抽取 fork。
  const headers = await scanMemoryFiles(getAutoMemDir(workspace.root))
  expect(headers.length).toBe(0)
})
