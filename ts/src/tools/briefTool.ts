import { stat } from 'node:fs/promises'
import type { Tool, ToolContext } from './Tool'

export const SEND_USER_MESSAGE_TOOL_NAME = 'SendUserMessage'
export const BRIEF_TOOL_NAME = 'Brief'

interface SendUserMessageInput {
  message?: string
  attachments?: string[]
  status?: 'normal' | 'proactive' | string
}

interface ResolvedAttachment {
  path: string
  size: number
  isImage: boolean
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif)$/i

const inputSchema = {
  type: 'object' as const,
  properties: {
    message: {
      type: 'string',
      description: 'The message the user should read. Supports markdown formatting.',
    },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional file paths, absolute or workspace-relative, to attach for the user.',
    },
    status: {
      type: 'string',
      enum: ['normal', 'proactive'],
      description: 'normal when replying to the user; proactive when surfacing an unsolicited update, blocker, or completion.',
    },
  },
  required: ['message', 'status'],
}

const description = [
  'Send a message the user will read. CC-Haha-compatible SendUserMessage/Brief output channel.',
  'Use this for concise user-visible replies, status checkpoints, blockers, or completed background work.',
  'Input: { message, attachments?, status }. status is "normal" for replies and "proactive" for unsolicited updates.',
].join(' ')

function recordInput(input: unknown): SendUserMessageInput {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as SendUserMessageInput : {}
}

function statusFrom(value: unknown): 'normal' | 'proactive' {
  if (value === 'normal' || value === 'proactive') return value
  throw new Error('SendUserMessage status must be "normal" or "proactive"')
}

function attachmentPaths(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('SendUserMessage attachments must be an array of paths')
  return value.map(item => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('SendUserMessage attachments must be non-empty path strings')
    return item.trim()
  })
}

async function resolveAttachments(paths: string[], ctx: ToolContext): Promise<ResolvedAttachment[]> {
  const resolved: ResolvedAttachment[] = []
  for (const path of paths) {
    const abs = ctx.workspace.resolve(path, 'read')
    const info = await stat(abs)
    if (!info.isFile()) throw new Error(`Attachment "${path}" is not a regular file.`)
    resolved.push({
      path: abs,
      size: info.size,
      isImage: IMAGE_EXT_RE.test(abs),
    })
  }
  return resolved
}

async function executeSendUserMessage(input: unknown, ctx: ToolContext): Promise<string> {
  const args = recordInput(input)
  if (typeof args.message !== 'string' || !args.message.trim()) throw new Error('SendUserMessage requires non-empty string message')
  const status = statusFrom(args.status)
  const attachments = await resolveAttachments(attachmentPaths(args.attachments), ctx)
  const sentAt = new Date().toISOString()
  const attachmentLines = attachments.map(item =>
    `<attachment path="${xmlAttr(item.path)}" size="${item.size}" is_image="${item.isImage ? 'true' : 'false'}" />`,
  )
  return [
    `<user_message_delivered status="${status}" sent_at="${xmlAttr(sentAt)}" attachments="${attachments.length}">`,
    '<message>',
    xmlText(args.message),
    '</message>',
    ...attachmentLines,
    '</user_message_delivered>',
  ].join('\n')
}

export const sendUserMessageTool: Tool<SendUserMessageInput> = {
  name: SEND_USER_MESSAGE_TOOL_NAME,
  description,
  inputSchema,
  isReadOnly: true,
  async execute(input, ctx) {
    return executeSendUserMessage(input, ctx)
  },
}

export const briefCompatTool: Tool<SendUserMessageInput> = {
  ...sendUserMessageTool,
  name: BRIEF_TOOL_NAME,
  description: `${description} Legacy alias for SendUserMessage.`,
  async execute(input, ctx) {
    return executeSendUserMessage(input, ctx)
  },
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}
