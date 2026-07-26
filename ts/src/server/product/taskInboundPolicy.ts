import { projectAnswerableAskUserQuestions } from './taskEventProjection.js'

/**
 * Product task sockets are a browser-visible, task-scoped boundary rather than
 * a second transport for the Agent Core protocol. Every accepted action is a
 * narrow product contract; Core session ids, raw tool input, runtime settings,
 * and permission mutation payloads never cross this boundary.
 */

export type ProductTaskInboundMessage =
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'ask_user_question_response'; requestId: string; answers: string[] }
  | { type: 'stop_generation' }
  | { type: 'ping' }

const MAX_PRODUCT_REQUEST_ID_LENGTH = 200
const MAX_PRODUCT_QUESTION_COUNT = 8
const MAX_PRODUCT_ANSWER_LENGTH = 4_000
const MAX_PRODUCT_ANSWER_TOTAL_LENGTH = 16_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function parseRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const requestId = value.trim()
  if (
    !requestId ||
    requestId.length > MAX_PRODUCT_REQUEST_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(requestId)
  ) {
    return null
  }
  return requestId
}

function parseProductTaskAnswers(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRODUCT_QUESTION_COUNT) {
    return null
  }

  const answers: string[] = []
  let totalLength = 0
  for (const candidate of value) {
    if (typeof candidate !== 'string') return null
    const answer = candidate.trim()
    if (!answer || answer.length > MAX_PRODUCT_ANSWER_LENGTH) return null
    totalLength += answer.length
    if (totalLength > MAX_PRODUCT_ANSWER_TOTAL_LENGTH) return null
    answers.push(answer)
  }

  return answers
}

/**
 * Synthesize the one Core-specific AskUserQuestion field from server-owned
 * pending input. The browser supplies only ordered answer strings; it never
 * sends or receives the original tool input envelope.
 */
export function buildProductTaskAskUserQuestionUpdatedInput(
  input: Record<string, unknown>,
  answers: readonly string[],
): Record<string, unknown> | null {
  const safeAnswers = parseProductTaskAnswers(answers)
  if (!safeAnswers) return null

  const candidates = Array.isArray(input.questions) ? input.questions : [input]
  const projectedQuestions = projectAnswerableAskUserQuestions(input)
  const questionKeys = candidates.map((candidate) => (
    isRecord(candidate) && typeof candidate.question === 'string'
      ? candidate.question
      : null
  ))
  if (
    questionKeys.length === 0 ||
    questionKeys.some((question) => question === null) ||
    questionKeys.length !== projectedQuestions.length ||
    questionKeys.length !== safeAnswers.length ||
    new Set(questionKeys).size !== questionKeys.length
  ) {
    return null
  }

  return {
    ...input,
    answers: Object.fromEntries(questionKeys.map((question, index) => [question!, safeAnswers[index]!])),
  }
}

/**
 * Parse the public product-task websocket input. In particular, do not pass
 * through Agent Core permission payloads, runtime/configuration commands, or
 * prewarming. User input and attachments use the durable HTTP submit contract,
 * never this presentation socket.
 */
export function parseProductTaskInboundMessage(value: unknown): ProductTaskInboundMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  switch (value.type) {
    case 'permission_response': {
      if (
        !hasOnlyKeys(value, ['type', 'requestId', 'allowed']) ||
        typeof value.allowed !== 'boolean'
      ) {
        return null
      }
      const requestId = parseRequestId(value.requestId)
      return requestId
        ? { type: 'permission_response', requestId, allowed: value.allowed }
        : null
    }

    case 'ask_user_question_response': {
      if (!hasOnlyKeys(value, ['type', 'requestId', 'answers'])) return null
      const requestId = parseRequestId(value.requestId)
      const answers = parseProductTaskAnswers(value.answers)
      return requestId && answers
        ? { type: 'ask_user_question_response', requestId, answers }
        : null
    }

    case 'stop_generation':
    case 'ping':
      return hasOnlyKeys(value, ['type']) ? { type: value.type } : null

    default:
      return null
  }
}
