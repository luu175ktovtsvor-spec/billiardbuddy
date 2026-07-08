import type { Message } from '../types/message'
import { userText } from '../types/message'
import type { Model } from '../types/model'
import type { ToolSpec } from '../tools/Tool'

export const DEFAULT_AGENT_SUMMARY_INTERVAL_MS = 30_000

export interface AgentSummarySnapshot {
  system: string
  messages: Message[]
  tools: ToolSpec[]
}

export interface AgentSummaryOptions {
  taskId: string
  model: Model
  intervalMs?: number
  signal?: AbortSignal
  updateSummary(summary: string): Promise<void> | void
}

export interface AgentSummaryController {
  updateSnapshot(snapshot: AgentSummarySnapshot): void
  stop(): void
}

function buildSummaryPrompt(previousSummary: string | null): string {
  const previous = previousSummary
    ? `\nPrevious: "${previousSummary}" - say something NEW.\n`
    : ''
  return [
    'Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.',
    previous,
    'Good: "Reading runAgent.ts"',
    'Good: "Fixing null check in validate.ts"',
    'Good: "Running auth module tests"',
    'Good: "Adding retry logic to fetchUser"',
    '',
    'Bad (past tense): "Analyzed the branch diff"',
    'Bad (too vague): "Investigating the issue"',
    'Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"',
    'Bad (branch name): "Analyzed adam/background-summary branch diff"',
  ].join('\n')
}

export function startAgentSummarization(options: AgentSummaryOptions): AgentSummaryController {
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? DEFAULT_AGENT_SUMMARY_INTERVAL_MS))
  let latestSnapshot: AgentSummarySnapshot | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let summaryAbortController: AbortController | null = null
  let stopped = false
  let previousSummary: string | null = null

  const scheduleNext = () => {
    if (stopped) return
    timeoutId = setTimeout(runSummary, intervalMs)
    maybeUnref(timeoutId)
  }

  const stop = () => {
    stopped = true
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  const abortListener = () => stop()
  options.signal?.addEventListener('abort', abortListener, { once: true })

  async function runSummary(): Promise<void> {
    if (stopped) return
    try {
      const snapshot = latestSnapshot
      if (!snapshot || snapshot.messages.length < 3) return
      const messages = filterSummaryMessages(snapshot.messages)
      if (messages.length < 3) return
      summaryAbortController = new AbortController()
      const step = await options.model.step({
        system: snapshot.system,
        messages: [...messages, userText(buildSummaryPrompt(previousSummary))],
        tools: snapshot.tools,
        signal: summaryAbortController.signal,
      })
      if (stopped) return
      const summary = step.kind === 'final' ? normalizeSummary(step.text) : normalizeSummary(step.text ?? '')
      if (!summary) return
      previousSummary = summary
      await options.updateSummary(summary)
    } catch {
      // 摘要只是 UI 辅助,失败不能影响后台 agent 主任务。
    } finally {
      summaryAbortController = null
      if (!stopped) scheduleNext()
    }
  }

  scheduleNext()

  return {
    updateSnapshot(snapshot) {
      latestSnapshot = {
        system: snapshot.system,
        messages: snapshot.messages.slice(),
        tools: snapshot.tools.slice(),
      }
    },
    stop() {
      options.signal?.removeEventListener('abort', abortListener)
      stop()
    },
  }
}

function normalizeSummary(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '').slice(0, 120)
}

function filterSummaryMessages(messages: Message[]): Message[] {
  return filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUseMessages(messages),
    ),
  )
}

function filterUnresolvedToolUseMessages(messages: Message[]): Message[] {
  const pending = new Set<string>()
  const keep: Message[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      const ids = message.content.filter(block => block.type === 'tool_use').map(block => block.id)
      ids.forEach(id => pending.add(id))
      keep.push(message)
      continue
    }
    const results = new Set(message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id))
    results.forEach(id => pending.delete(id))
    keep.push(message)
  }
  if (pending.size === 0) return keep
  return keep.filter(message =>
    message.role !== 'assistant' ||
    !message.content.some(block => block.type === 'tool_use' && pending.has(block.id)),
  )
}

function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'text' && !block.text.trim())
  })
}

function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'thinking')
  })
}

function maybeUnref(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}
