import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ProductTaskAttachmentSummary } from '../../../shared/product/taskEvents.js'

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_DATA_URL_LENGTH = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 256

const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

export type VerifiedProductAttachment = {
  bytes: Buffer
  contentHash: string
  sourceFingerprint: string
  mediaType: string
  safeName: string
}

function validUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

function matchesMediaType(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mediaType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  if (mediaType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mediaType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  if (mediaType === 'application/json') {
    const text = validUtf8(bytes)
    if (text === null) return false
    try { JSON.parse(text); return true } catch { return false }
  }
  if (['text/plain', 'text/markdown', 'text/csv'].includes(mediaType)) return validUtf8(bytes) !== null
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return bytes.includes(Buffer.from('word/document.xml'))
  if (mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return bytes.includes(Buffer.from('xl/workbook.xml'))
  return false
}

function safeAttachmentName(name: string, mediaType: string): string | null {
  const extension = EXTENSION_BY_MIME_TYPE[mediaType]
  if (!extension) return null
  const base = path.basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f"']/g, '')
    .trim()
  if (!base || base.length > 160) return null
  const stem = base.replace(/\.[A-Za-z0-9]{1,12}$/, '').trim() || '附件'
  return `${stem.slice(0, 150 - extension.length)}${extension}`
}

export function verifyProductAttachmentInput(input: {
  type: 'file' | 'image'
  name: string
  mime_type: string
  data: string
}): VerifiedProductAttachment | null {
  if (input.data.length > MAX_DATA_URL_LENGTH) return null
  const mediaType = input.mime_type.trim().toLowerCase()
  const extension = EXTENSION_BY_MIME_TYPE[mediaType]
  if (!extension || (input.type === 'image') !== mediaType.startsWith('image/')) return null
  const match = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(input.data)
  if (!match || match[1]!.toLowerCase() !== mediaType || match[2]!.length % 4 !== 0) return null
  const bytes = Buffer.from(match[2]!, 'base64')
  if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES || !matchesMediaType(bytes, mediaType)) return null
  const safeName = safeAttachmentName(input.name, mediaType)
  if (!safeName) return null
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const sourceFingerprint = createHash('sha256')
    .update(mediaType).update('\0').update(safeName).update('\0').update(contentHash)
    .digest('hex')
  return { bytes, contentHash, sourceFingerprint, mediaType, safeName }
}

export function productAttachmentStorageRoot(storagePath: string): string {
  return path.join(path.dirname(storagePath), 'product-task-attachments')
}

export async function storeProductAttachmentCopy(
  root: string,
  attachmentId: string,
  attachment: VerifiedProductAttachment,
): Promise<string> {
  const directory = path.join(root, attachmentId)
  const target = path.join(directory, attachment.safeName)
  const temporary = path.join(directory, `.${randomUUID()}.tmp`)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(temporary, attachment.bytes, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  return target
}

export async function resolveProductAttachmentCopy(
  root: string,
  attachmentId: string,
  expectedHash: string,
  expectedBytes: number,
): Promise<string> {
  const directory = path.join(root, attachmentId)
  const names = (await fs.readdir(directory)).filter(name => !name.startsWith('.'))
  if (names.length !== 1) throw new Error('ATTACHMENT_COPY_INVALID')
  const target = path.join(directory, names[0]!)
  const bytes = await fs.readFile(target)
  if (bytes.length !== expectedBytes || createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('ATTACHMENT_COPY_INVALID')
  return target
}

export function productAttachmentSummary(filePath: string, mediaType: string): ProductTaskAttachmentSummary {
  return mediaType.startsWith('image/')
    ? { type: 'image', name: path.basename(filePath), mimeType: mediaType as ProductTaskAttachmentSummary['mimeType'] }
    : { type: 'file', name: path.basename(filePath) }
}
