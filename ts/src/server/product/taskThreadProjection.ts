import { createHash } from 'node:crypto'
import type { ProductTaskActivityKind, ProductTaskThread, ProductTaskThreadEntry } from '../../../shared/product/taskEvents.js'
import type { MessageEntry } from '../services/sessionService.js'
import { productTaskActivityKindForTool } from './taskEventProjection.js'

type RecordValue = Record<string, unknown>

const MAX_THREAD_TEXT_LENGTH = 100_000
const PRIVATE_TRANSCRIPT_MARKUP = /<(?:teammate-message|command-message|local-command-(?:stdout|stderr)|system-reminder|task-notification|user-prompt-submit-hook|hook-[\w-]+)\b/i

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function visibleText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || PRIVATE_TRANSCRIPT_MARKUP.test(trimmed)) return null
  return trimmed.length > MAX_THREAD_TEXT_LENGTH
    ? `${trimmed.slice(0, MAX_THREAD_TEXT_LENGTH)}…`
    : trimmed
}

function entryId(message: MessageEntry, suffix: string): string {
  const digest = createHash('sha256')
    .update(`${message.id}:${suffix}`)
    .digest('hex')
    .slice(0, 20)
  return `thread_${digest}`
}

function createdAt(message: MessageEntry): string {
  return typeof message.timestamp === 'string' && Number.isFinite(Date.parse(message.timestamp))
    ? message.timestamp
    : new Date(0).toISOString()
}

function textEntry(
  message: MessageEntry,
  suffix: string,
  type: 'user_text' | 'assistant_text',
  text: string,
): ProductTaskThreadEntry {
  return {
    id: entryId(message, suffix),
    type,
    text,
    createdAt: createdAt(message),
  }
}

function activityEntry(
  message: MessageEntry,
  suffix: string,
  kind: ProductTaskActivityKind,
  phase: 'completed' | 'failed' = 'completed',
): ProductTaskThreadEntry {
  return {
    id: entryId(message, suffix),
    type: 'activity',
    kind,
    phase,
    createdAt: createdAt(message),
  }
}

function assistantEntries(message: MessageEntry): ProductTaskThreadEntry[] {
  if (typeof message.content === 'string') {
    const text = visibleText(message.content)
    return text ? [textEntry(message, 'assistant', 'assistant_text', text)] : []
  }
  if (!Array.isArray(message.content)) return []

  const entries: ProductTaskThreadEntry[] = []
  for (const [index, block] of message.content.entries()) {
    if (!isRecord(block)) continue
    if (block.type === 'text') {
      const text = visibleText(block.text)
      if (text) entries.push(textEntry(message, `assistant-text:${index}`, 'assistant_text', text))
      continue
    }
    if (block.type === 'tool_use') {
      entries.push(activityEntry(
        message,
        `assistant-tool:${index}`,
        productTaskActivityKindForTool(typeof block.name === 'string' ? block.name : undefined),
      ))
    }
  }
  return entries
}

function userEntries(message: MessageEntry): ProductTaskThreadEntry[] {
  if (typeof message.content === 'string') {
    const text = visibleText(message.content)
    return text ? [textEntry(message, 'user', 'user_text', text)] : []
  }
  if (!Array.isArray(message.content)) return []

  const visibleParts = message.content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => visibleText(block.text))
    .filter((text): text is string => text !== null)
  if (visibleParts.length === 0) return []
  return [textEntry(message, 'user-blocks', 'user_text', visibleParts.join('\n'))]
}

function toolResultEntries(message: MessageEntry): ProductTaskThreadEntry[] {
  if (Array.isArray(message.content)) {
    const entries: ProductTaskThreadEntry[] = []
    for (const [index, block] of message.content.entries()) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      entries.push(activityEntry(
        message,
        `tool-result:${index}`,
        'tool',
        block.is_error === true ? 'failed' : 'completed',
      ))
    }
    return entries
  }
  return [activityEntry(message, 'tool-result', 'tool')]
}

/**
 * Convert a retained Agent Core transcript into the product thread view.
 * This is another whitelist boundary: only ordinary user/assistant text and
 * completed activity survive; reasoning, tool payloads, system messages,
 * provider metadata and usage never leave the server.
 */
export function projectSessionTranscriptForProductTask(
  taskId: string,
  messages: readonly MessageEntry[],
): ProductTaskThread {
  const entries: ProductTaskThreadEntry[] = []
  for (const message of messages) {
    if (message.type === 'user') {
      entries.push(...userEntries(message))
      continue
    }
    if (message.type === 'assistant' || message.type === 'tool_use') {
      entries.push(...assistantEntries(message))
      continue
    }
    if (message.type === 'tool_result') {
      entries.push(...toolResultEntries(message))
    }
  }
  return { taskId, entries }
}
