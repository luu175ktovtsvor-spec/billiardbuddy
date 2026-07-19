import { describe, expect, it, mock } from 'bun:test'
import {
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

    expect((await resolveProductTaskText('整理本周球房活动安排', { dependencies })).allowed).toBe(true)
    expect((await resolveProductTaskText('/goal 完成本周经营复盘', { dependencies })).allowed).toBe(true)
    expect((await resolveProductTaskText('/clear', { dependencies })).allowed).toBe(true)
    await expect(resolveProductTaskText('/GOAL 完成本周经营复盘', { dependencies })).resolves.toEqual({
      allowed: true,
      content: '/goal 完成本周经营复盘',
    })
    expect(dependencies.listSkillNames).not.toHaveBeenCalled()
    expect(dependencies.listAgentRuntimeNames).not.toHaveBeenCalled()
  })

  it('allows only discovered runtime Agents with a complete /agent invocation', async () => {
    const dependencies = discovery()

    expect((await resolveProductTaskText(
      '/agent planner 先列出本周复盘计划',
      { cwd: '/workspace/billiards', dependencies },
    )).allowed).toBe(true)
    expect((await resolveProductTaskText(
      '/agent unknown-agent 先列出本周复盘计划',
      { cwd: '/workspace/billiards', dependencies },
    )).allowed).toBe(false)
    expect((await resolveProductTaskText(
      '/agent planner',
      { cwd: '/workspace/billiards', dependencies },
    )).allowed).toBe(false)
    expect((await resolveProductTaskText(
      '/agent planner 先列出本周复盘计划',
      { dependencies },
    )).allowed).toBe(false)
  })

  it('allows discovered Skills directly and through the bounded /skill form', async () => {
    const dependencies = discovery()
    const options = { cwd: '/workspace/billiards', dependencies }

    expect((await resolveProductTaskText('/billiards-operations 整理今日营业安排', options)).allowed).toBe(true)
    expect((await resolveProductTaskText('/skill weekly-review 汇总本周数据', options)).allowed).toBe(true)
    await expect(resolveProductTaskText('/skill weekly-review 汇总本周数据', options)).resolves.toEqual({
      allowed: true,
      content: '/weekly-review 汇总本周数据',
    })
    expect((await resolveProductTaskText('/skill unknown-skill 汇总本周数据', options)).allowed).toBe(false)
    expect((await resolveProductTaskText('/unknown-skill 汇总本周数据', options)).allowed).toBe(false)
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
      expect((await resolveProductTaskText(command, {
        cwd: '/workspace/billiards',
        dependencies,
      })).allowed).toBe(false)
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

    expect((await resolveProductTaskText('/weekly-review 汇总本周数据', {
      cwd: '/workspace/billiards',
      dependencies: unavailable,
    })).allowed).toBe(false)
    expect((await resolveProductTaskText('/agent planner 汇总本周数据', {
      cwd: '/workspace/billiards',
      dependencies: unavailable,
    })).allowed).toBe(false)
  })
})
