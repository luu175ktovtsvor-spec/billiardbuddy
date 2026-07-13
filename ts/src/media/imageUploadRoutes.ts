import { basename, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { detectImageFormat, getImageDimensions, isVisionSupported } from '../tools/imageRead'

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000

export async function saveLocalImageAttachment(stateRoot: string, req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return jsonDetailError('file required', 400)

  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return jsonDetailError('图片文件大小不合法', 413)

  const format = detectImageFormat(bytes)
  if (!format || !isVisionSupported(format) || !['png', 'jpeg', 'webp'].includes(format)) {
    return jsonDetailError('图片格式或内容不合法', 400)
  }
  const dimensions = getImageDimensions(bytes, format)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return jsonDetailError('图片尺寸不合法', 400)
  }

  const ext = format === 'png' ? '.png' : format === 'webp' ? '.webp' : '.jpg'
  const rel = `/uploads/local/attach-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`
  const directory = join(stateRoot, 'uploads', 'local')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, basename(rel)), bytes)
  return Response.json({ url: rel, width: dimensions.width, height: dimensions.height, format })
}

function jsonDetailError(detail: string, status: number): Response {
  return Response.json({ detail }, { status })
}
