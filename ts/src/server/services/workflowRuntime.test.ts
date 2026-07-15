import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflowRuntime, type WorkflowTurnStreamBody } from './workflowRuntime'

async function* streamOf(finalText: string): AsyncGenerator<{ event: { type: string; text?: string } }> {
  yield { event: { type: 'content_delta', text: '…' } }
  yield { event: { type: 'final', text: finalText } }
}

function makeRuntime(record: WorkflowTurnStreamBody[], opts: { fail?: boolean } = {}) {
  return (async () => createWorkflowRuntime({
    stateRoot: await mkdtemp(join(tmpdir(), 'workflow-runtime-')),
    defaultWorkspaceDir: () => '/default/workspace',
    createTurnStream: async body => {
      record.push(body)
      if (opts.fail) throw new Error('turn setup failed')
      return { stream: streamOf(`回合完成:${body.message.slice(0, 30)}`) }
    },
    logger: { warn: () => {}, error: () => {} },
  }))()
}

describe('createWorkflowRuntime.fireTask', () => {
  it('裸指令任务:起单回合会话,带任务工作目录与 billiards_mode,收敛 final 文本', async () => {
    const calls: WorkflowTurnStreamBody[] = []
    const runtime = await makeRuntime(calls)
    const result = await runtime.fireTask(
      { instruction: '整理今天的门店文件', working_dir: '/my/venue', billiards_mode: true },
      { runId: 'r1', manual: false },
    )
    expect(result.status).toBe('completed')
    expect(result.summary).toContain('回合完成')
    expect(result.conversationId).toBeTruthy()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      message: '整理今天的门店文件',
      working_dir: '/my/venue',
      billiards_mode: true,
      permissionMode: 'bypassPermissions',
    })
  })

  it('空指令且无 workflow_id:失败关闭', async () => {
    const runtime = await makeRuntime([])
    const result = await runtime.fireTask({ instruction: '  ' }, { runId: 'r1', manual: false })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('没有指令内容')
  })

  it('createTurnStream 异常:返回 failed 不抛出', async () => {
    const runtime = await makeRuntime([], { fail: true })
    const result = await runtime.fireTask({ instruction: '做点事' }, { runId: 'r1', manual: false })
    expect(result.status).toBe('failed')
    expect(result.error).toBe('turn setup failed')
  })

  it('workflow_id 任务:执行整条内置工作流,每步一回合、共用会话、工作目录透传', async () => {
    const calls: WorkflowTurnStreamBody[] = []
    const runtime = await makeRuntime(calls)
    const result = await runtime.fireTask(
      { workflow_id: 'venue-daily-report', working_dir: '/my/venue' },
      { runId: 'r1', manual: false },
    )
    expect(result.status).toBe('completed')
    expect(result.summary).toContain('【营业日报】')
    // 内置营业日报共 3 步 → 3 次回合,全部同一会话、同一工作目录、挂台球包。
    expect(calls).toHaveLength(3)
    expect(new Set(calls.map(call => call.conversationId)).size).toBe(1)
    expect(calls.every(call => call.working_dir === '/my/venue' && call.billiards_mode)).toBe(true)
    const runs = await runtime.workflows.listRuns('venue-daily-report')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('completed')
  })

  it('未知 workflow_id:失败关闭并给出原因', async () => {
    const runtime = await makeRuntime([])
    const result = await runtime.fireTask({ workflow_id: 'missing-flow' }, { runId: 'r1', manual: false })
    expect(result.status).toBe('failed')
    expect(result.error).toContain('missing-flow')
  })

  it('工作目录缺省时使用默认工作区', async () => {
    const calls: WorkflowTurnStreamBody[] = []
    const runtime = await makeRuntime(calls)
    await runtime.fireTask({ instruction: '做点事' }, { runId: 'r1', manual: false })
    expect(calls[0]!.working_dir).toBe('/default/workspace')
  })
})
