import type { MessageEntry } from '../services/sessionService.js'

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type ProductMemorySavedData = {
  writtenCount: number
}

export function projectMemorySavedData(value: unknown): ProductMemorySavedData {
  if (!isRecord(value)) return { writtenCount: 0 }

  const writtenCount = value.writtenCount
  if (typeof writtenCount === 'number' && Number.isSafeInteger(writtenCount)) {
    return { writtenCount: Math.max(0, writtenCount) }
  }

  const writtenPaths = value.writtenPaths
  if (!Array.isArray(writtenPaths)) return { writtenCount: 0 }

  return {
    writtenCount: writtenPaths.filter((path) => typeof path === 'string' && path.trim().length > 0).length,
  }
}

function projectMemorySavedContent(content: unknown): RecordValue | null {
  if (!isRecord(content)) return null
  if (content.subtype === 'memory_saved') {
    return {
      subtype: 'memory_saved',
      ...projectMemorySavedData(content),
    }
  }

  // Team transcripts retain the raw `message` envelope around system events.
  // Normalize only this known event so the existing desktop history mapper can
  // render the same count-only product payload as ordinary session history.
  if (content.role === 'system' && isRecord(content.content) && content.content.subtype === 'memory_saved') {
    return {
      subtype: 'memory_saved',
      ...projectMemorySavedData(content.content),
    }
  }

  return null
}

export function projectSessionMessagesForProduct(messages: MessageEntry[]): MessageEntry[] {
  return messages.map((message) => {
    if (message.type !== 'system') {
      return message
    }

    const content = projectMemorySavedContent(message.content)
    if (!content) return message

    return {
      ...message,
      content,
    }
  })
}
