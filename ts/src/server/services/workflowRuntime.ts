// 工作流运行时装配:把「经营工作流服务 + 定时任务触发(fireTask)」从 server/index.ts 抽出的责任模块。
// - 每步/每次触发都经注入的 createTurnStream 跑一次真 Agent 回合(无人值守走 bypassPermissions,
//   跳过审批但仍不越 fatal/显式 deny——与原 index.ts 内联实现行为一致)。
// - fireTask 两个分支:任务带 workflow_id → 执行整条已验证工作流;否则沿用单条裸指令起一回合会话。

import { join } from 'node:path'
import { bundledWorkflowDefinitions } from '../../workflows/bundledWorkflows'
import { WorkflowDefinitionStore } from '../../workflows/definitionStore'
import { WorkflowRunService, type RunWorkflowTurn } from '../../workflows/workflowRunService'
import type { FireTask } from './scheduledTaskRunner'

interface TurnEventRecord {
  event: { type: string; text?: string }
}

export interface WorkflowTurnStreamBody {
  message: string
  conversationId: string
  working_dir: string
  billiards_mode: boolean
  permissionMode: 'bypassPermissions'
}

export interface WorkflowRuntimeOptions {
  stateRoot: string
  defaultWorkspaceDir: () => string
  createTurnStream: (body: WorkflowTurnStreamBody) => Promise<{ stream: AsyncIterable<TurnEventRecord> }>
  logger?: Pick<Console, 'warn' | 'error'>
}

export interface WorkflowRuntime {
  workflows: WorkflowRunService
  fireTask: FireTask
  /** 启动对账:上个进程遗留的 running 运行标记为 failed;失败不阻塞服务。 */
  startupCleanup: Promise<void>
}

export function createWorkflowRuntime(opts: WorkflowRuntimeOptions): WorkflowRuntime {
  const logger = opts.logger ?? console

  async function collectFinalText(body: WorkflowTurnStreamBody, signal?: AbortSignal): Promise<string> {
    let finalText = ''
    const { stream } = await opts.createTurnStream(body)
    for await (const record of stream) {
      if (signal?.aborted) break
      if (record.event.type === 'final') finalText = record.event.text ?? ''
    }
    return finalText
  }

  const runTurn: RunWorkflowTurn = async input => {
    const finalText = await collectFinalText({
      message: input.instruction,
      conversationId: input.conversationId,
      working_dir: input.workingDir ?? opts.defaultWorkspaceDir(),
      billiards_mode: input.billiardsMode,
      permissionMode: 'bypassPermissions',
    }, input.signal)
    return { status: 'completed', summary: finalText }
  }

  const workflows = new WorkflowRunService({
    stateRoot: opts.stateRoot,
    definitions: new WorkflowDefinitionStore({
      userDir: join(opts.stateRoot, 'workflows', 'definitions'),
      bundled: bundledWorkflowDefinitions,
    }),
    runTurn,
    logger,
  })

  const fireTask: FireTask = async (task, ctx) => {
    const workingDir = typeof task.working_dir === 'string' && task.working_dir.trim()
      ? task.working_dir.trim()
      : opts.defaultWorkspaceDir()
    // 引用工作流的定时任务:到点执行整条已验证工作流,而不是单条裸指令。
    const workflowId = typeof task.workflow_id === 'string' ? task.workflow_id.trim() : ''
    if (workflowId) {
      return workflows.runForScheduler(workflowId, { signal: ctx.signal, workingDir })
    }
    const instruction = typeof task.instruction === 'string' ? task.instruction.trim() : ''
    if (!instruction) return { status: 'failed', error: '定时任务没有指令内容,已跳过。' }
    const conversationId = crypto.randomUUID()
    try {
      const finalText = await collectFinalText({
        message: instruction,
        conversationId,
        working_dir: workingDir,
        billiards_mode: task.billiards_mode === true,
        permissionMode: 'bypassPermissions',
      }, ctx.signal)
      return { status: 'completed', summary: finalText, conversationId }
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err), conversationId }
    }
  }

  return {
    workflows,
    fireTask,
    startupCleanup: workflows.cleanupStaleRuns().catch(err =>
      logger.error('[workflows] startup cleanup failed:', err)),
  }
}
