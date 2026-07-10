/**
 * 集中式调试日志(P0 最小闸门版 · Wave A,审计 `16-trace-errors.md` #1.1)。
 *
 * cc 对应 `utils/debug.ts`:per-session `.txt` + `~/.claude/debug/latest` 符号链接 + verbose 分级过滤。
 * 这里先打最小闸门 —— 全仓统一一个落盘点 `<stateRoot>/logs/debug.log`(按大小轮转),不建 per-session
 * 文件/符号链接(那是更完整的 Wave B 活),换掉当前仓库仅有的几处零散 `console.error`/`console.warn`,
 * 并给 sidecar 入口的顶层崩溃兜底(见 `processCrashGuard.ts`,#6.1)用。
 *
 * 默认只落 warn/error;env `QF_DEBUG_LOG` 真值时连 debug/info 也落(兼容仓库里已有的
 * `BILLIARDBUDDY_DEBUG`/`DEBUG` 触发习惯,别让开发者已有的调试开关突然失效)。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getUserConfigHomeDir } from '../harness/memoryNames'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** debug.log 单文件轮转阈值(5MB)与保留份数(`.1`.. `.3`,超出直接丢弃最旧的)。 */
const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_ROTATED_DEBUG_FILES = 3

/** `crash-*.log` 最多保留最近 N 份;文件名含 ISO 时间戳,字典序即时间序,超出按最旧优先删。 */
const MAX_CRASH_FILES = 20

export type LoggerEnv = Record<string, string | undefined>

export interface LoggerOptions {
  /** 显式覆盖日志目录(测试 / sidecar 早期尚未起 stateRoot 时可传);缺省按 resolveDefaultLogDir() 解析。 */
  logDir?: string
  env?: LoggerEnv
  /** 测试专用:覆盖 debug.log 轮转阈值(字节)/保留份数;生产不传,吃默认值(5MB / 3 份)。 */
  maxLogBytes?: number
  maxRotatedFiles?: number
  /** 测试专用:覆盖 crash-*.log 保留份数;生产不传,吃默认值(20 份)。 */
  maxCrashFiles?: number
}

/**
 * 默认日志目录:`<stateRoot>/logs`。stateRoot 解析规则与 `server/index.ts` 的 `resolveStateRoot` 同款
 * (env `BILLIARDBUDDY_STATE_DIR` 覆盖优先,否则 `~/.billiardbuddy/state`)。不直接 import
 * `server/index.ts`——那是个巨大的入口文件,logger 是最底层 util,不该反向依赖它;这里独立复刻
 * 这 3 行小逻辑,换来的是彻底解耦(避免潜在的 import 环)。
 */
export function resolveDefaultLogDir(env: LoggerEnv = process.env): string {
  const override = env.BILLIARDBUDDY_STATE_DIR
  const stateRoot = override && override.length > 0 ? override : join(getUserConfigHomeDir(), 'state')
  return join(stateRoot, 'logs')
}

/** env 真值判定(1/true/yes/on,大小写无关;与仓库里其它 isEnvTruthy 写法一致)。 */
function isEnvTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function isVerboseEnabled(env: LoggerEnv): boolean {
  return isEnvTruthy(env.QF_DEBUG_LOG) || isEnvTruthy(env.BILLIARDBUDDY_DEBUG) || isEnvTruthy(env.DEBUG)
}

function safeStringify(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta)
  } catch {
    return '"[unserializable meta]"'
  }
}

function formatLine(moduleName: string, level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const metaStr = meta && Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : ''
  return `[${ts}] [${level.toUpperCase()}] [${moduleName}] ${message}${metaStr}\n`
}

