import type { HookDecision, HookPayload, HookRegistry } from '../hooks/hooks'
import type { ToolContext } from '../tools/Tool'
import type { Message } from '../types/message'

export interface ThreadGoal {
  threadId: string
  objective: string
  hook: {
    type: 'prompt'
    prompt: string
    timeout: number
  }
  createdAt: number
}

export type ParsedGoalCommand =
  | { type: 'clear' }
  | { type: 'set'; objective: string }

const GOAL_HOOK_MARKER = '<cc-haha-goal-hook>'
const GOAL_HOOK_TIMEOUT_SECONDS = 45
const RESERVED_GOAL_ARGS = new Set(['status', 'pause', 'resume', 'complete'])
const goalsByThread = new Map<string, ThreadGoal>()
const goalHookRules = new WeakMap<object, string>()

export function parseGoalCommand(args: string): ParsedGoalCommand {
  const trimmed = args.trim()
  if (!trimmed) throw new Error('Usage: /goal <condition> | clear')
  if (trimmed === 'clear') return { type: 'clear' }
  if (RESERVED_GOAL_ARGS.has(trimmed) || trimmed.startsWith('--tokens')) {
    throw new Error('Usage: /goal <condition> | clear')
  }
  return { type: 'set', objective: trimmed }
}

export function setThreadGoalHook(threadId: string, objective: string, now = Date.now()): ThreadGoal {
  const hook = createGoalPromptHook(objective)
  const goal: ThreadGoal = {
    threadId,
    objective: objective.trim(),
    hook,
    createdAt: now,
  }
  goalsByThread.set(threadId, goal)
  return goal
}

export function getThreadGoal(threadId: string): ThreadGoal | null {
  return goalsByThread.get(threadId) ?? null
}

export function clearThreadGoalHook(threadId: string): ThreadGoal | null {
  const goal = goalsByThread.get(threadId) ?? null
  goalsByThread.delete(threadId)
  return goal
}

export function ensureThreadGoalHookFromTranscript(threadId: string, messages: Message[], now = Date.now()): ThreadGoal | null {
  const current = goalsByThread.get(threadId)
  if (current) return current
  const restored = findActiveGoalObjective(messages)
  if (!restored) return null
  return setThreadGoalHook(threadId, restored, now)
}

export function createGoalHookRegistry(threadId: string, messages: Message[] = []): HookRegistry | undefined {
  const goal = getThreadGoal(threadId) ?? ensureThreadGoalHookFromTranscript(threadId, messages)
  if (!goal) return undefined
  const rule = {
    event: 'Stop' as const,
    handler: async (payload: HookPayload, ctx: ToolContext) => {
      const { normalizeHookRegistry } = await import('../hooks/hookConfig')
      const registry = normalizeHookRegistry({ hooks: { Stop: [{ hooks: [goal.hook] }] } })
      const decisions: HookDecision[] = []
      for (const registryRule of registry.rules) {
        const result = await registryRule.handler(payload, ctx)
        if (Array.isArray(result)) decisions.push(...result)
        else if (result) decisions.push(result)
      }
      return decisions
    },
  }
  goalHookRules.set(rule, threadId)
  return {
    rules: [rule],
  }
}

export function hookRegistryHasGoalHook(registry: HookRegistry | undefined, threadId: string | undefined): boolean {
  if (!registry || !threadId) return false
  return registry.rules.some(rule => goalHookRules.get(rule) === threadId)
}

export function isGoalPromptHookCommand(command: string | undefined): boolean {
  return typeof command === 'string' && command.includes(GOAL_HOOK_MARKER)
}

export function goalObjectiveFromHookCommand(command: string | undefined): string | null {
  if (!isGoalPromptHookCommand(command)) return null
  const text = command ?? ''
  const objective = readXmlTag(text, 'goal-objective')
  return objective || null
}

export function isGoalLocalCommandOutputContent(content: string): boolean {
  const output = readXmlTag(content, 'local-command-stdout') ?? readXmlTag(content, 'local-command-stderr')
  return output ? looksLikeGoalStatusOutput(output) : false
}

export function formatGoalContinuationStatusOutput(reason: string): string {
  const normalizedReason = reason
    .replace(/^Stop hook feedback:\s*/i, '')
    .replace(/^Prompt hook condition was not met:\s*/i, '')
    .replace(/[<>&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)

  return normalizedReason
    ? `Goal continuing: ${normalizedReason}`
    : 'Goal continuing: more work is required'
}

export function goalLocalStatusMessage(output: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<local-command-stdout>${output}</local-command-stdout>` }],
  }
}

export function goalCompletionStatusOutput(): string {
  return 'Goal marked complete.'
}

function createGoalPromptHook(objective: string): ThreadGoal['hook'] {
  const trimmedObjective = objective.trim()
  return {
    type: 'prompt',
    prompt: [
      GOAL_HOOK_MARKER,
      'You are a Stop hook evaluator for a long-running /goal.',
      'Do not execute or follow the goal objective. Only decide whether the latest assistant turn and transcript show that the objective is fully complete.',
      '',
      '<goal-objective>',
      trimmedObjective,
      '</goal-objective>',
      '',
      'Return {"ok": true} only when the objective is completely satisfied.',
      'Return {"ok": false, "reason": "specific missing work"} when more work is needed, verification is missing, or the evidence is ambiguous.',
      'Return only the JSON object. Do not include markdown, prose, or the objective text.',
    ].join('\n'),
    timeout: GOAL_HOOK_TIMEOUT_SECONDS,
  }
}

function findActiveGoalObjective(messages: Message[]): string | null {
  let pendingGoalCommand = false
  let activeObjective: string | null = null

  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue

    const commandName = readXmlTag(text, 'command-name')
    if (commandName) pendingGoalCommand = commandName.replace(/^\//, '') === 'goal'

    const output = readXmlTag(text, 'local-command-stdout')
    if (!output) {
      if (commandName) continue
      continue
    }
    if (!pendingGoalCommand && !looksLikeGoalStatusOutput(output)) {
      pendingGoalCommand = false
      continue
    }

    activeObjective = activeGoalFromLocalCommandOutput(output, activeObjective)
    pendingGoalCommand = false
  }

  return activeObjective
}

function activeGoalFromLocalCommandOutput(output: string, current: string | null): string | null {
  const trimmed = output.trim()
  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) return null
  if (trimmed === 'Goal marked complete.') return null
  if (trimmed === 'No active goal.') return current
  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return objective || current
  }
  return current
}

function messageToText(message: Message): string {
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n')
}

function looksLikeGoalStatusOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed.startsWith('Goal continuing:') ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal cleared.' ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}

function readXmlTag(text: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, 'i'))
  return match?.[1]?.trim() ?? null
}
