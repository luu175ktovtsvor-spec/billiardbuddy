/**
 * 分层指令/记忆文件加载器 —— **直接移植 cc-haha `src/utils/claudemd.ts`(1479 行,权威分层加载)**,
 * 按 LICENSE 允许复制/改写。改动点(架构不同的适配,均有注释标明):
 *
 *  A. 名字全走 memoryNames.ts(白标:BILLIARDBUDDY.md 这套,绝不用 CLAUDE.md/.claude)。
 *  B. 无 `marked` 依赖 → 自写「代码围栏/行内代码/HTML 注释」感知的注释剥离 + @import 抽取
 *     (cc 用 marked Lexer;我们没这个包,自己实现同等行为,tests 兜边界)。
 *  C. 无 `ignore` 依赖 → 条件规则 paths glob 用 `picomatch`,并按 gitignore 语义补 `pattern/**`
 *     还原「目录 pattern 命中其内所有」的效果(cc: `ignore().add(globs).ignores(rel)`)。
 *  D. Project 层遍历**限定在 workspace.root**(cc 从 CWD 一路 walk 到文件系统根;我们的 workspace.root
 *     就是项目根,不越界 walk 到沙箱之外——更安全,也让加载确定可测)。因此 cc 那段
 *     nested-worktree 去重(依赖 findGitRoot/findCanonicalGitRoot)天然用不上、不移植:
 *     bounded walk 不会经过父级主仓根,realpath 级 processedPaths 去重仍覆盖 symlink/同一物理文件。
 *  E. 去掉 cc 的 AutoMem/TeamMem/analytics/hooks/全局 memoize(与本波无关);各层开关走
 *     MemoryLoadOptions + 环境变量(对齐 cc isSettingSourceEnabled/claudeMdExcludes 的「各层可关」)。
 *
 * 四层加载顺序(反优先级,越靠后越高,cc 头部注释 1-16):Managed → User → Project(根到 CWD 逐级)→ Local。
 */

import { lstatSync, realpathSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'
import type { Workspace } from '../workspace/workspace'
import {
  getDotDirMainPath,
  getManagedRulesDir,
  getMemoryPath,
  getProjectRulesDir,
  getUserRulesDir,
  MEMORY_DOT_DIR,
  MEMORY_LOCAL_FILE,
  MEMORY_MAIN_FILE,
  MEMORY_RULES_SUBDIR,
  type MemorySettingSource,
  type MemoryType,
} from './memoryNames'

export type { MemoryType } from './memoryNames'

// cc claudemd.ts:89-90 —— 注入前缀。品牌中性,不含 "Claude" 字样,直接照抄(白标安全)。
const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'

// cc claudemd.ts:92 —— 单个记忆文件建议的最大字符数(仅用于「大文件」标记,不截断)。
export const MAX_MEMORY_CHARACTER_COUNT = 40000

// cc claudemd.ts:537 —— @include 递归深度上限。
const MAX_INCLUDE_DEPTH = 5

// cc claudemd.ts:96-227 —— @include 允许的文本扩展名白名单(挡二进制:图片/PDF 等不进记忆)。整块照抄。
const TEXT_FILE_EXTENSIONS = new Set([
  '.md', '.txt', '.text',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.pyi', '.pyw',
  '.rb', '.erb', '.rake',
  '.go',
  '.rs',
  '.java', '.kt', '.kts', '.scala',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs',
  '.swift',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.env', '.ini', '.cfg', '.conf', '.config', '.properties',
  '.sql', '.graphql', '.gql',
  '.proto',
  '.vue', '.svelte', '.astro',
  '.ejs', '.hbs', '.pug', '.jade',
  '.php', '.pl', '.pm', '.lua', '.r', '.R', '.dart',
  '.ex', '.exs', '.erl', '.hrl',
  '.clj', '.cljs', '.cljc', '.edn',
  '.hs', '.lhs', '.elm', '.ml', '.mli',
  '.f', '.f90', '.f95', '.for',
  '.cmake', '.make', '.makefile', '.gradle', '.sbt',
  '.rst', '.adoc', '.asciidoc', '.org', '.tex', '.latex',
  '.lock',
  '.log', '.diff', '.patch',
])

// cc claudemd.ts:229-243 —— MemoryFileInfo 类型直接搬(去掉 AutoMem 相关注释细节)。
export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // 引入此文件的文件路径(@import 时)
  globs?: string[] // 条件规则:frontmatter paths glob
  // 自动注入把 content 改写(剥了 frontmatter / HTML 注释)导致与磁盘字节不一致时置真;
  // 此时 rawContent 存原始字节,供上层做 read-state 缓存去重。
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具:移植 cc 依赖的纯函数(path/fs 层),用 node: 原生实现。
// ─────────────────────────────────────────────────────────────────────────────

/** cc utils/file.ts:565-577 normalizePathForComparison —— 规范化路径用于比较(Windows 大小写不敏感)。 */
function normalizePathForComparison(filePath: string): string {
  let normalized = normalize(filePath)
  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//g, '\\').toLowerCase()
  }
  return normalized
}

