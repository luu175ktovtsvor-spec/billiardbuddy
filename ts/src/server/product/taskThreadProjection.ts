import { createHash } from 'node:crypto'
import type {
  ProductTaskActivityKind,
  ProductTaskAttachmentSummary,
  ProductTaskMediaDraft,
  ProductTaskThread,
  ProductTaskThreadEntry,
} from '../../../shared/product/taskEvents.js'
import type { MessageEntry } from '../services/sessionService.js'
import { productTaskActivityKindForTool } from './taskEventProjection.js'
import {
  projectProductTaskUserContent,
  sanitizeProductTaskVisibleText,
} from './taskAttachmentProjection.js'

type RecordValue = Record<string, unknown>

const MAX_THREAD_TEXT_LENGTH = 100_000
const MAX_MEDIA_TOOL_RESULT_JSON_LENGTH = 32_000
const MEDIA_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,79}$/

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

function mediaDraftEntry(
  message: MessageEntry,
  suffix: string,
  draft: ProductTaskMediaDraft,
): ProductTaskThreadEntry {
  return {
    id: entryId(message, suffix),
    type: 'media_draft',
    draft,
    createdAt: createdAt(message),
  }
}

function isMediaDraftCreationInput(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.action === 'create_image_project' || value.action === 'create_video_project'
}

/**
 * Tool names, inputs and IDs stay inside this server-only lookup.  A task
 * thread can later expose only a narrow draft reference after a matching
 * successful MediaWorkbench creation result arrives.
 */
function mediaDraftCreationToolUseIds(messages: readonly MessageEntry[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (
      (message.type !== 'assistant' && message.type !== 'tool_use') ||
      !Array.isArray(message.content)
    ) {
      continue
    }
    for (const block of message.content) {
      if (
        !isRecord(block) ||
        block.type !== 'tool_use' ||
        block.name !== 'MediaWorkbench' ||
        !isMediaDraftCreationInput(block.input) ||
        typeof block.id !== 'string' ||
        block.id.length === 0 ||
        block.id.length > 512
      ) {
        continue
      }
      ids.add(block.id)
    }
  }
  return ids
}

function parseMediaDraftToolResult(value: unknown): ProductTaskMediaDraft | null {
  let result = value
  if (typeof result === 'string') {
    if (result.length === 0 || result.length > MAX_MEDIA_TOOL_RESULT_JSON_LENGTH) return null
    try {
      result = JSON.parse(result)
    } catch {
      return null
    }
  }
  if (!isRecord(result) || !isRecord(result.project)) return null

  const project = result.project
  if (
    typeof project.id !== 'string' ||
    !MEDIA_PROJECT_ID_PATTERN.test(project.id) ||
    (project.kind !== 'image' && project.kind !== 'video') ||
    project.state !== 'draft'
  ) {
    return null
  }

  return {
    projectId: project.id,
    kind: project.kind,
    state: 'draft',
  }
}

function assistantEntries(message: MessageEntry): ProductTaskThreadEntry[] {
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

function userEntries(message: MessageEntry): ProductTaskThreadEntry[] {
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

function toolResultEntries(
  message: MessageEntry,
  mediaDraftToolUseIds: ReadonlySet<string>,
): ProductTaskThreadEntry[] {
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
      if (
        block.is_error !== true &&
        typeof block.tool_use_id === 'string' &&
        mediaDraftToolUseIds.has(block.tool_use_id)
      ) {
        const draft = parseMediaDraftToolResult(block.content)
        if (draft) entries.push(mediaDraftEntry(message, `media-draft:${index}`, draft))
      }
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
  messages: readonly MessageEntry[],
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
  messages: readonly MessageEntry[],
): ProductTaskThread {
  const mediaDraftToolUseIds = mediaDraftCreationToolUseIds(messages)
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
      entries.push(...toolResultEntries(message, mediaDraftToolUseIds))
    }
  }
  return { taskId, entries }
}
