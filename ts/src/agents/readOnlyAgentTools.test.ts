import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadAgentsDir, resolveAgentTools } from './agentLoader'
import { buildGeneralRegistry } from '../tools/generalTools'

/**
 * 防再犯守卫(对应审计 15-memory.md F2a):`Explore`/`Plan` 等内置子代理在自己 prompt 里白纸黑字
 * 自称 "READ-ONLY MODE / STRICTLY PROHIBITED from file modifications",但工具收紧只靠手写的
 * `disallowedTools` 名单——名单曾经漏掉 `save_memory`(一等公民写盘工具,cc 没有对应物,靠模型自觉
 * 抄不到 cc 现成的黑名单),导致"只读"子代理实际仍可写盘。
 *
 * 这里不针对某个工具名断言,而是遍历**真实生产工具注册表**(`buildGeneralRegistry()`,agent_task 装配
 * 子代理工具集时用的同一个函数),对每个自称 READ-ONLY 的内置子代理跑 `resolveAgentTools`,断言解出来的
 * 工具集里不存在"非只读"工具。以后任何人加新写盘工具却忘记登记进这些子代理的 disallowedTools,这里就会
 * 测试红,不用等审计再抓一次。
 *
 * 判定口径:工具视为"只读安全"当且仅当 `isReadOnly === true`,或者提供了 `isReadOnlyFor`(按入参动态判
 * 定的双用途工具,如 run_command/PowerShell/project_diagnostics——这类工具 cc 自己也不禁用 Bash,只在
 * prompt 里教"只用来跑只读操作",本项目对齐同一口径,不属于本守卫要拦的"无条件写盘"类)。
 */

const BUNDLED_AGENTS_DIR = join(import.meta.dir, 'bundled')
const READ_ONLY_MARKER = 'READ-ONLY MODE'

test('内置只读子代理(Explore/Plan 等自称 READ-ONLY MODE 的 bundled agent)的可用工具集里没有任何非只读工具', async () => {
  const agents = await loadAgentsDir(BUNDLED_AGENTS_DIR)
  const readOnlyAgents = agents.filter(agent => agent.prompt.includes(READ_ONLY_MARKER))

  // 哨兵:确保探测逻辑本身没失效(至少要覆盖到 Explore + Plan),避免文案改了导致这条测试悄悄变成空跑。
  expect(readOnlyAgents.map(a => a.name).sort()).toEqual(['Explore', 'Plan'])

  const registry = buildGeneralRegistry()
  const allTools = registry.list()

  for (const agent of readOnlyAgents) {
    const resolved = resolveAgentTools(agent, allTools)
    const leaked = resolved.filter(tool => !(tool.isReadOnly || typeof tool.isReadOnlyFor === 'function'))
    expect(leaked.map(t => t.name)).toEqual([])
  }
})