/** cc utils/path.ts:32-85 expandPath —— 展开 ~ / 绝对 / 相对(相对 baseDir),NFC 规范化。(去掉 Windows POSIX 转换分支) */
function expandPath(path: string, baseDir?: string): string {
  const actualBaseDir = baseDir ?? process.cwd()
  if (typeof path !== 'string') throw new TypeError(`Path must be a string, received ${typeof path}`)
  if (path.includes('\0') || actualBaseDir.includes('\0')) throw new Error('Path contains null bytes')
  const trimmedPath = path.trim()
  if (!trimmedPath) return normalize(actualBaseDir).normalize('NFC')
  if (trimmedPath === '~') return homedir().normalize('NFC')
  if (trimmedPath.startsWith('~/')) return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  if (isAbsolute(trimmedPath)) return normalize(trimmedPath).normalize('NFC')
  return resolve(actualBaseDir, trimmedPath).normalize('NFC')
}

/** cc utils/fsOperations.ts:138-179 safeResolvePath —— 解析 symlink 到真实路径;挡 UNC / 特殊文件类型防阻塞。 */
function safeResolvePath(filePath: string): { resolvedPath: string; isSymlink: boolean } {
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false }
  }
  try {
    const stats = lstatSync(filePath)
    if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
      return { resolvedPath: filePath, isSymlink: false }
    }
    const resolvedPath = realpathSync(filePath)
    return { resolvedPath, isSymlink: resolvedPath !== filePath }
  } catch {
    return { resolvedPath: filePath, isSymlink: false }
  }
}

/** target 是否在 base 之内(含相等)。用于 @import 的「外部文件」判定(cc pathInOriginalCwd)。 */
function isPathInside(base: string, target: string): boolean {
  const rel = relative(resolve(base), resolve(target))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function getErrnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// frontmatter 解析(移植 cc utils/frontmatterParser.ts,用 Bun.YAML)。
// ─────────────────────────────────────────────────────────────────────────────

// cc frontmatterParser.ts:123
const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/
// cc frontmatterParser.ts:79 —— 需要加引号的 YAML 特殊字符(让 **/*.{ts,tsx} 这类 glob 能解析)。
const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /

// cc frontmatterParser.ts:85-121 quoteProblematicValues —— 给含特殊字符的裸值加引号后重试解析。
function quoteProblematicValues(frontmatterText: string): string {
  const lines = frontmatterText.split('\n')
  const result: string[] = []
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_-]+):\s+(.+)$/)
    if (match) {
      const [, key, value] = match
      if (!key || !value) {
        result.push(line)
        continue
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        result.push(line)
        continue
      }
      if (YAML_SPECIAL_CHARS.test(value)) {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        result.push(`${key}: "${escaped}"`)
        continue
      }
    }
    result.push(line)
  }
  return result.join('\n')
}

