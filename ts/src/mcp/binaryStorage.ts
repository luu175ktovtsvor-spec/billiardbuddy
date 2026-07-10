// MCP 二进制内容落盘 —— 对齐 cc `utils/mcpOutputStorage.ts` 的 persistBinaryContent/extensionForMimeType:
// resource blob / 工具调用结果里的 audio(及无法识别为可视觉格式的图片)不能直接把 base64 塞进模型上下文
// (占地方且模型读不出东西),落盘后回一条"路径 + mime + 大小"的引用文本,模型/后续工具可按需再处理该文件。
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let persistCounter = 0

/**
 * mime → 文件扩展名,保守策略:认识的类型给对应扩展名(下游工具按扩展名分发,如 read_file 认 .pdf/.png),
 * 不认识的一律 .bin。对齐 cc extensionForMimeType 的映射表。
 */
export function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'bin'
  const mt = (mimeType.split(';')[0] ?? '').trim().toLowerCase()
  switch (mt) {
    case 'application/pdf': return 'pdf'
    case 'application/json': return 'json'
    case 'text/csv': return 'csv'
    case 'text/plain': return 'txt'
    case 'text/html': return 'html'
    case 'text/markdown': return 'md'
    case 'application/zip': return 'zip'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'pptx'
    case 'application/msword': return 'doc'
    case 'application/vnd.ms-excel': return 'xls'
    case 'audio/mpeg': return 'mp3'
    case 'audio/wav': return 'wav'
    case 'audio/ogg': return 'ogg'
    case 'video/mp4': return 'mp4'
    case 'video/webm': return 'webm'
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    case 'image/svg+xml': return 'svg'
    default: return 'bin'
  }
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || 'mcp'
}

export type PersistedMcpBinary = { filepath: string; size: number } | { error: string }

export interface PersistMcpBinaryOptions {
  /** 当前会话的工具结果落盘目录(ctx.toolResultStoreDir);缺省时退回系统临时目录(脱离会话态的单测/adhoc 调用)。 */
  toolResultStoreDir?: string
  /** 文件名前缀,便于用眼区分来源(如 server 名/工具名)。 */
  label: string
}

/**
 * 把 MCP 二进制内容(resource blob / 工具结果里的 audio / 非可视觉格式的 image)写到磁盘。
 * 目录选"当前会话工具结果目录下的 mcp-binary/ 子目录",与 read_stored_tool_result 的可读边界同源;
 * 没有会话态(独立跑工具/单测)时退回系统临时目录,不阻塞调用方。
 */
export async function persistMcpBinary(
  bytes: Buffer,
  mimeType: string | undefined,
  opts: PersistMcpBinaryOptions,
): Promise<PersistedMcpBinary> {
  const dir = opts.toolResultStoreDir
    ? join(opts.toolResultStoreDir, 'mcp-binary')
    : join(tmpdir(), 'qf-agent-mcp-binary')
  const ext = extensionForMimeType(mimeType)
  const id = `${Date.now()}-${(persistCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const filepath = join(dir, `${safeSegment(opts.label)}-${id}.${ext}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(filepath, bytes)
    return { filepath, size: bytes.length }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
