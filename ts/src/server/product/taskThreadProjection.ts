import { createHash } from 'node:crypto'
import type {
  ProductTaskActivityKind,
  ProductTaskAttachmentSummary,
  ProductTaskThread,
  ProductTaskThreadEntry,
} from '../../../shared/product/taskEvents.js'
import { productTaskActivityKindForTool } from './taskEventProjection.js'
import {
  projectProductTaskUserContent,
  sanitizeProductTaskVisibleText,
} from './taskAttachmentProjection.js'

type RecordValue = Record<string, unknown>

export type ProductLegacyCoreMessageEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  timestamp: string
}

const MAX_THREAD_TEXT_LENGTH = 100_000

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function visibleText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > MAX_THREAD_TEXT_LENGTH
    ? `${trimmed.slice(0, MAX_THREAD_TEXT_LENGTH)}…`
    : trimmed
}

function entryId(message: ProductLegacyCoreMessageEntry, suffix: string): string {
  const digest = createHash('sha256')
    .update(`${message.id}:${suffix}`)
    .digest('hex')
    .slice(0, 20)
  return `thread_${digest}`
}

function createdAt(message: ProductLegacyCoreMessageEntry): string {
  return typeof message.timestamp === 'string' && Number.isFinite(Date.parse(message.timestamp))
    ? message.timestamp
    : new Date(0).toISOString()
}

function textEntry(
  message: ProductLegacyCoreMessageEntry,
  suffix: string,
  type: 'user_text' | 'assistant_text',
  text: string,
  attachments?: ProductTaskAttachmentSummary[],
): ProductTaskThreadEntry {
  const entry = {
    id: entryId(message, suffix),
    type,
    text,
    createdAt: createdAt(message),
  }
  return type === 'user_text'
    ? {
        ...entry,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }
    : entry
}

function activityEntry(
  message: ProductLegacyCoreMessageEntry,
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

function assistantEntries(message: ProductLegacyCoreMessageEntry): ProductTaskThreadEntry[] {
  if (typeof message.content === 'string') {
    const text = visibleText(message.content)
    const safeText = text ? sanitizeProductTaskVisibleText(text) : ''
    return safeText ? [textEntry(message, 'assistant', 'assistant_text', safeText)] : []
  }
  if (!Array.isArray(message.content)) return []

  const entries: ProductTaskThreadEntry[] = []
  for (const [index, block] of message.content.entries()) {
    if (!isRecord(block)) continue
    if (block.type === 'text') {
      const text = visibleText(block.text)
      const safeText = text ? sanitizeProductTaskVisibleText(text) : ''
      if (safeText) entries.push(textEntry(message, `assistant-text:${index}`, 'assistant_text', safeText))
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

function userEntries(message: ProductLegacyCoreMessageEntry): ProductTaskThreadEntry[] {
  const visibleContent = typeof message.content === 'string'
    ? visibleText(message.content)
    : Array.isArray(message.content)
      ? message.content
        .filter(isRecord)
        .flatMap((block) => {
          if (block.type !== 'text') return [block]
          const text = visibleText(block.text)
          return text ? [{ ...block, text }] : []
        })
      : null
  if (!visibleContent || (Array.isArray(visibleContent) && visibleContent.length === 0)) return []

  const projected = projectProductTaskUserContent(visibleContent)
  return projected
    ? [textEntry(message, 'user', 'user_text', projected.text, projected.attachments)]
    : []
}

function toolResultEntries(message: ProductLegacyCoreMessageEntry): ProductTaskThreadEntry[] {
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
 * Resolve a product-visible text entry back to the retained Core message
 * entirely on the server. Product clients pass only the hashed entry id, so a
 * side-task or continuation action never receives a Core transcript id.
 */
export function resolveCoreMessageIdForProductThreadEntry(
  messages: readonly ProductLegacyCoreMessageEntry[],
  productEntryId: string,
): string | null {
  for (const message of messages) {
    const entries = message.type === 'user'
      ? userEntries(message)
      : message.type === 'assistant' || message.type === 'tool_use'
        ? assistantEntries(message)
        : []
    if (entries.some((entry) => entry.id === productEntryId && (
      entry.type === 'user_text' || entry.type === 'assistant_text'
    ))) {
      return message.id
    }
  }
  return null
}

/**
 * Convert a retained Agent Core transcript into the product thread view.
 * This is another whitelist boundary: only ordinary user/assistant text and
 * completed activity survive; reasoning, tool payloads, system messages,
 * provider metadata and usage never leave the server.
 */
export function projectSessionTranscriptForProductTask(
  taskId: string,
  messages: readonly ProductLegacyCoreMessageEntry[],
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