function parseYaml(text: string): Record<string, unknown> | null {
  try {
    // Bun 全局(项目已用于 commands/frontmatter.ts)。
    const parsed = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// cc frontmatterParser.ts:130-175 parseFrontmatter —— 提取 frontmatter + 去掉 frontmatter 后的正文(正文不 trim)。
export function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = markdown.match(FRONTMATTER_REGEX)
  if (!match) return { frontmatter: {}, content: markdown }
  const frontmatterText = match[1] || ''
  const content = markdown.slice(match[0].length)
  let frontmatter: Record<string, unknown> = {}
  const parsed = parseYaml(frontmatterText)
  if (parsed) frontmatter = parsed
  else {
    const retry = parseYaml(quoteProblematicValues(frontmatterText))
    if (retry) frontmatter = retry
  }
  return { frontmatter, content }
}

// cc frontmatterParser.ts:189-232 splitPathInFrontmatter —— 逗号分隔(尊重花括号)+ 展开花括号。整块照抄。
export function splitPathInFrontmatter(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(splitPathInFrontmatter)
  if (typeof input !== 'string') return []
  const parts: string[] = []
  let current = ''
  let braceDepth = 0
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '{') {
      braceDepth++
      current += char
    } else if (char === '}') {
      braceDepth--
      current += char
    } else if (char === ',' && braceDepth === 0) {
      const trimmed = current.trim()
      if (trimmed) parts.push(trimmed)
      current = ''
    } else {
      current += char
    }
  }
  const trimmed = current.trim()
  if (trimmed) parts.push(trimmed)
  return parts.filter(p => p.length > 0).flatMap(pattern => expandBraces(pattern))
}

// cc frontmatterParser.ts:240-266 expandBraces。整块照抄。
function expandBraces(pattern: string): string[] {
  const braceMatch = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
  if (!braceMatch) return [pattern]
  const prefix = braceMatch[1] || ''
  const alternatives = braceMatch[2] || ''
  const suffix = braceMatch[3] || ''
  const parts = alternatives.split(',').map(alt => alt.trim())
  const expanded: string[] = []
  for (const part of parts) {
    expanded.push(...expandBraces(prefix + part + suffix))
  }
  return expanded
}

