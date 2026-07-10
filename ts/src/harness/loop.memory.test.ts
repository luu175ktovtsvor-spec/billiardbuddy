/**
 * 记忆三缺口·端到端行为对齐测试(对齐 cc 召回 + 读回)。
 * 硬闸:写进记忆 → 下一轮作答确实召回、把该主题正文作 <system-reminder> 注入,主模型看得到。
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildGeneralRegistry } from '../tools/generalTools'
import { scriptedModel } from './fakeModel'
import { runAgentLoop } from './loop'
import type { AgentEvent } from '../types/events'
import type { AssistantStep } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import { saveMemoryTool } from '../tools/saveMemoryTool'
import { getAutoMemDir } from './memoryNames'
import { scanMemoryFiles } from '../memory/relevantMemories'

let root: string
let configDir: string
let prevConfig: string | undefined
let prevDisableAuto: string | undefined
let prevDisableMem: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-mem-'))
  configDir = mkdtempSync(join(tmpdir(), 'cfg-mem-'))
  prevConfig = process.env.BILLIARDBUDDY_CONFIG_DIR
  prevDisableAuto = process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY
  prevDisableMem = process.env.BILLIARDBUDDY_DISABLE_MEMORY
  process.env.BILLIARDBUDDY_CONFIG_DIR = configDir
  delete process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY
  delete process.env.BILLIARDBUDDY_DISABLE_MEMORY
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  if (prevConfig === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
  else process.env.BILLIARDBUDDY_CONFIG_DIR = prevConfig
  if (prevDisableAuto === undefined) delete process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY
  else process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY = prevDisableAuto
  if (prevDisableMem === undefined) delete process.env.BILLIARDBUDDY_DISABLE_MEMORY
  else process.env.BILLIARDBUDDY_DISABLE_MEMORY = prevDisableMem
})

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('write memory via save_memory, then next turn recalls it and injects the body', async () => {
  const workspace = new Workspace(root)
  const ctx = { workspace } as unknown as ToolContext

  // 1) 模型上一轮写下的记忆(带独特标记 TESTFEE88,便于断言正文被注入)。
  const saveResult = await saveMemoryTool.execute(
    { name: 'golden_hours', description: '黄金档台费与时段', type: 'project', content: '本店黄金档(晚7点-11点)台费每小时 TESTFEE88 元。' },
    ctx,
  )
  expect(saveResult).toContain('已记住')

  const memdir = getAutoMemDir(workspace.root)
  const headers = await scanMemoryFiles(memdir)
  expect(headers.length).toBe(1)
  const filename = headers[0]!.filename // e.g. golden_hours.md

  // 2) 下一轮:step0 = 侧路小模型选中该记忆;step1 = 最终答复。
  const steps: AssistantStep[] = [
    { kind: 'final', text: `["${filename}"]` },
    { kind: 'final', text: '好的,黄金档台费我记得。' },
  ]
  const model = scriptedModel(steps)

  const events = await collect(runAgentLoop({
    model,
    registry: buildGeneralRegistry(),
    workspace,
    systemPrompt: 'SYS',
    userMessage: '今晚黄金档台费定多少合适?',
  }))

  // 侧路选择 + 真回合 = 两次 model.step。
  expect(model.received.length).toBe(2)
  // 真回合(第 2 次)的消息里,应包含被召回记忆的正文与去重标记。
  const realTurnMessages = JSON.stringify(model.received[1]!.messages)
  expect(realTurnMessages).toContain('TESTFEE88')
  expect(realTurnMessages).toContain('<recalled-memory')
  // 用户可见到一条召回提示。
  expect(events.some(e => e.type === 'context_note' && e.text.includes('召回'))).toBe(true)
  // 最终答复照常收敛。
  expect(events.some(e => e.type === 'final')).toBe(true)
})

test('no recall when memdir empty (no extra model.step, back-compat)', async () => {
  const workspace = new Workspace(root)
  const model = scriptedModel([{ kind: 'final', text: '你好' }])
  await collect(runAgentLoop({
    model,
    registry: buildGeneralRegistry(),
    workspace,
    systemPrompt: 'SYS',
    userMessage: '随便聊聊',
  }))
  // memdir 为空 → 不召回、不多打一次侧路查询。
  expect(model.received.length).toBe(1)
})

test('read-back carve-out: workspace with memdir in allowedPaths can resolve a read inside it', async () => {
  const workspace = new Workspace(root)
  const ctx = { workspace } as unknown as ToolContext
  await saveMemoryTool.execute(
    { name: 'owner_profile', description: '店主画像', type: 'user', content: '社区台球房店主。' },
    ctx,
  )
  const memdir = getAutoMemDir(workspace.root)
  // 主 agent 读放行:把 memdir 加进 allowedPaths(server workspaceFromBody 的 carve-out),
  // 模型即可 read_file/grep 读回自己写的记忆(memdir 在工作区之外)。
  const guarded = new Workspace(root, { allowedPaths: [memdir] })
  const memFile = join(memdir, 'owner_profile.md')
  expect(() => guarded.resolve(memFile, 'read')).not.toThrow()
  // 未放行时读工作区外的 memdir 应被拦。
  const unguarded = new Workspace(root)
  expect(() => unguarded.resolve(memFile, 'read')).toThrow()
})
