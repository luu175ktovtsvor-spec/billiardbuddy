// 工作流运行编排器(确定性壳):按定义顺序逐步执行,每步 = 注入的 runTurn 回调跑一次真 Agent 回合;
// 整条运行共用一个会话 id,让后续步骤天然带上前序上下文(不靠手工摘要接力)。
// 编排语义归本服务(顺序、失败关闭、取消、并发守卫、运行记录落盘);
// 模型循环、工具与权限归 harness——本服务不 import server 内部,只依赖注入回调。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  workflowRunSchema,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunTrigger,
} from '../../shared/contracts/workflows'
import type { WorkflowDefinitionStore } from './definitionStore'

const MAX_RUNS_PER_WORKFLOW = 50
const MAX_STEP_SUMMARY_CHARS = 20_000
const MAX_ERROR_CHARS = 5_000

export interface WorkflowTurnInput {
  instruction: string
  conversationId: string
  workingDir?: string
  billiardsMode: boolean
  signal: AbortSignal
}

export interface WorkflowTurnResult {
  status: 'completed' | 'failed'
  summary?: string
  error?: string
}

export type RunWorkflowTurn = (input: WorkflowTurnInput) => Promise<WorkflowTurnResult>

export interface WorkflowRunServiceOptions {
  stateRoot: string
  definitions: WorkflowDefinitionStore
  runTurn: RunWorkflowTurn
  now?: () => number
  logger?: Pick<Console, 'warn' | 'error'>
}

export interface StartRunOptions {
  trigger: WorkflowRunTrigger
  workingDir?: string
  signal?: AbortSignal
}

/** 调度器 fireTask 需要的收敛结果形状(与 ScheduledTaskRunner.FireTaskResult 对齐)。 */
export interface WorkflowSchedulerResult {
  status: 'completed' | 'failed'
  summary?: string
  error?: string
  conversationId?: string
}

export class WorkflowNotFoundError extends Error {
  constructor(workflowId: string) {
    super(`workflow not found: ${workflowId}`)
  }
}

export class WorkflowAlreadyRunningError extends Error {
  constructor(readonly workflowId: string, readonly runId: string) {
    super(`workflow ${workflowId} is already running (run ${runId})`)
  }
}

interface RunsFile {
  runs: WorkflowRun[]
}

interface PreparedRun {
  definition: WorkflowDefinition
  run: WorkflowRun
  controller: AbortController
}

export class WorkflowRunService {
  private readonly runsPath: string
  private readonly definitions: WorkflowDefinitionStore
  private readonly runTurn: RunWorkflowTurn
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly runningWorkflows = new Map<string, { runId: string; controller: AbortController }>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(opts: WorkflowRunServiceOptions) {
    this.runsPath = join(opts.stateRoot, 'workflows', 'workflow-runs.json')
    this.definitions = opts.definitions
    this.runTurn = opts.runTurn
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger ?? console
  }

  async listWorkflows(): Promise<WorkflowDefinition[]> {
    return (await this.definitions.list()).workflows
  }

