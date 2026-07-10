/**
 * 计划模式的**计划文件落盘**(对齐 cc `src/utils/plans.ts` 的
 * getPlansDirectory / getPlanSlug / getPlanFilePath / getPlan)。
 *
 * cc 里计划模式下模型把方案**增量写进一个磁盘文件**(唯一可编辑的文件),ExitPlanMode 不再吃
 * 计划正文参数、而是从这个文件读。我们此前把计划只当成 exit_plan 的工具参数、从不落盘——跨轮会话
 * 一压缩/清空就丢,也没法用 read_file 复看。这里把 cc 那套「计划=真文件」搬过来。
 *
 * 白标铁律:
 *  • 目录名走白标 `.billiardbuddy`(= memoryNames.MEMORY_DOT_DIR),绝不 `.claude`/`plans` 挂在 cc 目录下。
 *  • 因本仓库 write_file/edit_file 是**工作区边界内**才放行(见 workspace.ts),cc 默认的全局
 *    `~/.claude/plans` 会撞工作区边界。故采用 cc 同样支持的**项目内相对目录**(cc settings.plansDirectory
 *    project-relative 分支):`<workspace.root>/.billiardbuddy/plans/`。模型用 write_file/edit_file 就能写、
 *    产物随项目走,也不必给工作区外目录开额外授权。
 *
 * 与 cc 的结构差异(适配本仓库「ctx 显式穿参、无全局 getSessionId()」):cc 的 getPlanSlug()/
 * getPlanFilePath() 隐式取全局 session;我们把 workspaceRoot + sessionId(= ToolContext.conversationId)
 * 显式当参数传。slug 按 sessionId 缓存(同一会话跨轮拿到同一份计划文件)。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { MEMORY_DOT_DIR } from './memoryNames'

/** 计划文件子目录名(cc: 'plans')。 */
export const PLANS_SUBDIR = 'plans'
const MAX_SLUG_RETRIES = 10
const DEFAULT_SESSION_KEY = 'default'

// 会话 → 计划 slug 缓存(cc: getPlanSlugCache)。首次访问惰性生成、整段会话复用同一份计划文件。
const planSlugCache = new Map<string, string>()
// 已 ensure 过的计划目录缓存(仿 cc getPlansDirectory 的 memoize:避免每次权限检查都 mkdirSync 一次)。
const ensuredPlansDirs = new Map<string, string>()

/** 计划目录路径(纯拼接,不建目录)。 */
function plansDirPath(workspaceRoot: string): string {
  return join(workspaceRoot, MEMORY_DOT_DIR, PLANS_SUBDIR)
}

/**
 * 计划目录(cc getPlansDirectory):`<workspace.root>/.billiardbuddy/plans/`,确保存在(recursive mkdir,
 * 已存在即 no-op)。按 root memoize,权限热路径重复调用不再反复 syscall。
 */
export function getPlansDirectory(workspaceRoot: string): string {
  const cached = ensuredPlansDirs.get(workspaceRoot)
  if (cached) return cached
  const dir = plansDirPath(workspaceRoot)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 尽力而为:目录建不出(权限/只读盘)不抛;真正写文件时 write_file 会再 mkdir 并报清晰错误。
  }
  ensuredPlansDirs.set(workspaceRoot, dir)
  return dir
}

/**
 * 取/生成本会话计划文件的 word slug(cc getPlanSlug)。惰性生成 + 会话内缓存;若同名文件已存在则重试
 * 最多 10 次换一个不冲突的 slug。
 */
export function getPlanSlug(workspaceRoot: string, sessionId?: string): string {
  const id = sessionId ?? DEFAULT_SESSION_KEY
  let slug = planSlugCache.get(id)
  if (!slug) {
    const dir = plansDirPath(workspaceRoot)
    for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
      slug = generateWordSlug()
      if (!existsSync(join(dir, `${slug}.md`))) break
    }
    planSlugCache.set(id, slug!)
  }
  return slug!
}

/** 指定会话用某个固定 slug(cc setPlanSlug:恢复会话时用)。 */
export function setPlanSlug(sessionId: string, slug: string): void {
  planSlugCache.set(sessionId, slug)
}

/** 清掉某会话的 slug(cc clearPlanSlug:/clear 时确保下次用新文件)。 */
export function clearPlanSlug(sessionId?: string): void {
  planSlugCache.delete(sessionId ?? DEFAULT_SESSION_KEY)
}

