import type { ProductTaskAttachment } from './api/taskSocket'

type ComposerAttachment = {
  id: string
  name: string
  type: 'image' | 'file'
  mimeType?: string
  data?: string
  file?: File
}

export const PRODUCT_TASK_ATTACHMENT_LIMITS = {
  count: 4,
  eachBytes: 8 * 1024 * 1024,
  videoBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
} as const

export const MAX_PRODUCT_TASK_ATTACHMENT_COUNT = PRODUCT_TASK_ATTACHMENT_LIMITS.count
export const MAX_PRODUCT_TASK_ATTACHMENT_BYTES = PRODUCT_TASK_ATTACHMENT_LIMITS.eachBytes

export type ProductTaskAttachmentDraft = ProductTaskAttachment & {
  id: string
  name: string
}

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
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
])

const PRODUCT_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
])

export type ProductTaskAttachmentValidation =
  | { ok: true; attachments: ProductTaskAttachment[] }
  | { ok: false; message: string }

function dataUrlByteLength(value: string): number | null {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value)
  const payload = match?.[1]
  if (!payload || payload.length % 4 !== 0) return null
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return (payload.length / 4) * 3 - padding
}

function hasSupportedMime(type: ProductTaskAttachment['type'], mimeType: string): boolean {
  return type === 'image'
    ? PRODUCT_IMAGE_MIME_TYPES.has(mimeType)
    : PRODUCT_FILE_MIME_TYPES.has(mimeType)
}

/**
 * Convert only browser-selected inline attachments into the small public task
 * socket shape. Native paths, directory handles, notes, and raw UI metadata
 * are intentionally not valid product input.
 */
export function validateProductTaskAttachments(
  attachments: readonly ComposerAttachment[],
): ProductTaskAttachmentValidation {
  if (attachments.length > PRODUCT_TASK_ATTACHMENT_LIMITS.count) {
    return { ok: false, message: `每次最多添加 ${PRODUCT_TASK_ATTACHMENT_LIMITS.count} 个附件。` }
  }

  let totalBytes = 0
  const result: ProductTaskAttachment[] = []
  for (const attachment of attachments) {
    const mimeType = attachment.mimeType?.trim().toLowerCase()
    const byteLength = attachment.data
      ? dataUrlByteLength(attachment.data)
      : attachment.file instanceof File
        ? attachment.file.size
        : null
    if (!mimeType || byteLength === null || !hasSupportedMime(attachment.type, mimeType)) {
      return { ok: false, message: '附件类型暂不支持。可添加图片、视频、PDF、TXT、Markdown、CSV、JSON、Word 或 Excel 文件。' }
    }
    const limit = PRODUCT_VIDEO_MIME_TYPES.has(mimeType)
      ? PRODUCT_TASK_ATTACHMENT_LIMITS.videoBytes
      : PRODUCT_TASK_ATTACHMENT_LIMITS.eachBytes
    if (byteLength <= 0 || byteLength > limit) {
      return { ok: false, message: PRODUCT_VIDEO_MIME_TYPES.has(mimeType) ? '单个视频不能超过 32 MB。' : '单个附件不能超过 8 MB。' }
    }
    totalBytes += byteLength
    if (totalBytes > PRODUCT_TASK_ATTACHMENT_LIMITS.totalBytes) {
      return { ok: false, message: '本次附件总大小不能超过 64 MB。' }
    }

    result.push(attachment.file
      ? { type: attachment.type, name: attachment.name, file: attachment.file, mimeType }
      : { type: attachment.type, name: attachment.name, data: attachment.data!, mimeType })
  }

  return { ok: true, attachments: result }
}

function nextDraftId(): string {
  return `product-attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Turn a native Browser/Preview capture into the same narrow, inline image
 * shape used by the task composer. The caller still has to validate its full
 * draft list, because this helper intentionally knows nothing about a task's
 * existing attachment count or batch size.
 */
export function createProductTaskPreviewImageDraft(
  data: string,
  name: string,
): ProductTaskAttachmentDraft | null {
  const dataUrlMatch = /^data:([^;,]+);base64,/i.exec(data)
  const mimeType = dataUrlMatch?.[1]?.trim().toLowerCase()
  const normalizedName = name.trim()
  if (!mimeType || !normalizedName || normalizedName.length > 160) return null

  const candidate: ComposerAttachment = {
    id: nextDraftId(),
    type: 'image',
    name: normalizedName,
    mimeType,
    data,
  }
  const validation = validateProductTaskAttachments([candidate])
  if (!validation.ok) return null

  return {
    id: candidate.id,
    type: 'image',
    name: normalizedName,
    mimeType,
    data,
  }
}

function productAttachmentType(mimeType: string): ProductTaskAttachment['type'] | null {
  if (PRODUCT_IMAGE_MIME_TYPES.has(mimeType)) return 'image'
  if (PRODUCT_FILE_MIME_TYPES.has(mimeType)) return 'file'
  return null
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Attachment reader returned no data'))
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

/**
 * Read browser-selected files for the task page. Documents and images remain
 * small inline drafts; bounded videos retain their browser File and are sent
 * as multipart bytes, never as an Electron-native path or base64 socket frame.
 */
export async function readProductTaskAttachmentDrafts(
  files: readonly File[],
  availableSlots: number = MAX_PRODUCT_TASK_ATTACHMENT_COUNT,
): Promise<{ attachments: ProductTaskAttachmentDraft[]; rejectedCount: number }> {
  const limit = Math.max(0, Math.min(availableSlots, MAX_PRODUCT_TASK_ATTACHMENT_COUNT))
  const candidates = files.slice(0, limit)
  let rejectedCount = Math.max(0, files.length - candidates.length)
  let totalBytes = 0
  const attachments: ProductTaskAttachmentDraft[] = []

  for (const file of candidates) {
    const mimeType = file.type.trim().toLowerCase()
    const type = productAttachmentType(mimeType)
    if (
      !type ||
      !file.name.trim() ||
      file.name.length > 160 ||
      file.size <= 0 ||
      file.size > (PRODUCT_VIDEO_MIME_TYPES.has(mimeType)
        ? PRODUCT_TASK_ATTACHMENT_LIMITS.videoBytes
        : MAX_PRODUCT_TASK_ATTACHMENT_BYTES) ||
      totalBytes + file.size > PRODUCT_TASK_ATTACHMENT_LIMITS.totalBytes
    ) {
      rejectedCount += 1
      continue
    }

    try {
      if (PRODUCT_VIDEO_MIME_TYPES.has(mimeType)) {
        attachments.push({
          id: nextDraftId(),
          type,
          name: file.name.trim(),
          mimeType,
          file,
        })
        totalBytes += file.size
        continue
      }
      const data = await readFileAsDataUrl(file)
      const byteLength = dataUrlByteLength(data)
      if (byteLength === null || byteLength !== file.size) {
        rejectedCount += 1
        continue
      }
      attachments.push({
        id: nextDraftId(),
        type,
        name: file.name.trim(),
        mimeType,
        data,
      })
      totalBytes += file.size
    } catch {
      rejectedCount += 1
    }
  }

  return { attachments, rejectedCount }
}
