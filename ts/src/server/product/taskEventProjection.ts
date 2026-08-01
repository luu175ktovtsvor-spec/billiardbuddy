import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskPlan,
  ProductTaskPlanStep,
} from '../../../shared/product/taskEvents.js'
import { createHash } from 'node:crypto'

type RecordValue = Record<string, unknown>

const MAX_QUESTION_COUNT = 8
const MAX_OPTION_COUNT = 12
const MAX_QUESTION_TEXT_LENGTH = 1_000
const MAX_OPTION_TEXT_LENGTH = 500
const MAX_PLAN_STEP_COUNT = 100
const MAX_PLAN_STEP_LENGTH = 500

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function visibleString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLength)
}

export function productTaskActivityKindForTool(toolName: string | undefined): ProductTaskActivityKind {
  const normalized = toolName?.trim().toLowerCase() ?? ''
  if (!normalized) return 'tool'

  if (/^(read|glob|grep|ls)/.test(normalized)) return 'file_read'
  if (/^(write|edit|notebookedit)/.test(normalized)) return 'file_change'
  if (/^todowrite/.test(normalized)) return 'workspace'
  if (/(bash|shell|terminal|killshell|taskoutput|command)/.test(normalized)) return 'command'
  if (/(websearch|webfetch|search|fetch)/.test(normalized)) return 'research'
  if (/(browser|computer|playwright|preview)/.test(normalized)) return 'browser'
  if (/(image|video|media|ffmpeg)/.test(normalized)) return 'media'
  if (/(task|agent|team)/.test(normalized)) return 'subtask'
  return 'tool'
}

function projectQuestionOptions(value: unknown): ProductTaskQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined

  const options: ProductTaskQuestionOption[] = []
  for (const candidate of value) {
    if (options.length >= MAX_OPTION_COUNT || !isRecord(candidate)) continue
    const label = visibleString(candidate.label, MAX_OPTION_TEXT_LENGTH)
    if (!label) continue
    const description = visibleString(candidate.description, MAX_OPTION_TEXT_LENGTH)
    options.push({ label, ...(description ? { description } : {}) })
  }
  return options.length > 0 ? options : undefined
}

function projectQuestion(value: unknown): ProductTaskQuestion | null {
  if (!isRecord(value)) return null
  const question = visibleString(value.question, MAX_QUESTION_TEXT_LENGTH)
  if (!question) return null
  const header = visibleString(value.header, MAX_OPTION_TEXT_LENGTH)
  const options = projectQuestionOptions(value.options)
  return {
    question,
    ...(header ? { header } : {}),
    ...(options ? { options } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  }
}

export function projectAnswerableAskUserQuestions(input: unknown): ProductTaskQuestion[] {
  if (!isRecord(input)) return []

  const candidates = Array.isArray(input.questions) ? input.questions : [input]
  if (candidates.length === 0 || candidates.length > MAX_QUESTION_COUNT) return []

  const answerKeys = new Set<string>()
  const questions: ProductTaskQuestion[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.question !== 'string') return []
    const projected = projectQuestion(candidate)
    if (!projected || projected.question !== candidate.question || answerKeys.has(candidate.question)) return []
    answerKeys.add(candidate.question)
    questions.push(projected)
  }
  return questions
}

/** Project TodoWrite only after the tool itself has succeeded. */
export function projectProductTaskPlan(input: unknown, runId: string, toolUseId: string): ProductTaskPlan | null {
  if (!isRecord(input) || !Array.isArray(input.todos) || input.todos.length === 0 || input.todos.length > MAX_PLAN_STEP_COUNT) return null
  const steps: ProductTaskPlanStep[] = []
  let inProgress = 0
  for (const todo of input.todos) {
    if (!isRecord(todo) || Object.keys(todo).length !== 2) return null
    const content = visibleString(todo.content, MAX_PLAN_STEP_LENGTH)
    if (!content || content !== todo.content || !['pending', 'in_progress', 'completed'].includes(todo.status as string)) return null
    if (todo.status === 'in_progress') inProgress += 1
    steps.push({ content, status: todo.status as ProductTaskPlanStep['status'] })
  }
  if (inProgress > 1) return null
  return {
    id: `plan_${createHash('sha256').update(`${runId}:${toolUseId}`).digest('hex').slice(0, 32)}`,
    steps,
  }
}

export function productTaskActivitySummary(
  kind: ProductTaskActivityKind,
  phase: ProductTaskActivityPhase,
  planRelated = false,
): string {
  if (planRelated) {
    switch (phase) {
      case 'started':
      case 'running':
        return '正在整理任务计划'
      case 'completed':
        return '已整理任务计划'
      case 'failed':
        return '任务计划整理未完成'
    }
  }

  const wording: Record<ProductTaskActivityKind, { active: string; completed: string; failed: string }> = {
    file_read: { active: '正在读取工作区内容', completed: '已读取工作区内容', failed: '工作区内容读取未完成' },
    file_change: { active: '正在修改工作区内容', completed: '已修改工作区内容', failed: '工作区内容修改未完成' },
    workspace: { active: '正在整理工作内容', completed: '已整理工作内容', failed: '工作内容整理未完成' },
    command: { active: '正在处理任务操作', completed: '已完成任务操作', failed: '任务操作未完成' },
    research: { active: '正在查询资料', completed: '已完成资料查询', failed: '资料查询未完成' },
    browser: { active: '正在查看网页', completed: '已完成网页查看', failed: '网页查看未完成' },
    media: { active: '正在处理素材', completed: '已完成素材处理', failed: '素材处理未完成' },
    subtask: { active: '正在协同处理事项', completed: '已完成协同事项', failed: '协同事项未完成' },
    tool: { active: '正在处理任务', completed: '已完成任务处理', failed: '任务处理未完成' },
  }
  switch (phase) {
    case 'started':
    case 'running':
      return wording[kind].active
    case 'completed':
      return wording[kind].completed
    case 'failed':
      return wording[kind].failed
  }
}
