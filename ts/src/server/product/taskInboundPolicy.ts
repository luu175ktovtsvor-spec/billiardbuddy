import { projectAnswerableAskUserQuestions } from './taskEventProjection.js'

/**
 * Product task sockets are a browser-visible, task-scoped boundary rather than
 * a second transport for the Agent Core protocol. Every accepted action is a
 * narrow product contract; Core session ids, raw tool input, runtime settings,
 * and permission mutation payloads never cross this boundary.
 */

export type ProductTaskAttachment = {
  type: 'file' | 'image'
  name?: string
  data: string
  mimeType: string
}

export type ProductTaskInboundMessage =
  | { type: 'user_message'; content: string; attachments?: ProductTaskAttachment[] }
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'ask_user_question_response'; requestId: string; answers: string[] }
  | { type: 'computer_use_permission_response'; requestId: string; allowed: boolean }
  | { type: 'stop_generation' }
  | { type: 'ping' }

const MAX_PRODUCT_USER_MESSAGE_LENGTH = 32_000
const MAX_PRODUCT_ATTACHMENT_COUNT = 4
const MAX_PRODUCT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_PRODUCT_ATTACHMENT_DATA_URL_LENGTH = Math.ceil((MAX_PRODUCT_ATTACHMENT_BYTES * 4) / 3) + 256
const MAX_PRODUCT_ATTACHMENT_NAME_LENGTH = 160
const MAX_PRODUCT_REQUEST_ID_LENGTH = 200
const MAX_PRODUCT_QUESTION_COUNT = 8
const MAX_PRODUCT_ANSWER_LENGTH = 4_000
const MAX_PRODUCT_ANSWER_TOTAL_LENGTH = 16_000

const PRODUCT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const PRODUCT_FILE_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

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

function parseDataUrl(value: string): { mimeType: string; byteLength: number } | null {
  if (value.length > MAX_PRODUCT_ATTACHMENT_DATA_URL_LENGTH) return null
  const match = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value)
  if (!match) return null

  const encoded = match[2]
  if (encoded.length % 4 !== 0) return null

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  return {
    mimeType: match[1].toLowerCase(),
    byteLength: (encoded.length / 4) * 3 - padding,
  }
}

function parseProductTaskAttachment(value: unknown): ProductTaskAttachment | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'name', 'data', 'mimeType']) ||
    (value.type !== 'file' && value.type !== 'image') ||
    typeof value.data !== 'string' ||
    typeof value.mimeType !== 'string'
  ) {
    return null
  }

  const parsedData = parseDataUrl(value.data)
  const mimeType = value.mimeType.trim().toLowerCase()
  if (
    !parsedData ||
    parsedData.byteLength <= 0 ||
    parsedData.byteLength > MAX_PRODUCT_ATTACHMENT_BYTES ||
    mimeType !== parsedData.mimeType ||
    (value.type === 'image'
      ? !PRODUCT_IMAGE_MIME_TYPES.has(mimeType)
      : !PRODUCT_FILE_MIME_TYPES.has(mimeType))
  ) {
    return null
  }

  if (value.name !== undefined && typeof value.name !== 'string') return null
  const name = value.name?.trim()
  if (name && name.length > MAX_PRODUCT_ATTACHMENT_NAME_LENGTH) return null

  return {
    type: value.type,
    data: value.data,
    mimeType,
    ...(name ? { name } : {}),
  }
}

function parseProductTaskAttachments(value: unknown): ProductTaskAttachment[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PRODUCT_ATTACHMENT_COUNT) {
    return null
  }

  const attachments: ProductTaskAttachment[] = []
  let totalBytes = 0
  for (const candidate of value) {
    const attachment = parseProductTaskAttachment(candidate)
    if (!attachment) return null

    const parsedData = parseDataUrl(attachment.data)
    if (!parsedData) return null
    totalBytes += parsedData.byteLength
    if (totalBytes > MAX_PRODUCT_ATTACHMENT_TOTAL_BYTES) return null

    attachments.push(attachment)
  }

  return attachments
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
 * prewarming. Attachments are inline, bounded data URLs only: product clients
 * cannot send filesystem paths or directories. Slash commands remain ordinary
 * task text: the existing session command parser is the authority for their
 * semantics.
 */
export function parseProductTaskInboundMessage(value: unknown): ProductTaskInboundMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  switch (value.type) {
    case 'user_message': {
      if (
        !hasOnlyKeys(value, ['type', 'content', 'attachments']) ||
        typeof value.content !== 'string'
      ) {
        return null
      }

      const content = value.content.trim()
      const attachments = value.attachments === undefined
        ? undefined
        : parseProductTaskAttachments(value.attachments)
      if (
        content.length > MAX_PRODUCT_USER_MESSAGE_LENGTH ||
        (value.attachments !== undefined && !attachments) ||
        (!content && !attachments)
      ) {
        return null
      }

      return {
        type: 'user_message',
        content,
        ...(attachments ? { attachments } : {}),
      }
    }

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

    case 'computer_use_permission_response': {
      if (
        !hasOnlyKeys(value, ['type', 'requestId', 'allowed']) ||
        typeof value.allowed !== 'boolean'
      ) {
        return null
      }
      const requestId = parseRequestId(value.requestId)
      return requestId
        ? { type: 'computer_use_permission_response', requestId, allowed: value.allowed }
        : null
    }

    case 'stop_generation':
    case 'ping':
      return hasOnlyKeys(value, ['type']) ? { type: value.type } : null

    default:
      return null
  }
}
