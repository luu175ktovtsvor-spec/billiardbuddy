import type { AgentEvent, AskQuestionField } from '../types/events'
import type { Tool } from './Tool'

export const ASK_USER_QUESTION_TOOL_NAMES = ['ask_user_question', 'AskUserQuestion'] as const
export const ENTER_PLAN_TOOL_NAMES = ['enter_plan', 'EnterPlanMode'] as const
export const EXIT_PLAN_TOOL_NAMES = ['exit_plan', 'ExitPlanMode'] as const

export type AskOption = { label: string; description?: string; preview?: string }

export interface InteractionQuestion {
  id: string
  question: string
  options: AskOption[]
  multi?: boolean
  allowFreeform?: boolean
  placeholder?: string
  fields?: AskQuestionField[]
  url?: string
  timeoutMs: number
}

const DEFAULT_QUESTION_TIMEOUT_MS = 120000
const MAX_QUESTION_TIMEOUT_MS = 600000

function makeSpec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
    isReadOnly: true,
    async execute() {
      return `${name} 必须由 Agent 主循环执行。`
    },
  }
}

export const askUserQuestionTool = makeSpec(
  'ask_user_question',
  [
    'Ask the user a concise question during execution, then continue after their answer is returned as the tool result.',
    'Use this for real ambiguity, preferences, or decisions that cannot be discovered from files or prior context.',
    'Recommended options should be listed first and marked in the label.',
  ].join(' '),
  {
    question: { type: 'string', description: 'The question shown to the user.' },
    options: {
      type: 'array',
      description: 'Optional choices. Items may be strings or {label, description}. The UI also accepts free-form answers.',
      items: { type: 'object' },
    },
    multi: { type: 'boolean', description: 'Whether multiple choices may be selected.' },
    multiSelect: { type: 'boolean', description: 'Alias for multi.' },
    allow_freeform: { type: 'boolean', description: 'Defaults to true.' },
    placeholder: { type: 'string', description: 'Optional placeholder for a custom answer.' },
    fields: {
      type: 'array',
      description: 'Optional structured form fields. Items: {name,label,type,required,description,defaultValue,options,placeholder}.',
      items: { type: 'object' },
    },
    url: { type: 'string', description: 'Optional URL related to the question.' },
    timeout_ms: { type: 'number', description: `Wait timeout in ms, capped at ${MAX_QUESTION_TIMEOUT_MS}.` },
  },
  ['question'],
)

export const askUserQuestionCompatTool: Tool = {
  ...askUserQuestionTool,
  name: 'AskUserQuestion',
}

export const enterPlanTool = makeSpec(
  'enter_plan',
  [
    'Request to enter plan mode before non-trivial implementation.',
    'Use this when the task needs exploration, architectural choices, or user sign-off before edits.',
    'After approval, only read-only exploration should happen until ExitPlanMode presents the plan.',
  ].join(' '),
  {
    reason: { type: 'string', description: 'Short reason why plan mode is useful for this task.' },
    timeout_ms: { type: 'number', description: `Wait timeout in ms, capped at ${MAX_QUESTION_TIMEOUT_MS}.` },
  },
)

export const enterPlanCompatTool: Tool = {
  ...enterPlanTool,
  name: 'EnterPlanMode',
}

export const exitPlanTool = makeSpec(
  'exit_plan',
  [
    'Use this when you are in plan mode and have finished writing your plan to the plan file, ready for user approval.',
    'This tool does NOT take the plan content as a parameter — it reads the plan from the plan file you wrote (path is in the plan-mode system reminder).',
    'Do not use this for ordinary clarification; use ask_user_question for that.',
    'After approval, the current turn may continue in ask mode so reversible implementation steps can proceed through normal gates.',
  ].join(' '),
  {
    timeout_ms: { type: 'number', description: `Wait timeout in ms, capped at ${MAX_QUESTION_TIMEOUT_MS}.` },
  },
)

export const exitPlanCompatTool: Tool = {
  ...exitPlanTool,
  name: 'ExitPlanMode',
}

export function isAskUserQuestionToolName(name: string): boolean {
  return (ASK_USER_QUESTION_TOOL_NAMES as readonly string[]).includes(name)
}

export function isEnterPlanToolName(name: string): boolean {
  return (ENTER_PLAN_TOOL_NAMES as readonly string[]).includes(name)
}

export function isExitPlanToolName(name: string): boolean {
  return (EXIT_PLAN_TOOL_NAMES as readonly string[]).includes(name)
}

export function normalizeAskUserQuestion(input: unknown, callId: string): InteractionQuestion {
  const obj = asRecord(input)
  const question = stringValue(obj.question) || stringValue(obj.prompt) || stringValue(obj.body)
  if (!question) throw new Error('ask_user_question 需要 question')
  return {
    id: `ask_${safeId(callId)}`,
    question,
    options: normalizeOptions(obj.options),
    multi: booleanValue(obj.multi ?? obj.multiSelect),
    allowFreeform: obj.allow_freeform === undefined && obj.allowFreeform === undefined
      ? true
      : booleanValue(obj.allow_freeform ?? obj.allowFreeform),
    placeholder: stringValue(obj.placeholder) || undefined,
    fields: normalizeFields(obj.fields),
    url: stringValue(obj.url) || undefined,
    timeoutMs: timeoutMs(obj.timeout_ms ?? obj.timeoutMs),
  }
}

