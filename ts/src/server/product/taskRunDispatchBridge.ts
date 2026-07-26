import { IpcAgentWorkerLauncher } from '../agent-worker/ipcLauncher.js'
import { serverPrivateNativeCoreFactory } from '../agent-worker/nativeCoreFactory.js'
import { AgentWorkerSupervisor } from './agentWorkerSupervisor.js'
import { ProductResourceScheduler } from './resourceScheduler.js'
import type { ProductTaskService } from './taskService.js'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { sanitizeProductTaskVisibleText } from './taskAttachmentProjection.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'
import { reviewAutomaticApproval } from './automaticApprovalReviewer.js'

const supervisors = new WeakMap<ProductTaskService, AgentWorkerSupervisor>()

export class ProductTaskWorkerMessageSink {
  private readonly taskIds = new Map<string, string>()
  private readonly startedText = new Set<string>()
  private readonly closed = new Set<string>()
  private readonly textBuffers = new Map<string, string>()
  private readonly pendingSeparators = new Map<string, string>()
  private readonly droppingTokens = new Set<string>()
  private readonly publishedText = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly tasks: ProductTaskService) {}

  record(runId: string, generation: number, message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' | 'steer_consumed' }>): Promise<void> {
    const key = `${runId}:${generation}`
    if (message.type === 'terminal') {
      if (this.closed.has(key)) return Promise.resolve()
      this.closed.add(key)
    } else if (this.closed.has(key)) return Promise.resolve()
    const previous = this.queues.get(key) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(() => this.recordOrdered(runId, generation, message))
    this.queues.set(key, queued)
    return queued.finally(() => { if (this.queues.get(key) === queued) this.queues.delete(key) })
  }

  private async recordOrdered(runId: string, generation: number, message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' | 'steer_consumed' }>): Promise<void> {
    const key = `${runId}:${generation}`
    let taskId = this.taskIds.get(key)
    if (!taskId) {
      taskId = (await this.tasks.readTaskRunDispatchIdentity(runId, generation)).task_id
      this.taskIds.set(key, taskId)
    }
    if (message.type === 'terminal') {
      this.flushText(taskId, key, true)
      await this.tasks.recordTaskRunTerminalProjection(runId, generation, message.state, this.publishedText.get(key) ?? '')
      if (message.state === 'recovery_required') productTaskWorkerRuntimeEvents.publish(taskId, { type: 'error', code: 'task_failed', retryable: false })
      else productTaskWorkerRuntimeEvents.publish(taskId, { type: 'turn_complete' })
      this.taskIds.delete(key)
      this.startedText.delete(key)
      this.textBuffers.delete(key)
      this.pendingSeparators.delete(key)
      this.droppingTokens.delete(key)
      this.publishedText.delete(key)
      return
    }
    if (message.type === 'steer_consumed') {
      const recorded = await this.tasks.recordQueuedInputConsumed(runId, generation, message.queue_item_id)
      for (const event of recorded.events) productTaskWorkerRuntimeEvents.publish(taskId, event)
      return
    }
    if (message.event === 'started') {
      productTaskWorkerRuntimeEvents.publish(taskId, { type: 'status', state: 'working' })
      return
    }
    if (message.event === 'context_compaction') {
      const recorded = await this.tasks.recordTaskRunContextCompaction(runId, generation, message)
      productTaskWorkerRuntimeEvents.publish(taskId, recorded.event)
      return
    }
    if (message.event === 'approval') {
      const recorded = await this.tasks.recordTaskRunApprovalRequest(
        runId,
        generation,
        message.request_id,
        message.action,
        message.review,
      )
      if (this.closed.has(key)) return
      if (recorded.reviewer === 'automatic') {
        const decision = reviewAutomaticApproval(message.review)
        const resolved = await this.tasks.resolveTaskRunApproval(
          taskId,
          message.request_id,
          decision.allowed,
          'automatic',
          decision.reason,
        )
        if (!resolved) throw new Error('AUTOMATIC_REVIEW_FAILED')
      } else {
        productTaskWorkerRuntimeEvents.publish(taskId, recorded.event)
      }
      return
    }
    if (message.event === 'question') {
      const recorded = await this.tasks.recordTaskRunQuestionRequest(
        runId,
        generation,
        message.request_id,
        message.questions,
      )
      productTaskWorkerRuntimeEvents.publish(taskId, recorded.event)
      return
    }
    if (message.event === 'extension_snapshot') {
      await this.tasks.recordTaskRunExtensionSnapshot(runId, generation, {
        digest: message.digest,
        tool_count: message.tool_count,
        command_count: message.command_count,
        mcp_server_count: message.mcp_server_count,
      })
      return
    }
    if (message.event === 'activity') {
      const recorded = await this.tasks.recordTaskRunActivity(runId, generation, { type: 'activity', ...message.activity })
      productTaskWorkerRuntimeEvents.publish(taskId, recorded.event)
      return
    }
    if (message.event !== 'delta' || !message.data) return
    if (this.droppingTokens.has(key)) {
      const boundary = message.data.search(/[\s。！？；]/)
      if (boundary < 0) return
      this.droppingTokens.delete(key)
      this.textBuffers.set(key, message.data.slice(boundary + 1))
      this.flushText(taskId, key, false)
      return
    }
    const buffered = `${this.textBuffers.get(key) ?? ''}${message.data}`
    this.textBuffers.set(key, buffered)
    this.flushText(taskId, key, false)
  }

  private publishText(taskId: string, key: string, text: string): void {
    if (!text) return
    const current = this.publishedText.get(key) ?? ''
    const visible = text.slice(0, Math.max(0, 100_000 - current.length))
    if (!visible) return
    this.publishedText.set(key, `${current}${visible}`)
    if (!this.startedText.has(key)) {
      this.startedText.add(key)
      productTaskWorkerRuntimeEvents.publish(taskId, { type: 'assistant_text_start' })
    }
    for (let offset = 0; offset < visible.length; offset += 32_000) {
      productTaskWorkerRuntimeEvents.publish(taskId, {
        type: 'assistant_text_delta',
        text: visible.slice(offset, offset + 32_000),
      })
    }
  }

  private flushText(taskId: string, key: string, terminal: boolean): void {
    const buffered = this.textBuffers.get(key) ?? ''
    let cutoff = terminal ? buffered.length : -1
    if (!terminal) {
      for (let index = buffered.length - 1; index >= 0; index -= 1) {
        if (/[\s。！？；]/.test(buffered[index]!)) { cutoff = index + 1; break }
      }
      // Never expose or retain an unbounded partial token such as a data URL.
      if (cutoff < 0 && buffered.length > 64 * 1024) {
        this.textBuffers.set(key, '')
        this.pendingSeparators.delete(key)
        this.droppingTokens.add(key)
      }
      if (cutoff < 0) return
    }
    const raw = buffered.slice(0, cutoff)
    this.textBuffers.set(key, buffered.slice(cutoff))
    const safe = sanitizeProductTaskVisibleText(raw)
    if (safe) {
      this.publishText(taskId, key, `${this.pendingSeparators.get(key) ?? ''}${safe}`)
    }
    const boundary = raw.at(-1)
    if (boundary && /\s/.test(boundary)) {
      this.pendingSeparators.set(key, boundary === '\n' || boundary === '\r' ? '\n' : ' ')
    } else if (safe) {
      this.pendingSeparators.delete(key)
    }
    if (terminal) this.pendingSeparators.delete(key)
  }
}

/** One server-private bridge per live ProductTaskService/data root. */
export function dispatcherFor(tasks: ProductTaskService): AgentWorkerSupervisor {
  let supervisor = supervisors.get(tasks)
  if (!supervisor) {
    const scheduler = new ProductResourceScheduler({ statePath: tasks.workerSchedulerStatePath() })
    supervisor = new AgentWorkerSupervisor(
      tasks,
      scheduler,
      new IpcAgentWorkerLauncher(tasks, serverPrivateNativeCoreFactory),
      5_000,
      new ProductTaskWorkerMessageSink(tasks),
    )
    supervisors.set(tasks, supervisor)
  }
  return supervisor
}

export async function shutdownDispatcherFor(tasks: ProductTaskService): Promise<void> {
  const supervisor = supervisors.get(tasks)
  if (!supervisor) return
  supervisors.delete(tasks)
  await supervisor.shutdown()
}
