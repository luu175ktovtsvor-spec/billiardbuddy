import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FetchLike } from '../proxy/ProxyModel'
import type { ContentBlock, ImageBlock, TextBlock } from '../types/message'

export type BridgeInboundContent = string | ContentBlock[]

export interface BridgeInboundMessageFields {
  content: BridgeInboundContent
  uuid?: string
}

export interface InboundAttachment {
  file_uuid: string
  file_name: string
}

export interface BridgeInboundResolveOptions {
  sessionId: string
  stateRoot: string
  baseUrl?: string
  token?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
}

export interface BridgeResolvedInboundMessage {
  content: BridgeInboundContent
  uuid?: string
  attachments: InboundAttachment[]
  resolvedPaths: string[]
  prefix: string
  bridgeOrigin: true
  skipSlashCommands: true
}

const DOWNLOAD_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneContent<T extends BridgeInboundContent>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeSessionId(value: string): string {
  const raw = value.trim()
  const sessionId = raw.startsWith('bridge:') ? raw.slice('bridge:'.length) : raw
  if (!sessionId) throw new Error('sessionId is required')
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(sessionId)) throw new Error('sessionId contains unsupported characters')
  return sessionId
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('bridge inbound attachment baseUrl is required')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'))) {
    throw new Error('bridge inbound attachment baseUrl must use HTTPS or localhost HTTP')
  }
  return trimmed
}

export function detectImageFormatFromBase64(data: string): ImageBlock['source']['media_type'] {
  const header = Buffer.from(data.slice(0, 64), 'base64')
  if (header.length >= 8 && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) return 'image/png'
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
  if (header.length >= 6 && header.slice(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (header.length >= 6 && header.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (header.length >= 12 && header.slice(0, 4).toString('ascii') === 'RIFF' && header.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return 'image/png'
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'thinking') return typeof value.thinking === 'string'
  if (value.type === 'tool_use') return typeof value.id === 'string' && typeof value.name === 'string'
  if (value.type === 'tool_result') return typeof value.tool_use_id === 'string' && typeof value.content === 'string'
  if (value.type !== 'image' || !isRecord(value.source)) return false
  return value.source.type === 'base64' && typeof value.source.data === 'string'
}

function isMalformedBase64Image(block: ContentBlock): block is ImageBlock {
  if (block.type !== 'image' || block.source?.type !== 'base64') return false
  return typeof block.source.media_type !== 'string' || !block.source.media_type
}

export function normalizeImageBlocks(blocks: ContentBlock[]): ContentBlock[] {
  if (!blocks.some(isMalformedBase64Image)) return blocks
  return blocks.map(block => {
    if (!isMalformedBase64Image(block)) return block
    const source = block.source as ImageBlock['source'] & { mediaType?: unknown }
    const mediaType = typeof source.mediaType === 'string' && source.mediaType
      ? source.mediaType
      : detectImageFormatFromBase64(source.data)
    return {
      ...block,
      source: {
        type: 'base64',
        media_type: mediaType as ImageBlock['source']['media_type'],
        data: source.data,
      },
    }
  })
}

export function extractInboundMessageFields(msg: unknown): BridgeInboundMessageFields | undefined {
  if (!isRecord(msg) || msg.type !== 'user') return undefined
  const message = isRecord(msg.message) ? msg.message : null
  const content = message?.content
  if (!content) return undefined
  if (typeof content === 'string') {
    if (!content) return undefined
    return {
      content,
      uuid: typeof msg.uuid === 'string' ? msg.uuid : undefined,
    }
  }
  if (!Array.isArray(content) || content.length === 0) return undefined
  const blocks = content.filter(isContentBlock)
  if (blocks.length === 0) return undefined
  return {
    content: normalizeImageBlocks(cloneContent(blocks)),
    uuid: typeof msg.uuid === 'string' ? msg.uuid : undefined,
  }
}

export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (!isRecord(msg) || !Array.isArray(msg.file_attachments)) return []
  return msg.file_attachments.flatMap(item => {
    if (!isRecord(item) || typeof item.file_uuid !== 'string' || typeof item.file_name !== 'string') return []
    return [{ file_uuid: item.file_uuid, file_name: item.file_name }]
  })
}

export function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')
  return base || 'attachment'
}

function uploadsDir(stateRoot: string, sessionId: string): string {
  return join(stateRoot, 'bridge-uploads', normalizeSessionId(sessionId))
}

function attachmentUrl(baseUrl: string, fileUuid: string): string {
  return `${normalizeBaseUrl(baseUrl)}/api/oauth/files/${encodeURIComponent(fileUuid)}/content`
}

async function fetchWithTimeout(fetchImpl: FetchLike, input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (!timeoutMs) return fetchImpl(input, init)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function resolveOneAttachment(att: InboundAttachment, opts: BridgeInboundResolveOptions): Promise<string | undefined> {
  if (!opts.baseUrl || !opts.token) return undefined
  let data: Buffer
  try {
    const response = await fetchWithTimeout(opts.fetchImpl ?? globalThis.fetch, attachmentUrl(opts.baseUrl, att.file_uuid), {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}` },
    }, opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
    if (response.status !== 200) return undefined
    data = Buffer.from(await response.arrayBuffer())
  } catch {
    return undefined
  }

  const safeName = sanitizeFileName(att.file_name)
  const prefix = (att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '_')
  const dir = uploadsDir(opts.stateRoot, opts.sessionId)
  const outPath = join(dir, `${prefix}-${safeName}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(outPath, data)
    return outPath
  } catch {
    return undefined
  }
}

export async function resolveInboundAttachments(attachments: InboundAttachment[], opts: BridgeInboundResolveOptions): Promise<{ prefix: string; paths: string[] }> {
  if (attachments.length === 0) return { prefix: '', paths: [] }
  const paths = (await Promise.all(attachments.map(att => resolveOneAttachment(att, opts))))
    .filter((path): path is string => !!path)
  if (paths.length === 0) return { prefix: '', paths }
  return { prefix: paths.map(path => `@"${path}"`).join(' ') + ' ', paths }
}

export function prependPathRefs(content: BridgeInboundContent, prefix: string): BridgeInboundContent {
  if (!prefix) return content
  if (typeof content === 'string') return prefix + content
  const index = content.findLastIndex(block => block.type === 'text')
  if (index !== -1) {
    const block = content[index] as TextBlock
    return [
      ...content.slice(0, index),
      { ...block, text: prefix + block.text },
      ...content.slice(index + 1),
    ]
  }
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

export async function resolveAndPrependInboundMessage(msg: unknown, content: BridgeInboundContent, opts: BridgeInboundResolveOptions): Promise<BridgeResolvedInboundMessage> {
  const attachments = extractInboundAttachments(msg)
  const { prefix, paths } = await resolveInboundAttachments(attachments, opts)
  return {
    content: prependPathRefs(content, prefix),
    uuid: isRecord(msg) && typeof msg.uuid === 'string' ? msg.uuid : undefined,
    attachments,
    resolvedPaths: paths,
    prefix,
    bridgeOrigin: true,
    skipSlashCommands: true,
  }
}

export async function resolveInboundUserMessage(msg: unknown, opts: BridgeInboundResolveOptions): Promise<BridgeResolvedInboundMessage | undefined> {
  const fields = extractInboundMessageFields(msg)
  if (!fields) return undefined
  const resolved = await resolveAndPrependInboundMessage(msg, fields.content, opts)
  return { ...resolved, uuid: fields.uuid }
}