/** debug.log 超过阈值时轮转:`debug.log` → `.1` → `.2` → `.3`(挤出最旧的直接丢弃)。 */
function rotateDebugLogIfNeeded(filePath: string, maxBytes: number, maxRotated: number): void {
  try {
    if (statSync(filePath).size < maxBytes) return
  } catch {
    return // 文件不存在,不用轮转
  }
  for (let i = maxRotated; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`
    const dst = `${filePath}.${i}`
    if (!existsSync(src)) continue
    try {
      if (existsSync(dst)) rmSync(dst)
      renameSync(src, dst)
    } catch {
      // 轮转失败不阻塞写日志本身,下次再试。
    }
  }
}

function writeLine(logDir: string, line: string, maxBytes: number, maxRotated: number): void {
  try {
    mkdirSync(logDir, { recursive: true })
    const filePath = join(logDir, 'debug.log')
    rotateDebugLogIfNeeded(filePath, maxBytes, maxRotated)
    appendFileSync(filePath, line, 'utf8')
  } catch {
    // 日志系统自身绝不能抛出打崩调用方;写失败静默丢弃 —— 只退化日志能力,不影响主流程。
  }
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

/**
 * 拿一个绑定 moduleName 的 logger,写 `<stateRoot>/logs/debug.log`。
 * 默认只落 warn/error;env `QF_DEBUG_LOG`(或兼容 `BILLIARDBUDDY_DEBUG`/`DEBUG`)真值时连 debug/info 也落。
 * 不做全仓撒点(那是 Wave B 的活),先把"出问题后有本地文件可翻"这条底闸打上。
 */
export function getLogger(moduleName: string, options: LoggerOptions = {}): Logger {
  const env = options.env ?? process.env
  const logDir = options.logDir ?? resolveDefaultLogDir(env)
  const maxBytes = options.maxLogBytes ?? MAX_LOG_BYTES
  const maxRotated = options.maxRotatedFiles ?? MAX_ROTATED_DEBUG_FILES
  const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    const threshold = isVerboseEnabled(env) ? LEVEL_ORDER.debug : LEVEL_ORDER.warn
    if (LEVEL_ORDER[level] < threshold) return
    writeLine(logDir, formatLine(moduleName, level, message, meta), maxBytes, maxRotated)
  }
  return {
    debug: (message, meta) => log('debug', message, meta),
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 崩溃日志:每次崩溃单独一个文件(不混进 debug.log 的滚动流),便于整份翻看"哪次崩的、崩成什么样"。
// 供 `processCrashGuard.ts` 的顶层 uncaughtException/unhandledRejection 兜底调用。
// ─────────────────────────────────────────────────────────────────────────────

export type CrashKind = 'uncaughtException' | 'unhandledRejection'

/** 进程内单调递增序号,拼进文件名防止同一毫秒内连续多次崩溃时文件名撞车(Date 只精确到 ms,
 * 高频崩溃场景下真会撞)。定长补零 + 时间戳前缀,sort() 后依旧严格等于真实调用顺序。 */
let crashLogSeq = 0

/**
 * 把一次未捕获异常 / 未处理 rejection 写成 `<logDir>/crash-<ISO时间戳>-<序号>-<kind>.log`,
 * 内容含时间/类型/message/stack。写完顺带裁剪:只保留最近 `MAX_CRASH_FILES` 份。
 * 写失败静默吞(崩溃兜底本身绝不能再抛一次)。返回实际写入的文件路径(写失败则 undefined,便于测试断言)。
 */
export function writeCrashLog(
  kind: CrashKind,
  detail: { message: string; stack?: string },
  options: LoggerOptions = {},
): string | undefined {
  const env = options.env ?? process.env
  const logDir = options.logDir ?? resolveDefaultLogDir(env)
  const now = new Date()
  const safeTs = now.toISOString().replace(/[:.]/g, '-')
  const seq = String(crashLogSeq++).padStart(6, '0')
  const filePath = join(logDir, `crash-${safeTs}-${seq}-${kind}.log`)
  const content = [
    `time: ${now.toISOString()}`,
    `kind: ${kind}`,
    `message: ${detail.message}`,
    detail.stack ? `stack:\n${detail.stack}` : 'stack: (none)',
    '',
  ].join('\n')
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(filePath, content, 'utf8')
    pruneOldCrashLogs(logDir, options.maxCrashFiles ?? MAX_CRASH_FILES)
    return filePath
  } catch {
    return undefined
  }
}

/** 只保留最近 `maxFiles` 份 `crash-*.log`;文件名含 ISO 时间戳,字典序排序即时间序。 */
function pruneOldCrashLogs(logDir: string, maxFiles: number): void {
  try {
    const files = readdirSync(logDir)
      .filter(name => name.startsWith('crash-') && name.endsWith('.log'))
      .sort()
    const excess = files.length - maxFiles
    if (excess <= 0) return
    for (const name of files.slice(0, excess)) {
      try {
        rmSync(join(logDir, name))
      } catch {
        // 单个删失败不影响其它;下次崩溃再清一次。
      }
    }
  } catch {
    // 目录读不到就不裁剪,不阻塞崩溃日志本身已经写成功这件事。
  }
}