// cc claudemd.ts:254-279 parseFrontmatterPaths —— 从 frontmatter 抽 paths glob;`**` / 空 视为无 glob。整块照抄。
function parseFrontmatterPaths(rawContent: string): { content: string; paths?: string[] } {
  const { frontmatter, content } = parseFrontmatter(rawContent)
  if (!frontmatter.paths) return { content }
  const patterns = splitPathInFrontmatter(frontmatter.paths)
    // cc 注:去掉 /** 后缀,因为 ignore 库把 'path' 当成同时命中自身与其内所有。
    .map(pattern => (pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern))
    .filter((p: string) => p.length > 0)
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) return { content }
  return { content, paths: patterns }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML 注释剥离 + @import 抽取(cc 用 marked Lexer;我们无此依赖,自写等效实现)。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * cc claudemd.ts:292-334 stripHtmlComments 的无-marked 等效实现:
 * 只剥离**块级**(独占一行、以可选空白 + `<!--` 开头)的 HTML 注释,保留:
 *   - 代码围栏(``` / ~~~)内的注释
 *   - 段落内**行内**注释(前面有正文的,当作 inline HTML 保留,对齐 cc 只处理 top-level html token)
 *   - 未闭合注释(`<!--` 无 `-->`)原样留着,免得打错字吞掉后文
 * 块级注释剥掉注释跨度,但保留 `-->` 之后的同行残余(cc:type-2 HTML block 到 `-->` 所在行止)。
 */
export function stripHtmlComments(content: string): { content: string; stripped: boolean } {
  if (!content.includes('<!--')) return { content, stripped: false }
  const commentSpan = /<!--[\s\S]*?-->/g
  const lines = content.split('\n')
  const result: string[] = []
  let stripped = false
  let inFence = false
  let fenceChar = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const ch = fenceMatch[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
      }
      result.push(line)
      i++
      continue
    }
    if (inFence) {
      result.push(line)
      i++
      continue
    }
    // 块级注释:该行去掉前导空白后以 `<!--` 起头。
    if (line.replace(/^\s*/, '').startsWith('<!--')) {
      let block = line
      let j = i
      while (!block.includes('-->') && j + 1 < lines.length) {
        j++
        block += '\n' + lines[j]!
      }
      if (block.includes('-->')) {
        const residue = block.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) result.push(residue)
        i = j + 1
        continue
      }
      // 未闭合:原样保留。
      result.push(line)
      i++
      continue
    }
    result.push(line)
    i++
  }
  return { content: result.join('\n'), stripped }
}

/**
 * 把内容里「不该扫 @import 的部分」抹掉,得到可扫描文本:
 *   - HTML 注释跨度整段移除(注释里的 @path 不算;但 `-->` 后的残余会保留 → 被扫到,对齐 cc)
 *   - 代码围栏内容整段移除
 *   - 行内代码(反引号跨度)替换为空格
 * 对齐 cc extractIncludePathsFromTokens 跳过 code/codespan/html 的语义。
 */
function scannableText(content: string): string {
  const noComments = content.replace(/<!--[\s\S]*?-->/g, ' ')
  const lines = noComments.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceChar = ''
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const ch = fenceMatch[1]![0]!
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
      }
      out.push('')
      continue
    }
    if (inFence) {
      out.push('')
      continue
    }
    out.push(line.replace(/`+[^`\n]*`+/g, ' '))
  }
  return out.join('\n')
}

/**
 * cc claudemd.ts:451-535 extractIncludePathsFromTokens 的无-marked 等效:
 * 从(去掉代码/注释后的)文本里抽 @path,校验并 expandPath 成绝对路径。校验规则整块照抄。
 */
