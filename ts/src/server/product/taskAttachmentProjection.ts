import type { ProductTaskAttachmentSummary } from '../../../shared/product/taskEvents.js'

type RecordValue = Record<string, unknown>

const MAX_ATTACHMENT_NAME_LENGTH = 160
const MAX_ATTACHMENT_COUNT = 16
const SAFE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'webp'])
const PRIVATE_TRANSCRIPT_MARKUP = /<(?:teammate-message|command-message|local-command-(?:stdout|stderr)|system-reminder|task-notification|user-prompt-submit-hook|hook-[\w-]+)\b/i
const UUID_UPLOAD_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i
const CORE_ATTACHMENT_FALLBACK_PROMPTS = new Set([
  'Please analyze the attached files.',
  'Please analyze the attached image.',
])

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isImageMetadataText(value: string): boolean {
  return /^\[Image(?:\s+source:|:)/i.test(value.trim())
}

function imageSourcePathFromMetadata(value: string): string | null {
  if (!isImageMetadataText(value)) return null
  const source = /(?:^|\b)source:\s*([^,\]\r\n]+)/i.exec(value.trim())?.[1]?.trim()
  return source || null
}

function stripUnsafeTransportContent(value: string): string {
  const withoutDataUrls = value
    // Treat every data: token as opaque. Transcript recovery may encounter a
    // malformed or truncated base64 payload, which still must not be echoed.
    .replace(/\bdata:[^\s<>"']+/gi, '')
    .replace(/\bfile:\/\/[^\s<>"']+/gi, '')
    .replace(/~\/[^\s<>"']+/g, '')
    .replace(/[A-Za-z]:\\(?:[^\\\s<>"']+\\)*[^\\\s<>"']+/g, '')

  // Only redact path-shaped values. The leading separator is retained so the
  // surrounding sentence remains readable while absolute workspace/upload
  // paths cannot reach the product surface.
  return withoutDataUrls.replace(
    /(^|[\s([{'"=:])(\/(?:[^/\s<>"']+\/)+[^/\s<>"']+)/g,
    (_match, prefix: string) => prefix,
  )
}

/**
 * Remove transcript-only attachment transport details before text is rendered
 * in the product. This is intentionally usable for both user and assistant
 * text because a model reply can echo an upload path or a data URL too.
 */
export function sanitizeProductTaskVisibleText(value: string): string {
  const withoutImageMetadata = value
    .split(/\r?\n/)
    .filter((line) => !isImageMetadataText(line))
    .join('\n')
  const trimmed = withoutImageMetadata.trim()
  if (!trimmed || PRIVATE_TRANSCRIPT_MARKUP.test(trimmed) || isImageMetadataText(trimmed)) {
    return ''
  }

  return normalizeText(stripUnsafeTransportContent(
    trimmed.replace(/@"[^"\r\n]*"/g, ''),
  ))
}

function extensionOf(name: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(name)
  return match?.[1]?.toLowerCase() ?? null
}

function displayNameFromPath(value: string, fallback: string): string {
  if (/^(?:data:|file:)/i.test(value.trim())) return fallback
  const candidate = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .at(-1)
  const baseName = candidate
    ? candidate
      .replace(UUID_UPLOAD_PREFIX, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
    : ''

  if (!baseName) return fallback
  return baseName.slice(0, MAX_ATTACHMENT_NAME_LENGTH)
}

function attachmentFromPath(value: string): ProductTaskAttachmentSummary {
  const name = displayNameFromPath(value, '文件附件')
  return IMAGE_EXTENSIONS.has(extensionOf(name) ?? '')
    ? { type: 'image', name }
    : { type: 'file', name }
}

function safeImageMimeType(value: unknown): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | undefined {
  if (typeof value !== 'string') return undefined
  const mimeType = value.trim().toLowerCase()
  return SAFE_IMAGE_MIME_TYPES.has(mimeType)
    ? mimeType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
    : undefined
}

function imageAttachmentFromBlock(value: RecordValue): ProductTaskAttachmentSummary {
  const source = isRecord(value.source) ? value.source : null
  const mimeType = safeImageMimeType(source?.media_type)
  return {
    type: 'image',
    name: '图片附件',
    ...(mimeType ? { mimeType } : {}),
  }
}

function attachmentOnlyText(attachments: readonly ProductTaskAttachmentSummary[]): string {
  return attachments.length === 1 ? '已添加附件' : `已添加 ${attachments.length} 个附件`
}

function normalizeAttachmentSummary(value: unknown): ProductTaskAttachmentSummary | null {
  if (!isRecord(value) || (value.type !== 'file' && value.type !== 'image') || typeof value.name !== 'string') {
    return null
  }
  const name = displayNameFromPath(value.name, value.type === 'image' ? '图片附件' : '文件附件')
  const mimeType = value.type === 'image' ? safeImageMimeType(value.mimeType) : undefined
  return {
    type: value.type,
    name,
    ...(mimeType ? { mimeType } : {}),
  }
}

function boundedAttachments(
  attachments: readonly unknown[],
): ProductTaskAttachmentSummary[] {
  const safeAttachments: ProductTaskAttachmentSummary[] = []
  for (const attachment of attachments) {
    const normalized = normalizeAttachmentSummary(attachment)
    if (!normalized) continue
    safeAttachments.push(normalized)
    if (safeAttachments.length === MAX_ATTACHMENT_COUNT) break
  }
  return safeAttachments
}

function projectTextBlock(value: string): {
  text: string
  attachments: ProductTaskAttachmentSummary[]
} {
  const attachments: ProductTaskAttachmentSummary[] = []
  const withoutAttachmentReferences = value.replace(/@"([^"\r\n]+)"/g, (_match, reference: string) => {
    attachments.push(attachmentFromPath(reference))
    return ''
  })
  return {
    text: sanitizeProductTaskVisibleText(withoutAttachmentReferences),
    attachments,
  }
}

/**
 * Build a product-safe user transcript value from Agent Core content.  The
 * source can contain opaque image blocks, upload paths, and data URLs; this
 * projection retains only a person-readable attachment label and optional
 * whitelisted image MIME type.
 */
export function projectProductTaskUserContent(
  content: unknown,
): { text: string; attachments: ProductTaskAttachmentSummary[] } | null {
  const blocks = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter(isRecord)
      : []
  if (blocks.length === 0) return null

  const textParts: string[] = []
  const fileAttachments: ProductTaskAttachmentSummary[] = []
  const images: ProductTaskAttachmentSummary[] = []
  const imageSourcePaths: string[] = []

  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(imageAttachmentFromBlock(block))
      continue
    }
    if (block.type !== 'text' || typeof block.text !== 'string') continue

    const imageSourcePath = imageSourcePathFromMetadata(block.text)
    if (isImageMetadataText(block.text)) {
      if (imageSourcePath) imageSourcePaths.push(imageSourcePath)
      continue
    }

    const projected = projectTextBlock(block.text)
    if (projected.text) textParts.push(projected.text)
    fileAttachments.push(...projected.attachments)
  }

  const imageAttachments = images.map((image, index) => {
    const sourcePath = imageSourcePaths[index]
    return sourcePath
      ? { ...image, name: displayNameFromPath(sourcePath, image.name) }
      : image
  })
  const unpairedMetadataImages = imageSourcePaths
    .slice(images.length)
    .map((sourcePath) => ({
      type: 'image' as const,
      name: displayNameFromPath(sourcePath, '图片附件'),
    }))
  const attachments = boundedAttachments([
    ...fileAttachments,
    ...imageAttachments,
    ...unpairedMetadataImages,
  ])
  const text = normalizeText(textParts.join('\n'))

  if (!text && attachments.length === 0) return null
  return {
    text: !text || (attachments.length > 0 && CORE_ATTACHMENT_FALLBACK_PROMPTS.has(text))
      ? attachmentOnlyText(attachments)
      : text,
    attachments,
  }
}

/**
 * Safely project a replay string when the full Core content is unavailable.
 * Server-side replay plumbing can provide attachment summaries from the full
 * content; when it does, those summaries take precedence over path inference
 * from the flattened text so duplicate labels are not introduced.
 */
export function projectProductTaskUserReplay(
  text: string,
  attachments: readonly ProductTaskAttachmentSummary[] = [],
): { text: string; attachments: ProductTaskAttachmentSummary[] } | null {
  const projected = projectProductTaskUserContent(text)
  const safeAttachments = boundedAttachments(attachments)
  const selectedAttachments = safeAttachments.length > 0
    ? safeAttachments
    : projected?.attachments ?? []
  const baseText = projected?.text ?? sanitizeProductTaskVisibleText(text)
  const visibleText = selectedAttachments.length > 0 && CORE_ATTACHMENT_FALLBACK_PROMPTS.has(baseText)
    ? attachmentOnlyText(selectedAttachments)
    : baseText

  if (!visibleText && selectedAttachments.length === 0) return null
  return {
    text: visibleText || attachmentOnlyText(selectedAttachments),
    attachments: selectedAttachments,
  }
}