export function normalizeEnterPlanQuestion(input: unknown, callId: string): { reason: string; question: InteractionQuestion } {
  const obj = asRecord(input)
  const reason = stringValue(obj.reason) || stringValue(obj.task) || '这个任务可能涉及多步修改,需要先探索代码并确认方案。'
  return {
    reason,
    question: {
      id: `enter_plan_${safeId(callId)}`,
      question: `是否进入计划模式？\n\n${reason}`,
      options: [
        { label: '进入计划模式', description: '先只读探索和设计方案,不直接改文件。' },
        { label: '继续直接执行', description: '不切换计划模式,按当前权限档继续。' },
      ],
      allowFreeform: true,
      placeholder: '也可以说明你希望怎么推进',
      timeoutMs: timeoutMs(obj.timeout_ms ?? obj.timeoutMs),
    },
  }
}

/**
 * 组装 exit_plan 的批准问卡。plan 正文由调用方(loop)从**磁盘计划文件**读出后传入
 * (对齐 cc ExitPlanModeV2:工具不再吃 plan 参数、从盘读)。timeout 仍从工具入参取。
 */
export function normalizeExitPlanQuestion(plan: string, callId: string, input?: unknown): InteractionQuestion {
  const obj = asRecord(input)
  return {
    id: `exit_plan_${safeId(callId)}`,
    question: `计划已经准备好。\n\n${plan}`,
    options: [
      { label: '批准并执行', description: '退出计划模式,继续按这个方案推进。' },
      { label: '修改计划', description: '告诉我哪里需要调整。' },
    ],
    allowFreeform: true,
    placeholder: '也可以直接写修改意见',
    timeoutMs: timeoutMs(obj.timeout_ms ?? obj.timeoutMs),
  }
}

export function questionEvent(q: InteractionQuestion): AgentEvent {
  return {
    type: 'ask_question',
    id: q.id,
    question: q.question,
    options: q.options,
    multi: q.multi,
    allowFreeform: q.allowFreeform,
    placeholder: q.placeholder,
    fields: q.fields,
    url: q.url,
  }
}

export function isPlanApprovalAnswer(answer: string): boolean {
  const text = answer.trim().toLowerCase()
  if (!text) return false
  return [
    '批准并执行',
    '批准',
    '同意',
    '可以',
    '开始',
    '执行',
    'yes',
    'y',
    'ok',
    'approve',
    'approved',
    'go',
  ].some(word => text === word || text.includes(word))
}

export function isEnterPlanApprovalAnswer(answer: string): boolean {
  const text = answer.trim().toLowerCase()
  if (!text) return false
  return [
    '进入计划模式',
    '计划模式',
    '进入',
    '同意',
    '可以',
    'yes',
    'y',
    'ok',
    'approve',
    'approved',
  ].some(word => text === word || text.includes(word))
}

function normalizeOptions(value: unknown): AskOption[] {
  if (!Array.isArray(value)) return []
  const options: AskOption[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label) options.push({ label })
      continue
    }
    const obj = asRecord(item)
    const label = stringValue(obj.label ?? obj.value ?? obj.title)
    if (!label) continue
    const description = stringValue(obj.description ?? obj.detail)
    const preview = stringValue(obj.preview)
    options.push({ label, ...(description ? { description } : {}), ...(preview ? { preview } : {}) })
  }
  return options.slice(0, 8)
}

function normalizeFields(value: unknown): AskQuestionField[] | undefined {
  if (!Array.isArray(value)) return undefined
  const fields: AskQuestionField[] = []
  for (const item of value) {
    const obj = asRecord(item)
    const name = stringValue(obj.name ?? obj.key)
    if (!name || !/^[A-Za-z0-9_.-]{1,80}$/.test(name)) continue
    const label = stringValue(obj.label ?? obj.title) || name
    const type = normalizeFieldType(obj.type)
    const description = stringValue(obj.description)
    const placeholder = stringValue(obj.placeholder)
    const options = Array.isArray(obj.options)
      ? obj.options.map(stringValue).filter(Boolean).slice(0, 20)
      : undefined
    fields.push({
      name,
      label,
      ...(type ? { type } : {}),
      ...(booleanValue(obj.required) !== undefined ? { required: booleanValue(obj.required) } : {}),
      ...(description ? { description } : {}),
      ...(primitiveDefault(obj.defaultValue ?? obj.default) !== undefined ? { defaultValue: primitiveDefault(obj.defaultValue ?? obj.default) } : {}),
      ...(options && options.length ? { options } : {}),
      ...(placeholder ? { placeholder } : {}),
    })
  }
  return fields.length > 0 ? fields.slice(0, 12) : undefined
}

function normalizeFieldType(value: unknown): AskQuestionField['type'] | undefined {
  if (typeof value !== 'string') return undefined
  if (['text', 'textarea', 'number', 'boolean', 'select', 'multiselect'].includes(value)) return value as AskQuestionField['type']
  if (value === 'string') return 'text'
  if (value === 'integer') return 'number'
  return undefined
}

function primitiveDefault(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

function timeoutMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUESTION_TIMEOUT_MS
  return Math.min(MAX_QUESTION_TIMEOUT_MS, Math.max(1, Math.floor(n)))
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  return undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeId(value: string): string {
  const id = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return id || `${Date.now()}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