function extractIncludePaths(content: string, includeBasePath: string): string[] {
  const baseDir = dirname(includeBasePath)
  const scan = scannableText(content)
  const absolutePaths = new Set<string>()
  // cc claudemd.ts:459
  const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
  let match: RegExpExecArray | null
  while ((match = includeRegex.exec(scan)) !== null) {
    let path = match[1]
    if (!path) continue
    // 去掉 #fragment。
    const hashIndex = path.indexOf('#')
    if (hashIndex !== -1) path = path.substring(0, hashIndex)
    if (!path) continue
    // 反转义空格。
    path = path.replace(/\\ /g, ' ')
    // cc claudemd.ts:477-483 —— 接受 @path / @./path / @~/path / @/path。
    const isValidPath =
      path.startsWith('./') ||
      path.startsWith('~/') ||
      (path.startsWith('/') && path !== '/') ||
      (!path.startsWith('@') && !path.match(/^[#%^&*()]+/) && path.match(/^[a-zA-Z0-9._-]/))
    if (isValidPath) {
      absolutePaths.add(expandPath(path, baseDir))
    }
  }
  return [...absolutePaths]
}

// ─────────────────────────────────────────────────────────────────────────────
// 单文件解析 + 读取。
// ─────────────────────────────────────────────────────────────────────────────

// cc claudemd.ts:343-400 parseMemoryFileContent(去掉 AutoMem/TeamMem 截断分支)。
function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: MemoryFileInfo | null; includePaths: string[] } {
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) return { info: null, includePaths: [] }

  const { content: withoutFrontmatter, paths } = parseFrontmatterPaths(rawContent)
  const strippedContent = stripHtmlComments(withoutFrontmatter).content
  // @import 从「去 frontmatter、未剥注释」的文本抽(scannableText 内部会跳过注释),对齐 cc(从 pre-strip tokens 抽,跳 html)。
  const includePaths = includeBasePath !== undefined ? extractIncludePaths(withoutFrontmatter, includeBasePath) : []

  const finalContent = strippedContent
  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

// cc claudemd.ts:402-437 —— 读文件 + 忽略 ENOENT/EISDIR 等预期错误。
async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  try {
    const rawContent = await readFile(filePath, { encoding: 'utf-8' })
    return parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
  } catch {
    return { info: null, includePaths: [] }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 各层开关(对齐 cc isSettingSourceEnabled + claudeMdExcludes)。
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryLoadOptions {
  /** 项目内的当前工作目录(默认 = workspace.root);Project/Local 从 root 逐级加载到它。 */
  cwd?: string
  /** 是否允许 @import 引入 workspace 之外的文件(默认 false,对齐 cc 需审批;User 层永远允许)。 */
  includeExternal?: boolean
  /** 逐层开关(不给则看环境变量,默认全开)。 */
  sources?: Partial<Record<MemorySettingSource, boolean>>
  /** claudeMdExcludes:命中的 User/Project/Local 文件跳过(picomatch glob)。 */
  excludes?: string[]
}

interface ResolvedSettings {
  user: boolean
  project: boolean
  local: boolean
  managed: boolean
  excludes: string[]
  disableAll: boolean
}

function isEnvTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes'
}

function resolveSettings(opts?: MemoryLoadOptions): ResolvedSettings {
  return {
    user: opts?.sources?.userSettings ?? !isEnvTruthy(process.env.BILLIARDBUDDY_DISABLE_USER_MEMORY),
    project: opts?.sources?.projectSettings ?? !isEnvTruthy(process.env.BILLIARDBUDDY_DISABLE_PROJECT_MEMORY),
    local: opts?.sources?.localSettings ?? !isEnvTruthy(process.env.BILLIARDBUDDY_DISABLE_LOCAL_MEMORY),
    managed: opts?.sources?.managedSettings ?? !isEnvTruthy(process.env.BILLIARDBUDDY_DISABLE_MANAGED_MEMORY),
    excludes: opts?.excludes ?? [],
    disableAll: isEnvTruthy(process.env.BILLIARDBUDDY_DISABLE_MEMORY),
  }
}

/** 供上层查询「某层开没开」(对齐 cc isSettingSourceEnabled 语义)。 */
export function isMemorySourceEnabled(source: MemorySettingSource, opts?: MemoryLoadOptions): boolean {
  const s = resolveSettings(opts)
  switch (source) {
    case 'userSettings':
      return s.user
    case 'projectSettings':
      return s.project
    case 'localSettings':
      return s.local
    case 'managedSettings':
      return s.managed
  }
}

// cc claudemd.ts:581-612 resolveExcludePatterns —— 对绝对模式解析 symlink 前缀(处理 /tmp → /private/tmp)。
function resolveExcludePatterns(patterns: string[]): string[] {
  const expanded: string[] = patterns.map(p => p.replaceAll('\\', '/'))
  for (const normalized of [...expanded]) {
    if (!normalized.startsWith('/')) continue
    const globStart = normalized.search(/[*?{[]/)
    const staticPrefix = globStart === -1 ? normalized : normalized.slice(0, globStart)
    const dirToResolve = dirname(staticPrefix)
    try {
      const resolvedDir = realpathSync(dirToResolve).replaceAll('\\', '/')
      if (resolvedDir !== dirToResolve) {
        expanded.push(resolvedDir + normalized.slice(dirToResolve.length))
      }
    } catch {
      // 目录不存在,跳过。
    }
  }
  return expanded
}

// cc claudemd.ts:547-573 isClaudeMdExcluded —— excludes glob 命中判定(仅 User/Project/Local)。
function isMemoryExcluded(filePath: string, type: MemoryType, settings: ResolvedSettings): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') return false
  const patterns = settings.excludes
  if (!patterns || patterns.length === 0) return false
  const normalizedPath = filePath.replaceAll('\\', '/')
  const expandedPatterns = resolveExcludePatterns(patterns).filter(p => p.length > 0)
  if (expandedPatterns.length === 0) return false
  return picomatch.isMatch(normalizedPath, expandedPatterns, { dot: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// 递归处理单文件 + 其 @import(cc claudemd.ts:618-685)。
// ─────────────────────────────────────────────────────────────────────────────

interface WalkCtx {
  root: string
  settings: ResolvedSettings
  processedPaths: Set<string>
}

async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  ctx: WalkCtx,
  includeExternal: boolean,
  depth = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // cc:626-632 —— 已处理 / 超深度即止(processedPaths 去重 + @import 循环防护 + 深度上限)。
  const normalizedPath = normalizePathForComparison(filePath)
  if (ctx.processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) return []

  // cc:634-637 —— excludes 命中即跳过。
  if (isMemoryExcluded(filePath, type, ctx.settings)) return []

  // cc:639-648 —— 解析 symlink,真实路径也进 processedPaths(防同一物理文件被两条路径重复加载)。
  const { resolvedPath, isSymlink } = safeResolvePath(filePath)
  ctx.processedPaths.add(normalizedPath)
  if (isSymlink) ctx.processedPaths.add(normalizePathForComparison(resolvedPath))

  // 适配:@import base 用**原始 filePath 的目录**(而非 cc 的 resolvedPath),让 import 解析出的路径
  // 与 workspace.root 处在同一符号链接空间(否则 macOS /var↔/private/var 会让本目录内的 import 误判为外部)。
  const { info: memoryFile, includePaths } = await safelyReadMemoryFileAsync(filePath, type, filePath)
  if (!memoryFile || !memoryFile.content.trim()) return []

  if (parent) memoryFile.parent = parent

  const result: MemoryFileInfo[] = []
  // cc:663-664 —— 主文件先入(parent 在 children 之前)。
  result.push(memoryFile)

  for (const inc of includePaths) {
    // cc:667-670 —— workspace 之外的 @import 需 includeExternal 放行。
    const isExternal = !isPathInside(ctx.root, inc)
    if (isExternal && !includeExternal) continue
    result.push(...(await processMemoryFile(inc, type, ctx, includeExternal, depth + 1, filePath)))
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则目录处理(cc claudemd.ts:697-788)。递归子目录 + symlink 解析 + 防环 + 条件/无条件筛选。
// ─────────────────────────────────────────────────────────────────────────────

async function processMdRules(args: {
  rulesDir: string
  type: MemoryType
  ctx: WalkCtx
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<MemoryFileInfo[]> {
  const { rulesDir, type, ctx, includeExternal, conditionalRule, visitedDirs = new Set<string>() } = args
  if (visitedDirs.has(rulesDir)) return []

  try {
    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(rulesDir)
    visitedDirs.add(rulesDir)
    if (isSymlink) visitedDirs.add(resolvedRulesDir)

    const result: MemoryFileInfo[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(resolvedRulesDir, { withFileTypes: true })
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') return []
      throw e
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink: entryIsSymlink } = safeResolvePath(entryPath)
      // 非 symlink 用 Dirent 方法省 stat;symlink 需 stat 判目标类型。
      const stats = entryIsSymlink ? await stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        result.push(
          ...(await processMdRules({ rulesDir: resolvedEntryPath, type, ctx, includeExternal, conditionalRule, visitedDirs })),
        )
      } else if (isFile && entry.name.endsWith('.md')) {
        const files = await processMemoryFile(resolvedEntryPath, type, ctx, includeExternal)
        // conditionalRule=true 只留有 globs 的;=false 只留无 globs 的(cc:773)。
        result.push(...files.filter(f => (conditionalRule ? f.globs : !f.globs)))
      }
    }
    return result
  } catch {
    return []
  }
}

// cc claudemd.ts:1354-1397 processConditionedMdRules —— 条件规则:按 targetPath 匹配 frontmatter globs。
// 适配:ignore → picomatch(见文件头 C)。
export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  ctx: WalkCtx,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  const conditioned = await processMdRules({ rulesDir, type, ctx, includeExternal, conditionalRule: true })
  return conditioned.filter(file => {
    if (!file.globs || file.globs.length === 0) return false
    // Project 规则:glob 相对「.billiardbuddy 的父目录」;Managed/User 规则:相对项目根。
    const baseDir = type === 'Project' ? dirname(dirname(rulesDir)) : ctx.root
    const relativePath = isAbsolute(targetPath) ? relative(baseDir, targetPath) : targetPath
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return false
    return matchesAnyGlob(relativePath, file.globs)
  })
}

/**
 * picomatch 版的 gitignore 风格匹配(还原 cc `ignore().add(globs).ignores(rel)`):
 * 一个目录 pattern 既命中自身、也命中其内所有 → 除 pattern 本身外再试 `pattern/**`。
 */
function matchesAnyGlob(rel: string, globs: string[]): boolean {
  const norm = rel.replaceAll('\\', '/')
  for (const g of globs) {
    const gg = g.replaceAll('\\', '/').replace(/\/+$/, '')
    if (!gg) continue
    if (picomatch.isMatch(norm, gg, { dot: true })) return true
    if (picomatch.isMatch(norm, `${gg}/**`, { dot: true })) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// 四层加载主入口(cc claudemd.ts:790-1075 getMemoryFiles)。
// 适配:workspace 参数化(不全局 memoize)、bounded walk、去 AutoMem/TeamMem/hooks/analytics。
// ─────────────────────────────────────────────────────────────────────────────

/** 收集从 root 到 cwd(bounded)逐级目录,root 在前(低优先)、cwd 在后(高优先)。 */
function dirsFromRootToCwd(root: string, cwd: string): string[] {
  const r = resolve(root)
  const c = resolve(cwd)
  if (r !== c && !isPathInside(r, c)) return [r] // cwd 越出 workspace → 只用 root(沙箱安全)。
  const dirs: string[] = []
  let cur = c
  while (true) {
    dirs.push(cur)
    if (normalizePathForComparison(cur) === normalizePathForComparison(r)) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return dirs.reverse()
}

export async function getMemoryFiles(workspace: Workspace, opts?: MemoryLoadOptions): Promise<MemoryFileInfo[]> {
  const settings = resolveSettings(opts)
  if (settings.disableAll) return []

  const root = resolve(workspace.root)
  const cwd = opts?.cwd ? resolve(opts.cwd) : root
  const includeExternal = opts?.includeExternal ?? false
  const ctx: WalkCtx = { root, settings, processedPaths: new Set<string>() }
  const result: MemoryFileInfo[] = []

  // cc:803-823 —— Managed 层(最先,策略级,永远最低优先)。
  if (settings.managed) {
    result.push(...(await processMemoryFile(getMemoryPath('Managed', root), 'Managed', ctx, includeExternal)))
    result.push(
      ...(await processMdRules({ rulesDir: getManagedRulesDir(), type: 'Managed', ctx, includeExternal, conditionalRule: false })),
    )
  }

  // cc:826-847 —— User 层(User memory 永远允许 @import 外部文件)。
  if (settings.user) {
    result.push(...(await processMemoryFile(getMemoryPath('User', root), 'User', ctx, true)))
    result.push(
      ...(await processMdRules({ rulesDir: getUserRulesDir(), type: 'User', ctx, includeExternal: true, conditionalRule: false })),
    )
  }

  // cc:850-934 —— Project + Local 层(根 → cwd 逐级,越靠近 cwd 越高优先)。bounded 到 workspace.root。
  const dirs = dirsFromRootToCwd(root, cwd)
  for (const dir of dirs) {
    if (settings.project) {
      // <dir>/BILLIARDBUDDY.md
      result.push(...(await processMemoryFile(getMemoryPath('Project', dir), 'Project', ctx, includeExternal)))
      // <dir>/.billiardbuddy/BILLIARDBUDDY.md
      result.push(...(await processMemoryFile(getDotDirMainPath(dir), 'Project', ctx, includeExternal)))
      // <dir>/.billiardbuddy/rules/*.md(无条件规则,eager 加载)
      result.push(
        ...(await processMdRules({ rulesDir: getProjectRulesDir(dir), type: 'Project', ctx, includeExternal, conditionalRule: false })),
      )
    }
    if (settings.local) {
      // <dir>/BILLIARDBUDDY.local.md
      result.push(...(await processMemoryFile(getMemoryPath('Local', dir), 'Local', ctx, includeExternal)))
    }
  }

  return result
}

/**
 * 编辑某文件时按需加载的**条件规则**(cc getConditionalRulesForCwdLevelDirectory 思路,
 * 简化为:项目内从 root 到 targetPath 所在目录逐级找 .billiardbuddy/rules 里 paths 命中的规则)。
 * 供未来在编辑流里挂载;本波不接进工具。
 */
export async function loadConditionalRulesForPath(
  workspace: Workspace,
  targetAbsPath: string,
  opts?: MemoryLoadOptions,
): Promise<MemoryFileInfo[]> {
  const settings = resolveSettings(opts)
  if (settings.disableAll || !settings.project) return []
  const root = resolve(workspace.root)
  const target = resolve(targetAbsPath)
  if (!isPathInside(root, target)) return []
  const ctx: WalkCtx = { root, settings, processedPaths: new Set<string>() }
  const dirs = dirsFromRootToCwd(root, dirname(target))
  const result: MemoryFileInfo[] = []
  for (const dir of dirs) {
    result.push(...(await processConditionedMdRules(target, getProjectRulesDir(dir), 'Project', ctx, false)))
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// 注入格式(cc claudemd.ts:1153-1195 getClaudeMds)。品牌中性描述,整块照抄。
// ─────────────────────────────────────────────────────────────────────────────

export function getClaudeMds(memoryFiles: MemoryFileInfo[], filter?: (type: MemoryType) => boolean): string {
  const memories: string[] = []
  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : " (user's private global instructions for all projects)"
      const content = file.content.trim()
      memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
    }
  }
  if (memories.length === 0) return ''
  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

/**
 * 便捷入口:四层加载 + 拼注入串。给 systemPrompt 用。无内容返回 null。
 */
export async function loadMemoryInjection(workspace: Workspace, opts?: MemoryLoadOptions): Promise<string | null> {
  const files = await getMemoryFiles(workspace, opts)
  const s = getClaudeMds(files)
  return s.length > 0 ? s : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 外部 @import 审批相关(cc claudemd.ts:1404-1418)。
// ─────────────────────────────────────────────────────────────────────────────

export type ExternalMemoryInclude = { path: string; parent: string }

export function getExternalMemoryIncludes(files: MemoryFileInfo[], workspaceRoot: string): ExternalMemoryInclude[] {
  const root = resolve(workspaceRoot)
  const externals: ExternalMemoryInclude[] = []
  for (const file of files) {
    // User 层允许外部,不算需审批;其余带 parent 且在 workspace 外的算。
    if (file.type !== 'User' && file.parent && !isPathInside(root, file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalMemoryIncludes(files: MemoryFileInfo[], workspaceRoot: string): boolean {
  return getExternalMemoryIncludes(files, workspaceRoot).length > 0
}

// cc claudemd.ts:1435-1452 isMemoryFilePath —— 判断某路径是否记忆文件(品牌名版)。
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)
  if (name === MEMORY_MAIN_FILE || name === MEMORY_LOCAL_FILE) return true
  if (name.endsWith('.md') && filePath.includes(`${sep}${MEMORY_DOT_DIR}${sep}${MEMORY_RULES_SUBDIR}${sep}`)) return true
  return false
}
