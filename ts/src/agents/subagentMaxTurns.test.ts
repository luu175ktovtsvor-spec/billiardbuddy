import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import { ToolRegistry } from '../tools/registry'
import type { Tool } from '../tools/Tool'
import type { AssistantStep } from '../types/model'
import { createAgentTaskTool } from './agentTool'
import type { AgentDefinition } from './agentLoader'
import { FORK_AGENT_MAX_TURNS } from './forkSubagent'

// 行为对齐:子代理 maxTurns 掰回 cc(runAgent.ts:756 `maxTurns ?? agentDefinition.maxTurns` +
// query.ts:1713 `if (maxTurns && ...)` = undefined 不截)。
// - general-purpose 无 frontmatter maxTurns → 传 undefined,不被旧的 `?? 8` 半路截断;
// - 有 frontmatter maxTurns 的照它;
// - fork = FORK_AGENT.maxTurns(cc forkSubagent.ts:65 = 200);
// - 命令 fork = 80(server/index.ts,归 loop 窗,本测只做源级守卫别让它漂)。

function agent(partial: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'general-purpose',
    description: '通用子代理',
    prompt: '通用研究/执行。',
    filePath: '/agents/general-purpose.md',
    tools: ['noop'],
    ...partial,
  }
}

const noopTool: Tool = {
  name: 'noop',
  description: '空操作,永远成功',
  inputSchema: { type: 'object' },
  isReadOnly: true,
  async execute() {
    return 'ok'
  },
}

/** n 个 tool_calls 回合(每回合调 noop)后接一个自然收尾的 final。总步数 = n + 1。 */
function convergingSteps(nToolTurns: number, finalText: string): AssistantStep[] {
  const steps: AssistantStep[] = []
  for (let i = 0; i < nToolTurns; i++) {
    steps.push({ kind: 'tool_calls', calls: [{ id: `t${i}`, name: 'noop', input: {} }] })
  }
  steps.push({ kind: 'final', text: finalText })
  return steps
}

test('general-purpose 子代理无 frontmatter maxTurns → 不被 8 轮截断(自然跑到第 10 轮收尾)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-maxturns-gp-'))
  try {
    // 9 个工具回合(turn 0..8)后第 10 步自然收尾;旧的 `?? 8` 会在第 8 轮强制收尾、拿不到这句。
    const model = scriptedModel(convergingSteps(9, '子代理跑满多轮后自然收尾'))
    const tool = createAgentTaskTool({
      agents: [agent()], // 无 maxTurns frontmatter
      model,
      baseTools: [noopTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '多步研究' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    // 自然收敛到第 10 步(9 工具步 + 1 final),没有被强制收尾兜底文案替换。
    expect(out).toContain('子代理跑满多轮后自然收尾')
    expect(out).not.toContain('已达最大轮次')
    expect(model.received.length).toBe(10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('有 frontmatter maxTurns 的子代理照它截断(maxTurns=2,不被放大到 8)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'subagent-maxturns-fm-'))
  try {
    // 3 工具回合 + final:若 cap=2 则第 2 轮后强制收尾(拿不到 final);若 cap>=3 才自然收敛。
    const model = scriptedModel(convergingSteps(3, '不该到这:cap 被放大了'))
    const tool = createAgentTaskTool({
      agents: [agent({ maxTurns: 2 })],
      model,
      baseTools: [noopTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '受限步数' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    // cap=2:2 个工具步(turn 0,1)后命中 maxTurns → loop 只 yield max_turns_reached 后 return,共 2 次 model.step;
    // 不再强制多打一步无工具收尾。子代理拿不到 final,最终答复由调用方(agentTool)兜底合成 '已达最大轮次,未能收敛。'。
    expect(model.received.length).toBe(2)
    expect(out).toContain('已达最大轮次,未能收敛')
    expect(out).not.toContain('不该到这')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fork 子代理用 FORK_AGENT.maxTurns=200,不被 8 轮截断', async () => {
  // 先锁常量本身对齐 cc forkSubagent.ts:65。
  expect(FORK_AGENT_MAX_TURNS).toBe(200)

  const root = mkdtempSync(join(tmpdir(), 'subagent-maxturns-fork-'))
  try {
    // fork 子代理跑同样 9 工具回合后收尾;fork agent 合成 maxTurns=200 → 不在第 8 轮被截。
    const forkChildModel = scriptedModel(convergingSteps(9, 'fork 子代理跑满多轮后收尾'))
    const tool = createAgentTaskTool({
      agents: [agent({ name: 'researcher' })],
      model: forkChildModel,
      baseTools: [noopTool],
      sidechainRoot: join(root, 'sidechains'),
      env: {}, // 关掉隐式 fork gate,走显式 fork_context 同步路径
    })

    const out = await tool.execute({ task: '继承父上下文的 fork 活', fork_context: true }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      systemPrompt: 'PARENT SYS',
      registry: new ToolRegistry([noopTool]),
    })

    expect(out).toContain('fork 子代理跑满多轮后收尾')
    expect(out).not.toContain('已达最大轮次')
    expect(forkChildModel.received.length).toBe(10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('命令 fork worker 维持 maxTurns=80(server/index.ts 源级守卫,别漂到 8)', () => {
  // 命令/技能 fork worker 的 maxTurns 落在 server/index.ts(归 loop 窗),这里只做源级锁,不改那文件。
  const serverSource = readFileSync(join(import.meta.dir, '..', 'server', 'index.ts'), 'utf8')
  expect(serverSource).toContain('maxTurns: 80')
})