  async listRuns(workflowId?: string): Promise<WorkflowRun[]> {
    const { runs } = await this.readRunsFile()
    return runs
      .filter(run => !workflowId || run.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const { runs } = await this.readRunsFile()
    return runs.find(run => run.id === runId) ?? null
  }

  isRunning(workflowId: string): boolean {
    return this.runningWorkflows.has(workflowId)
  }

  /**
   * 启动一次运行并等待整条工作流收尾。
   * 顺序执行;某步失败即失败关闭(剩余步骤 skipped);外部 signal 触发 → cancelled。
   */
  async startRun(workflowId: string, opts: StartRunOptions): Promise<WorkflowRun> {
    const prepared = await this.prepareRun(workflowId, opts)
    return this.executeRun(prepared, opts)
  }

  /** 面向 REST 手动触发:后台起跑,立刻返回初始运行快照供轮询。 */
  async startRunInBackground(workflowId: string, opts: StartRunOptions): Promise<WorkflowRun> {
    const prepared = await this.prepareRun(workflowId, opts)
    const snapshot = structuredClone(prepared.run)
    void this.executeRun(prepared, opts).catch(err =>
      this.logger.error(`[workflows] background run ${workflowId} failed:`, err))
    return snapshot
  }

  /** 定时任务分支入口:整条工作流收敛为 FireTaskResult。 */
  async runForScheduler(workflowId: string, ctx: { signal?: AbortSignal; workingDir?: string }): Promise<WorkflowSchedulerResult> {
    let run: WorkflowRun
    try {
      run = await this.startRun(workflowId, { trigger: 'scheduled', signal: ctx.signal, workingDir: ctx.workingDir })
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
    if (run.status === 'completed') {
      return { status: 'completed', summary: buildRunSummary(run), conversationId: run.conversationId }
    }
    return {
      status: 'failed',
      error: run.error ?? `工作流未完成(状态:${run.status})`,
      conversationId: run.conversationId,
    }
  }

  /** 服务器启动时调用:上个进程崩溃遗留的 running 记录标记为 failed(失败关闭,不装作还在跑)。 */
  async cleanupStaleRuns(): Promise<void> {
    const data = await this.readRunsFile()
    let changed = false
    for (const run of data.runs) {
      if (run.status !== 'running' || this.runningWorkflows.has(run.workflowId)) continue
      run.status = 'failed'
      run.error = '进程在工作流完成前退出'
      run.completedAt = this.iso()
      for (const step of run.steps) {
        if (step.status === 'running') step.status = 'failed'
        else if (step.status === 'pending') step.status = 'skipped'
      }
      changed = true
    }
    if (changed) await this.writeRunsFile(data)
  }

  private async prepareRun(workflowId: string, opts: StartRunOptions): Promise<PreparedRun> {
    const definition = await this.definitions.get(workflowId)
    if (!definition) throw new WorkflowNotFoundError(workflowId)
    const existing = this.runningWorkflows.get(workflowId)
    if (existing) throw new WorkflowAlreadyRunningError(workflowId, existing.runId)

    const controller = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const run: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowId: definition.id,
      workflowName: definition.name,
      trigger: opts.trigger,
      status: 'running',
      conversationId: crypto.randomUUID(),
      workingDir: opts.workingDir,
      startedAt: this.iso(),
      steps: definition.steps.map(step => ({ stepId: step.id, title: step.title, status: 'pending' as const })),
    }
    this.runningWorkflows.set(workflowId, { runId: run.id, controller })
    await this.saveRun(run)
    return { definition, run, controller }
  }

  private async executeRun({ definition, run, controller }: PreparedRun, opts: StartRunOptions): Promise<WorkflowRun> {
    try {
      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i]!
        const stepRun = run.steps[i]!
        if (controller.signal.aborted) {
          this.markCancelled(run, i)
          break
        }
        stepRun.status = 'running'
        stepRun.startedAt = this.iso()
        await this.saveRun(run)

        const result = await this.runTurn({
          instruction: composeStepInstruction(definition, step.title, step.instruction, i),
          conversationId: run.conversationId!,
          workingDir: opts.workingDir,
          billiardsMode: definition.billiardsMode,
          signal: controller.signal,
        }).catch((err): WorkflowTurnResult => ({
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }))

        stepRun.completedAt = this.iso()
        if (controller.signal.aborted) {
          stepRun.status = 'cancelled'
          this.markCancelled(run, i + 1)
          break
        }
        if (result.status === 'failed') {
          stepRun.status = 'failed'
          stepRun.error = trimText(result.error ?? '步骤执行失败', MAX_ERROR_CHARS)
          for (const rest of run.steps.slice(i + 1)) rest.status = 'skipped'
          run.status = 'failed'
          run.error = `第 ${i + 1} 步「${step.title}」失败:${stepRun.error}`
          break
        }
        stepRun.status = 'completed'
        if (result.summary) stepRun.summary = trimText(result.summary, MAX_STEP_SUMMARY_CHARS)
        await this.saveRun(run)
      }
      if (run.status === 'running') run.status = 'completed'
    } finally {
      run.completedAt = this.iso()
      this.runningWorkflows.delete(run.workflowId)
      await this.saveRun(run).catch(err => this.logger.error('[workflows] save run failed:', err))
    }
    return run
  }

  private markCancelled(run: WorkflowRun, fromStep: number): void {
    for (const step of run.steps.slice(fromStep)) {
      if (step.status === 'pending' || step.status === 'running') step.status = 'cancelled'
    }
    run.status = 'cancelled'
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private async saveRun(run: WorkflowRun): Promise<void> {
    const data = await this.readRunsFile()
    const snapshot = workflowRunSchema.parse(structuredClone(run))
    const idx = data.runs.findIndex(item => item.id === run.id)
    if (idx === -1) data.runs.push(snapshot)
    else data.runs[idx] = snapshot
    trimRuns(data)
    await this.writeRunsFile(data)
  }

  private async readRunsFile(): Promise<RunsFile> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.runsPath, 'utf8'))
    } catch {
      return { runs: [] }
    }
    const rawRuns = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as RunsFile).runs)
      ? (parsed as RunsFile).runs
      : []
    const runs: WorkflowRun[] = []
    for (const raw of rawRuns) {
      const result = workflowRunSchema.safeParse(raw)
      if (result.success) runs.push(result.data)
      // 单条损坏记录跳过,不让运行历史整体不可读。
    }
    return { runs }
  }

  private async writeRunsFile(data: RunsFile): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.runsPath), { recursive: true })
      const tmp = `${this.runsPath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
      await rename(tmp, this.runsPath)
    })
    this.writeQueue = write.catch(() => undefined)
    await write
  }
}

function composeStepInstruction(definition: WorkflowDefinition, title: string, instruction: string, index: number): string {
  return [
    `这是「${definition.name}」工作流的第 ${index + 1}/${definition.steps.length} 步:${title}。`,
    '',
    instruction,
    '',
    '完成本步后,用不超过 200 字的中文总结本步结果(将作为工作流运行记录保存)。',
  ].join('\n')
}

function buildRunSummary(run: WorkflowRun): string {
  const lines = [`【${run.workflowName}】共 ${run.steps.length} 步全部完成。`]
  for (const [i, step] of run.steps.entries()) {
    if (step.summary) lines.push(`${i + 1}. ${step.title}:${trimText(step.summary, 500)}`)
  }
  return trimText(lines.join('\n'), MAX_STEP_SUMMARY_CHARS)
}

function trimText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function trimRuns(data: RunsFile): void {
  const countByWorkflow = new Map<string, number>()
  const sorted = [...data.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const keep = new Set<string>()
  for (const run of sorted) {
    const count = countByWorkflow.get(run.workflowId) ?? 0
    if (count < MAX_RUNS_PER_WORKFLOW) {
      keep.add(run.id)
      countByWorkflow.set(run.workflowId, count + 1)
    }
  }
  data.runs = data.runs.filter(run => keep.has(run.id))
}
