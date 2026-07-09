// 文件读写健壮性辅助,对齐 cc-haha 参考源(~/Desktop/cc-haha-ref)的三点行为:
// 1) 危险设备路径拦截 —— 移植自 src/tools/FileReadTool/FileReadTool.ts:97-129(BLOCKED_DEVICE_PATHS + isBlockedDevicePath)
// 2) UTF-16/UTF-8-BOM 编码探测 —— 移植自 src/utils/fileRead.ts:20-49(detectEncodingForResolvedPath)与
//    src/utils/file.ts:100-118(detectFileEncoding 的 try/catch→utf8 兜底)
// 3) 整文件读大小上限 —— 对齐 src/utils/file.ts:48(MAX_OUTPUT_SIZE = 0.25MB)与
//    src/tools/FileEditTool/FileEditTool.ts:84(MAX_EDIT_FILE_SIZE = 1GiB)
// cc 用 GrowthBook 远程配置 + env var 覆盖这些默认值,本项目没有对应基建,先固定为 cc 的默认值。
import { open } from 'node:fs/promises'

/**
 * cc 只拦"读了会挂进程"的设备文件:要么永远读不到 EOF(无限输出),要么阻塞等输入。
 * /dev/null 故意不拦(cc 原文如此,读它是安全、有意义的操作)。
 * 只做路径字符串比较,不做任何 I/O。
 */
const BLOCKED_DEVICE_PATHS = new Set([
  // 无限输出 —— 永远读不到 EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // 阻塞等输入
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // 读了没有意义
  '/dev/stdout',
  '/dev/stderr',
  // stdin/stdout/stderr 的 fd 别名
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

export function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // Linux 下 /proc/self/fd/0-2、/proc/<pid>/fd/0-2 是 stdio 的别名
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') || filePath.endsWith('/fd/1') || filePath.endsWith('/fd/2'))
  ) {
    return true
  }
  return false
}

/**
 * 从已读入内存的 buffer 头部探测编码。只识别 UTF-16LE BOM(FF FE)否则一律当 utf8——
 * 与 cc 的 detectEncodingForResolvedPath 逐字对齐(EF BB BF 分支同样落回 'utf8',
 * 因为 Buffer.toString('utf8') 本就不会剥离 BOM 字符,把它当普通字符处理即可原样往返)。
 */
export function detectEncodingFromBuffer(buffer: Buffer): BufferEncoding {
  if (buffer.length === 0) return 'utf8'
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'
  return 'utf8'
}

/**
 * 只窥探已存在文件的头 4096 字节来判断编码(不读整文件),供 write_file 覆盖前决定
 * 用什么编码写回。文件不存在/读取失败一律回落 utf8,对齐 cc file.ts:100-118 的容错策略。
 */
export async function detectFileEncoding(absPath: string): Promise<BufferEncoding> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(absPath, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, 4096, 0)
    return detectEncodingFromBuffer(buffer.subarray(0, bytesRead))
  } catch {
    return 'utf8'
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** cc 的 Read 工具在“整文件读”(没给 offset/limit)展示前会剥掉开头的 BOM 字符。 */
export function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 对齐 cc src/utils/file.ts:48 MAX_OUTPUT_SIZE —— 整文件读(不带 start_line/end_line)的字节上限。 */
export const FULL_READ_MAX_BYTES = 256 * 1024

/** 对齐 cc FileEditTool.ts:84 MAX_EDIT_FILE_SIZE —— 防止编辑巨型文件时整读进内存 OOM。 */
export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024
