import { describe, expect, it, mock } from 'bun:test'
import {
  allowsProductTaskText,
  classifyProductTaskCommand,
  resolveProductTaskText,
  type ProductTaskCommandPolicyDependencies,
} from '../product/taskCommandPolicy.js'

function discovery(
  skills = ['billiards-operations', 'weekly-review'],
  agents = ['planner', 'reviewer'],
): ProductTaskCommandPolicyDependencies {
  return {
    listSkillNames: mock(async () => skills),
    listAgentRuntimeNames: mock(async () => agents),
  }
}

describe('product task command policy', () => {
  it('keeps natural-language task text and the two task-local commands available', async () => {
    const dependencies = discovery()

    expect(classifyProductTaskCommand('整理本周球房活动安排')).toEqual({ kind: 'plain_text' })
    expect(classifyProductTaskCommand('/goal 完成本周经营复盘')).toEqual({ kind: 'local_command' })
    expect(classifyProductTaskCommand('/clear')).toEqual({ kind: 'local_command' })
    expect(classifyProductTaskCommand('/clear 保留这个任务')).toEqual({ kind: 'rejected' })

    expect(await allowsProductTaskText('整理本周球房活动安排', { dependencies })).toBe(true)
    expect(await allowsProductTaskText('/goal 完成本周经营复盘', { dependencies })).toBe(true)
    expect(await allowsProductTaskText('/clear', { dependencies })).toBe(true)
    await expect(resolveProductTaskText('/GOAL 完成本周经营复盘', { dependencies })).resolves.toEqual({
      allowed: true,
      content: '/goal 完成本周经营复盘',
    })
    expect(dependencies.listSkillNames).not.toHaveBeenCalled()
    expect(dependencies.listAgentRuntimeNames).not.toHaveBeenCalled()
  })

  it('allows only discovered runtime Agents with a complete /agent invocation', async () => {
    const dependencies = discovery()

    expect(await allowsProductTaskText(
      '/agent planner 先列出本周复盘计划',
      { cwd: '/workspace/billiards', dependencies },
    )).toBe(true)
    expect(await allowsProductTaskText(
      '/agent unknown-agent 先列出本周复盘计划',
      { cwd: '/workspace/billiards', dependencies },
    )).toBe(false)
    expect(await allowsProductTaskText(
      '/agent planner',
      { cwd: '/workspace/billiards', dependencies },
    )).toBe(false)
    expect(await allowsProductTaskText(
      '/agent planner 先列出本周复盘计划',
      { dependencies },
    )).toBe(false)
  })

  it('allows discovered Skills directly and through the bounded /skill form', async () => {
    const dependencies = discovery()
    const options = { cwd: '/workspace/billiards', dependencies }

    expect(await allowsProductTaskText('/billiards-operations 整理今日营业安排', options)).toBe(true)
    expect(await allowsProductTaskText('/skill weekly-review 汇总本周数据', options)).toBe(true)
    await expect(resolveProductTaskText('/skill weekly-review 汇总本周数据', options)).resolves.toEqual({
      allowed: true,
      content: '/weekly-review 汇总本周数据',
    })
    expect(await allowsProductTaskText('/skill unknown-skill 汇总本周数据', options)).toBe(false)
    expect(await allowsProductTaskText('/unknown-skill 汇总本周数据', options)).toBe(false)
  })

  it('blocks Core and runtime-management commands without loading a catalog', async () => {
    const dependencies = discovery()
    const privateValue = '/Users/test/.claude/private-provider-config.json token=secret'

    for (const command of [
      `/config ${privateValue}`,
      `/settings ${privateValue}`,
      '/permissions bypassPermissions',
      '/model private-model',
      '/provider private-provider',
      '/mcp private-server',
      '/plugin install private-plugin',
      '/doctor',
      '/bug private-stack-trace',
      '/status',
      '/cost',
      '/context',
      '/mcp:private (MCP) inspect',
    ]) {
      expect(await allowsProductTaskText(command, {
        cwd: '/workspace/billiards',
        dependencies,
      })).toBe(false)
    }

    expect(dependencies.listSkillNames).not.toHaveBeenCalled()
    expect(dependencies.listAgentRuntimeNames).not.toHaveBeenCalled()
  })

  it('fails closed when local command discovery is unavailable', async () => {
    const unavailable: ProductTaskCommandPolicyDependencies = {
      listSkillNames: async () => {
        throw new Error('private skill path unavailable')
      },
      listAgentRuntimeNames: async () => {
        throw new Error('private agent path unavailable')
      },
    }

    expect(await allowsProductTaskText('/weekly-review 汇总本周数据', {
      cwd: '/workspace/billiards',
      dependencies: unavailable,
    })).toBe(false)
    expect(await allowsProductTaskText('/agent planner 汇总本周数据', {
      cwd: '/workspace/billiards',
      dependencies: unavailable,
    })).toBe(false)
  })
})
