export type ComposerAttachment = {
  id: string
  name: string
  type: 'image' | 'file'
  mimeType?: string
  previewUrl?: string
  data?: string
}

function nextAttachmentId() {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Product task transport has no filesystem-path capability. Use this helper
 * for files the user intentionally picked in its composer, including in the
 * desktop renderer where File objects can otherwise expose a native path.
 */
export async function filesToInlineComposerAttachments(
  files: FileList | File[],
): Promise<ComposerAttachment[]> {
  const attachments = await Promise.all(
    Array.from(files).map(fileToComposerAttachment),
  )
  return attachments.filter((attachment): attachment is ComposerAttachment => !!attachment)
}

async function fileToComposerAttachment(file: File): Promise<ComposerAttachment | null> {
  const isImage = file.type.startsWith('image/')
  const data = await readFileAsDataUrl(file)
  return {
    id: nextAttachmentId(),
    name: file.name,
    type: isImage ? 'image' : 'file',
    mimeType: file.type || undefined,
    previewUrl: isImage ? data : undefined,
    data,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`))
    reader.readAsDataURL(file)
  })
}
