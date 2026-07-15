import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowDefinition, WorkflowRun } from '../../shared/contracts/workflows'
import { WorkflowDefinitionStore } from './definitionStore'
import {
  WorkflowAlreadyRunningError,
  WorkflowNotFoundError,
  WorkflowRunService,
  type RunWorkflowTurn,
  type WorkflowTurnInput,
} from './workflowRunService'

const definition: WorkflowDefinition = {
  id: 'demo-flow',
  name: '演示流程',
  description: '',
  billiardsMode: true,
  source: 'bundled',
  steps: [
    { id: 'one', title: '第一步', instruction: '做第一件事' },
    { id: 'two', title: '第二步', instruction: '做第二件事' },
  ],
}

function makeService(runTurn: RunWorkflowTurn, stateRoot: string): WorkflowRunService {
  const definitions = new WorkflowDefinitionStore({ userDir: join(stateRoot, 'nope'), bundled: [definition] })
  return new WorkflowRunService({ stateRoot, definitions, runTurn, logger: { warn: () => {}, error: () => {} } })
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'workflow-runs-'))
}

describe('WorkflowRunService', () => {
  it('顺序执行全部步骤:同一会话 id、步骤指令带工作流上下文、摘要落盘', async () => {
    const root = await tempRoot()
    const calls: WorkflowTurnInput[] = []
    const service = makeService(async input => {
      calls.push(input)
      return { status: 'completed', summary: `完成:${input.instruction.slice(0, 20)}` }
    }, root)

    const run = await service.startRun('demo-flow', { trigger: 'manual', workingDir: '/tmp/venue' })

    expect(run.status).toBe('completed')
    expect(run.steps.map(step => step.status)).toEqual(['completed', 'completed'])
    expect(run.steps[0]!.summary).toContain('完成:')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.conversationId).toBe(calls[1]!.conversationId)
    expect(calls[0]!.billiardsMode).toBe(true)
    expect(calls[0]!.workingDir).toBe('/tmp/venue')
    expect(calls[0]!.instruction).toContain('「演示流程」工作流的第 1/2 步')
    expect(calls[1]!.instruction).toContain('第 2/2 步')

    const persisted = JSON.parse(await readFile(join(root, 'workflows', 'workflow-runs.json'), 'utf8')) as { runs: WorkflowRun[] }
    expect(persisted.runs).toHaveLength(1)
    expect(persisted.runs[0]!.status).toBe('completed')
  })

  it('某步失败即失败关闭:后续步骤 skipped,不再调用 runTurn', async () => {
    const root = await tempRoot()
    let callCount = 0
    const service = makeService(async () => {
      callCount++
      return { status: 'failed', error: '模型通道不可用' }
    }, root)

    const run = await service.startRun('demo-flow', { trigger: 'scheduled' })
    expect(run.status).toBe('failed')
    expect(run.error).toContain('第 1 步「第一步」失败')
    expect(run.steps[0]!.status).toBe('failed')
    expect(run.steps[1]!.status).toBe('skipped')
    expect(callCount).toBe(1)
  })

  it('runTurn 抛异常等同失败,不让异常逃出编排器', async () => {
    const root = await tempRoot()
    const service = makeService(async () => {
      throw new Error('boom')
    }, root)
    const run = await service.startRun('demo-flow', { trigger: 'manual' })
    expect(run.status).toBe('failed')
    expect(run.steps[0]!.error).toBe('boom')
  })

  it('外部 signal 取消:当前步 cancelled,剩余 cancelled,run cancelled', async () => {
    const root = await tempRoot()
    const controller = new AbortController()
    const service = makeService(async input => {
      controller.abort()
      expect(input.signal.aborted).toBe(true)
      return { status: 'completed', summary: '不应算数' }
    }, root)
    const run = await service.startRun('demo-flow', { trigger: 'manual', signal: controller.signal })
    expect(run.status).toBe('cancelled')
    expect(run.steps.map(step => step.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('同一工作流不允许并发运行;未知工作流报 NotFound', async () => {
    const root = await tempRoot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = makeService(async () => {
      await gate
      return { status: 'completed' }
    }, root)

    const first = service.startRun('demo-flow', { trigger: 'manual' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(service.isRunning('demo-flow')).toBe(true)
    expect(service.startRun('demo-flow', { trigger: 'manual' })).rejects.toBeInstanceOf(WorkflowAlreadyRunningError)
    expect(service.startRun('missing', { trigger: 'manual' })).rejects.toBeInstanceOf(WorkflowNotFoundError)
    release()
    await first
    expect(service.isRunning('demo-flow')).toBe(false)
  })

  it('startRunInBackground 立即返回 running 快照,执行在后台收尾', async () => {
    const root = await tempRoot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = makeService(async () => {
      await gate
      return { status: 'completed', summary: 'ok' }
    }, root)

    const snapshot = await service.startRunInBackground('demo-flow', { trigger: 'manual' })
    expect(snapshot.status).toBe('running')
    expect(snapshot.steps.map(step => step.status)).toEqual(['pending', 'pending'])
    release()
    // 等后台收尾后核对落盘状态。
    for (let i = 0; i < 100 && service.isRunning('demo-flow'); i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const settled = await service.getRun(snapshot.id)
    expect(settled?.status).toBe('completed')
  })

  it('runForScheduler 收敛为 FireTaskResult 形状', async () => {
    const root = await tempRoot()
    const okService = makeService(async input => ({ status: 'completed', summary: `done ${input.instruction.includes('第 1/2 步') ? '1' : '2'}` }), root)
    const ok = await okService.runForScheduler('demo-flow', {})
    expect(ok.status).toBe('completed')
    expect(ok.summary).toContain('【演示流程】共 2 步全部完成')
    expect(ok.conversationId).toBeTruthy()

    const badService = makeService(async () => ({ status: 'failed', error: 'x' }), await tempRoot())
    const bad = await badService.runForScheduler('demo-flow', {})
    expect(bad.status).toBe('failed')
    expect(bad.error).toContain('失败')

    const missing = await okService.runForScheduler('missing', {})
    expect(missing.status).toBe('failed')
  })

  it('cleanupStaleRuns 把遗留 running 记录标记为 failed', async () => {
    const root = await tempRoot()
    const staleRun: WorkflowRun = {
      id: 'stale-1',
      workflowId: 'demo-flow',
      workflowName: '演示流程',
      trigger: 'scheduled',
      status: 'running',
      startedAt: '2026-07-15T00:00:00.000Z',
      steps: [
        { stepId: 'one', title: '第一步', status: 'running' },
        { stepId: 'two', title: '第二步', status: 'pending' },
      ],
    }
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'workflow-runs.json'), JSON.stringify({ runs: [staleRun, { bad: 'record' }] }), 'utf8')

    const service = makeService(async () => ({ status: 'completed' }), root)
    await service.cleanupStaleRuns()
    const run = await service.getRun('stale-1')
    expect(run?.status).toBe('failed')
    expect(run?.error).toBe('进程在工作流完成前退出')
    expect(run?.steps.map(step => step.status)).toEqual(['failed', 'skipped'])
  })

  it('损坏的运行记录单条跳过,列表仍可读', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'workflows'), { recursive: true })
    await writeFile(join(root, 'workflows', 'workflow-runs.json'), '{broken', 'utf8')
    const service = makeService(async () => ({ status: 'completed' }), root)
    expect(await service.listRuns()).toEqual([])
  })
})
