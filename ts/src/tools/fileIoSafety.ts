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

/**
 * 二进制扩展名黑名单 —— 移植自 cc src/constants/files.ts BINARY_EXTENSIONS。
 * read_file 对这些扩展名的文件不当文本硬读(会吐乱码),直接给友好报错;PDF 与图片虽也在广义二进制里,
 * 但由 read_file 分别走文档/视觉通道原生渲染,故在调用点单独排除(见 fileReadTool)。
 */
export const BINARY_EXTENSIONS = new Set<string>([
  // 图片(图片有独立视觉分支,这里仅用于"看起来是二进制"的通用判定)
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  // 视频
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  // 音频
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  // 压缩包
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  // 可执行/二进制
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib', '.app', '.msi', '.deb', '.rpm',
  // 文档(PDF 在此;read_file 在调用点单独排除走文档通道)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // 字体
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // 字节码/VM 产物
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  // 数据库
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  // 设计/3D
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  // Flash
  '.swf', '.fla',
  // 锁/性能数据
  '.lockb', '.dat', '.data',
])

/** 路径扩展名是否命中二进制黑名单(对齐 cc hasBinaryExtension;不做 I/O)。 */
export function hasBinaryExtension(filePath: string): boolean {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
}

/**
 * 内容启发式:窥探 buffer 头部判断是不是二进制(用于扩展名伪装/无扩展名的文件,防当 UTF-8 读成乱码)。
 * 规则:出现 NUL(0x00)即判二进制(文本文件几乎不含 NUL);或"控制字符"(除常见 \t\n\r\f\b 与 ESC)
 * 占比过高也判二进制。UTF-16/BOM 交由 detectEncodingFromBuffer 走文本路,这里对 utf16le BOM 放行不误判。
 */
export function looksBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 4096)
  if (len === 0) return false
  // UTF-16LE BOM → 文本路已能正确解码,别误判为二进制。
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return false
  let suspicious = 0
  for (let i = 0; i < len; i++) {
    const c = buffer[i]!
    if (c === 0x00) return true
    // 允许:tab(9) LF(10) FF(12) CR(13) BS(8) ESC(27),其余 0x00-0x08/0x0e-0x1f 为可疑控制字符。
    if ((c < 0x08) || (c > 0x0d && c < 0x1b) || c === 0x1c || c === 0x1d || c === 0x1e || c === 0x1f) suspicious++
  }
  return suspicious / len > 0.3
}

/** 对齐 cc FileEditTool.ts:84 MAX_EDIT_FILE_SIZE —— 防止编辑巨型文件时整读进内存 OOM。 */
export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024