/** 清掉所有会话的 slug(cc clearAllPlanSlugs;也供测试隔离)。 */
export function clearAllPlanSlugs(): void {
  planSlugCache.clear()
}

/**
 * 本会话计划文件的绝对路径(cc getPlanFilePath)。
 * 主会话:`{plansDir}/{slug}.md`;子代理:`{plansDir}/{slug}-agent-{agentId}.md`。
 * 纯路径拼接(会 ensure 目录存在,但不建文件)。
 */
export function getPlanFilePath(workspaceRoot: string, sessionId?: string, agentId?: string): string {
  const slug = getPlanSlug(workspaceRoot, sessionId)
  const dir = getPlansDirectory(workspaceRoot)
  return agentId ? join(dir, `${slug}-agent-${agentId}.md`) : join(dir, `${slug}.md`)
}

/**
 * 读本会话计划文件正文(cc getPlan)。文件不存在(模型还没写计划)返回 null;其它读错也返回 null。
 */
export function getPlan(workspaceRoot: string, sessionId?: string, agentId?: string): string | null {
  try {
    return readFileSync(getPlanFilePath(workspaceRoot, sessionId, agentId), { encoding: 'utf-8' })
  } catch {
    return null
  }
}

/**
 * 判断某个入参路径是否**就是本会话的计划文件**(权限层 plan 模式写豁免用;对齐 cc
 * permissions/filesystem.ts isSessionPlanFile)。不走 workspace.resolve(那会对越界路径抛错),纯
 * 解析+归一后与 getPlanFilePath 比对。
 */
export function isSessionPlanFile(workspaceRoot: string, inputPath: string, sessionId?: string, agentId?: string): boolean {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return false
  const abs = isAbsolute(inputPath) ? resolvePath(inputPath) : resolvePath(workspaceRoot, inputPath)
  return abs === getPlanFilePath(workspaceRoot, sessionId, agentId)
}

// ─────────────────────────────────────────────────────────────────────────────
// word slug 生成(对齐 cc utils/words.ts generateWordSlug:"形容词-动词-名词",crypto 随机)。
// 词表按 cc 风格取一小撮悦耳中性词(不照搬 800 行);组合空间足够避免同会话文件名撞车。
// ─────────────────────────────────────────────────────────────────────────────

const ADJECTIVES = [
  'ancient', 'bright', 'calm', 'cheerful', 'clever', 'cozy', 'curious', 'dapper', 'dazzling', 'eager',
  'elegant', 'fancy', 'gentle', 'gleaming', 'golden', 'graceful', 'happy', 'hidden', 'humble', 'jolly',
  'keen', 'kind', 'lively', 'lovely', 'lucky', 'mellow', 'merry', 'mighty', 'misty', 'noble',
  'peaceful', 'playful', 'polished', 'quiet', 'quirky', 'radiant', 'serene', 'shiny', 'swift', 'witty',
] as const

const VERBS = [
  'brewing', 'building', 'charting', 'dancing', 'drifting', 'exploring', 'flowing', 'gliding', 'growing', 'humming',
  'jumping', 'leaping', 'mapping', 'mixing', 'pondering', 'racing', 'roaming', 'sailing', 'shaping', 'shining',
  'sketching', 'soaring', 'sorting', 'sparking', 'spinning', 'strolling', 'tinkering', 'weaving', 'wandering', 'zooming',
] as const

const NOUNS = [
  'anchor', 'beacon', 'canyon', 'comet', 'compass', 'ember', 'falcon', 'forest', 'garden', 'harbor',
  'island', 'lantern', 'lighthouse', 'meadow', 'meteor', 'orchard', 'phoenix', 'prism', 'reef', 'river',
  'summit', 'thicket', 'tide', 'trail', 'valley', 'voyage', 'willow', 'wisp', 'zephyr', 'zenith',
] as const

function randomInt(max: number): number {
  const bytes = randomBytes(4)
  const value = bytes.readUInt32BE(0)
  return value % max
}

function pickRandom<T>(array: readonly T[]): T {
  return array[randomInt(array.length)]!
}

/** 生成 "形容词-动词-名词" 的随机 slug(cc generateWordSlug),例:"gleaming-brewing-phoenix"。 */
export function generateWordSlug(): string {
  return `${pickRandom(ADJECTIVES)}-${pickRandom(VERBS)}-${pickRandom(NOUNS)}`
}
