// 工作流运行时装配:把「经营工作流服务 + 定时任务触发(fireTask)」从 server/index.ts 抽出的责任模块。
// - 每步/每次触发都经注入的 createTurnStream 跑一次真 Agent 回合(无人值守走 bypassPermissions,
//   跳过审批但仍不越 fatal/显式 deny——与原 index.ts 内联实现行为一致)。
// - fireTask 两个分支:任务带 workflow_id → 执行整条已验证工作流;否则沿用单条裸指令起一回合会话。

import { join } from 'node:path'
import type { WorkflowRun } from '../../../shared/contracts/workflows'
import { bundledWorkflowDefinitions } from '../../workflows/bundledWorkflows'
import { WorkflowDefinitionStore } from '../../workflows/definitionStore'
import { WorkflowRunService, type RunWorkflowTurn } from '../../workflows/workflowRunService'
import type { FireTask } from './scheduledTaskRunner'

/** 运行收尾 → 通知中心文案;running 等中间态不通知。 */
export function workflowRunNotification(run: WorkflowRun): Record<string, unknown> | null {
  const title = run.status === 'completed'
    ? '工作流已完成'
    : run.status === 'failed'
      ? '工作流失败'
      : run.status === 'cancelled'
        ? '工作流已取消'
        : null
  if (!title) return null
  const doneSteps = run.steps.filter(step => step.status === 'completed').length
  const progress = `${doneSteps}/${run.steps.length} 步完成`
  return {
    title,
    body: run.error ? `${run.workflowName}(${progress}): ${run.error}` : `${run.workflowName}(${progress})`,
    kind: 'workflow_run',
    meta: {
      runId: run.id,
      workflowId: run.workflowId,
      status: run.status,
      conversationId: run.conversationId,
    },
  }
}

interface TurnEventRecord {
  event: { type: string; text?: string; total_tokens?: number }
}

/** D3:把累计 token 数拼进摘要文案,让无人值守的一步花了多少算力对用户可见,而不是算了却不展示。 */
function withTokenNote(text: string, totalTokens: number | undefined): string {
  if (!totalTokens) return text
  const note = `(本步约用 ${totalTokens.toLocaleString('zh-CN')} tokens)`
  return text ? `${text}\n${note}` : note
}

export interface WorkflowTurnStreamBody {
  message: string
  conversationId: string
  working_dir: string
  billiards_mode: boolean
  permissionMode: 'bypassPermissions'
  /**
   * D2:标记这是无人值守回合——即使完全访问档位放行一切,危险命令(rm -rf 根、mkfs 等)
   * 仍会在 resolve.ts 里被挡下、按 headless 语义自动拒绝,不依赖"完全访问开关是否被降级"
   * 这一层兜底(那层只在 enforcePermissionPolicy 生产默认下生效,owner 主动开启完全访问后就不再挡)。
   */
  unattended: true
}

export interface WorkflowRuntimeOptions {
  stateRoot: string
  defaultWorkspaceDir: () => string
  createTurnStream: (body: WorkflowTurnStreamBody) => Promise<{ stream: AsyncIterable<TurnEventRecord> }>
  /** 运行收尾通知落点(桌面通知中心);缺省不通知。 */
  addNotification?: (notification: Record<string, unknown>) => Promise<unknown>
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

  async function collectFinalText(body: WorkflowTurnStreamBody, signal?: AbortSignal): Promise<{ text: string; totalTokens?: number }> {
    let finalText = ''
    let totalTokens: number | undefined
    const { stream } = await opts.createTurnStream(body)
    for await (const record of stream) {
      if (signal?.aborted) break
      if (record.event.type === 'final') finalText = record.event.text ?? ''
      // usage_update.total_tokens 是累计值(对齐前端 chatStore 的读法),取本回合最后一次即为总用量。
      if (record.event.type === 'usage_update' && typeof record.event.total_tokens === 'number') totalTokens = record.event.total_tokens
    }
    return { text: finalText, totalTokens }
  }

  const runTurn: RunWorkflowTurn = async input => {
    const { text, totalTokens } = await collectFinalText({
      message: input.instruction,
      conversationId: input.conversationId,
      working_dir: input.workingDir ?? opts.defaultWorkspaceDir(),
      billiards_mode: input.billiardsMode,
      permissionMode: 'bypassPermissions',
      unattended: true,
    }, input.signal)
    // C4:没抛错不等于真做完了——模型可能一个 final 都没给(比如撞了轮次上限、或提前收敛却什么都没说)。
    // 这种情况之前会被无条件记成 completed,用户看到"步骤已完成"却压根没有产出。
    // 真正的取消由调用方独立按 signal.aborted 判定并覆盖成 cancelled,不受这里影响。
    if (!text.trim()) return { status: 'failed', error: '这一步没有产出任何结果(模型没有给出最终回复)。' }
    return { status: 'completed', summary: withTokenNote(text, totalTokens) }
  }

  const workflows = new WorkflowRunService({
    stateRoot: opts.stateRoot,
    definitions: new WorkflowDefinitionStore({
      userDir: join(opts.stateRoot, 'workflows', 'definitions'),
      bundled: bundledWorkflowDefinitions,
    }),
    runTurn,
    // 无人值守运行(定时/后台)的结果必须能被用户看见:收尾即落桌面通知,失败带原因。
    onSettled: async run => {
      const notification = workflowRunNotification(run)
      if (notification) await opts.addNotification?.(notification)
    },
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
      const { text, totalTokens } = await collectFinalText({
        message: instruction,
        conversationId,
        working_dir: workingDir,
        billiards_mode: task.billiards_mode === true,
        permissionMode: 'bypassPermissions',
        unattended: true,
      }, ctx.signal)
      // C4:没抛错不等于真做完了,同 runTurn 的道理——空产出别当成功报。
      if (!text.trim()) return { status: 'failed', error: '这次定时任务没有产出任何结果(模型没有给出最终回复)。', conversationId }
      return { status: 'completed', summary: withTokenNote(text, totalTokens), conversationId }
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
