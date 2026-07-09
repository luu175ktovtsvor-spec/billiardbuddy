// 文件类工具(Read/Write/Edit 家族)的路径作用域规则匹配 —— 直接移植 cc-haha 的实现。
//
// 缺口修复:此前 resolve.ts 的 ruleMatchesInput 对文件类工具直接 return false,导致路径作用域的
// deny/ask/allow 规则(如 deny Read(.env)、deny Read(**/secrets/**))对 Read/Write/Edit 完全失效
// —— .env / 密钥被静默放读。
//
// ── 照抄 cc-haha `src/utils/permissions/filesystem.ts` 的哪些部分 ──
//   • matchingRuleForInput()(filesystem.ts:970):把入参路径 expandPath 成绝对路径 → 按规则来源算 root
//     → 取相对 root 的 POSIX 路径做 gitignore 匹配 → 越界(`../`)跳过 → 匹配前剥尾部 `/**`
//     (ignore 库把命中的目录视作连同其内容一起命中)。本文件 fileGlobMatchesPathForRule 逐条移植。
//   • patternWithRoot()(filesystem.ts:869):`//` → 文件系统根 / Windows 盘符;`~/` → home;
//     `/` → 规则来源根;相对 → 剥 `./`、无根(= cwd)。本文件 patternWithRoot 逐条移植。
//   • getPatternsByRoot()(filesystem.ts:934):Read 规则(FILE_READ_TOOL_NAME='Read')作用于所有读文件
//     工具,Edit 规则(FILE_EDIT_TOOL_NAME='Edit')作用于所有写/改文件工具。
//   • checkReadPermissionForTool 第 5 步「edit access implies read access」(filesystem.ts:1149):
//     读工具额外吃 Edit 的 *allow* 规则(只放宽 allow,绝不让 Edit 规则 deny/ask 一个读动作)。
//   • gitignore glob 引擎:直接 vendored `ignore@7.0.5`(cc 的同款依赖,见 ./vendor/ignore.js),
//     字节级一致,不自造简化 glob。
//
// ── 因本仓库架构不同而适配的地方(及原因)──
//   • 规则来源→根目录:cc 的 rootPathForSource/getSettingsRootPathForSource 把每个 source 映射到各自的
//     设置目录(userSettings→~/.claude、project/local→cwd 等)。本产品是「单一本地工作区 + 文件式存储」,
//     不存在多源设置目录层级,故把 userSettings/policySettings 归到 home、其余归到 workspace 根
//     (= cc 的 originalCwd)。pattern 前缀根(`~/`、`/`、`//`)照 cc 保留。
//   • 规则 toolName 家族匹配用别名集合(READ/EDIT/WRITE_RULE_TOOLNAMES)而非 cc 的单名精确匹配:本仓库
//     规则的 toolName 既可能是规范名(Read/Edit/Write,来自 settings),也可能是内部名(read_file/edit_file,
//     来自 skill/command frontmatter),需兼容两套。
//   • Windows 路径:mac 为首要目标,这里只做 `\`→`/` 归一;完整的 UNC/盘符/短名校验交给本仓库既有的
//     workspace/pathValidation.ts,与 cc 把 Windows 细节单列一层同构。

import { homedir } from 'node:os'
import { isAbsolute, normalize as nativeNormalize, resolve as nativeResolve } from 'node:path'
import { relative as posixRelative } from 'node:path/posix'
import type { Tool, ToolContext } from '../tools/Tool'
import type { PermissionRule, PermissionRuleSource } from './types'
import ignoreFactory from './vendor/ignore.js'

// vendored ignore.js 无类型;窄化到我们用到的最小面。
type IgnoreInstance = { add(patterns: string[]): IgnoreInstance; test(path: string): { ignored: boolean } }
const ignore = ignoreFactory as unknown as () => IgnoreInstance

export type FilePathOperation = 'read' | 'write'

// ── 哪些工具的入参文件路径要经 matchingRuleForInput 逐条 gate ────────────────────────
// 判据(和 cc 的 tool.getPath 同义):工具会「读出 / 写入 由入参路径指定的那个文件的内容」。
// 这类工具漏挂 = 路径作用域 deny/ask/allow 对它失效(重开 .env 读/写保护洞)。
//
// ⚠️ 这两个集合 + 下面的 filePathsFromInput 必须与 registry(src/tools/generalTools.ts)里的
//    文件工具家族保持同步。新增文件工具没登记进来,编译不会报错(Tool 接口无 getPath),只能靠
//    filePathRuleMatch.test.ts 的「漂移哨兵」测试兜住——它遍历真实 registry,凡入参含文件路径字段
//    却既没 gate、也没在测试里显式标注为「不 input-gate」的工具,就让测试红,逼开发当场归类。
//
// ── 有意「不」经 matchingRuleForInput 入参 gate 的路径类工具(勿加进下面两个集合)──
//   • 目录列举 / 跨文件搜索:list_dir、glob_files、grep_files —— 对齐 cc,这类走「输出层 ignore 过滤」
//     (getFileReadIgnorePatterns),即把命中 deny-read 的文件从结果里剔除,而不是按入参整体拒;
//     grep_files 现已有自带的 isSensitiveRelativePath 跳过 .env/密钥。本轮不改其输出层,仅在此标注。
//   • git_status / git_history:paths 只是 pathspec 限定符(缺省 = 全仓),内容来自 git 状态/对象库,
//     同属「输出层过滤」范畴,不按入参 gate。
//   • project_diagnostics:跑 package 脚本,不 emit 任意文件内容。
//   • list_project_instructions:读的是入参路径「附近的」AGENTS.md/CLAUDE.md,不是入参文件本身。
//   • LSP:跨工作区符号分析,filePath 是定位锚点,不是单文件内容转储。
//   • read_stored_tool_result:path 被校验只能落在「本会话工具结果存储目录」内(见 isInsideRealPath),
//     不是工作区文件路径,故不按工作区路径规则 gate。
//   这些工具也在 filePathRuleMatch.test.ts 的 NOT_INPUT_GATED 里登记,漂移哨兵据此放行。
//
// 注:file_history 已 input-gate(它带 path 时会 emit 该路径的快照 diff = 历史文件内容);其「不带
// path 列全部快照」的模式仍会露出文件名元数据,理想终态是对其输出再做 read-ignore 过滤(遗留跟进项)。
const READ_PATH_TOOLS = new Set(['read_file', 'read_many_files', 'code_outline', 'file_history'])
const WRITE_PATH_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'patch_file',
  'patch_files',
  'edit_excel',
  'NotebookEdit',
  'restore_file',
])

// 规则里的 toolName(cc 规范名 Read/Edit/Write,或我们内部名)→ 家族归属。
const READ_RULE_TOOLNAMES = new Set(['Read', 'read_file', 'read_many_files', 'code_outline', 'file_history'])
const EDIT_RULE_TOOLNAMES = new Set([
  'Edit',
  'MultiEdit',
  'edit_file',
  'multi_edit_file',
  'patch_file',
  'patch_files',
  'edit_excel',
  'NotebookEdit',
  'restore_file',
])
const WRITE_RULE_TOOLNAMES = new Set(['Write', 'write_file'])

/** 该工具是否是带文件路径的读/写工具;不是则返回 null(交回普通规则处理)。 */
export function filePathToolOperation(tool: Tool): FilePathOperation | null {
  if (WRITE_PATH_TOOLS.has(tool.name)) return 'write'
  if (READ_PATH_TOOLS.has(tool.name)) return 'read'
  return null
}

/**
 * 某条路径规则是否作用于该操作的工具。对齐 cc getPatternsByRoot 的 Read/Edit 家族分派 +
 * checkReadPermissionForTool 的「edit 隐含 read(仅 allow)」。
 */
export function fileRuleAppliesToTool(rule: PermissionRule, op: FilePathOperation): boolean {
  const name = rule.ruleValue.toolName
  if (name === '*') return true
  if (op === 'write') return EDIT_RULE_TOOLNAMES.has(name) || WRITE_RULE_TOOLNAMES.has(name)
  // op === 'read'
  if (READ_RULE_TOOLNAMES.has(name)) return true
  // cc:edit access implies read access —— 仅放宽 allow,绝不让 Edit 规则去 deny/ask 一个读动作。
  if (rule.ruleBehavior === 'allow' && EDIT_RULE_TOOLNAMES.has(name)) return true
  return false
}

/**
 * 从入参里取出该工具操作的全部文件路径(可能多条 / 嵌套数组)。
 * 每个分支对应 registry 里该工具真实的入参形状(cc 是每工具 tool.getPath 各自取,这里集中取)。
 * 覆盖不全 = 抽不到路径 = 规则静默不匹配 = 保护洞。改这里务必与 filePathRuleMatch.test.ts 的 GATED 同步。
 */
export function filePathsFromInput(tool: Tool, input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const rec = input as Record<string, unknown>

  switch (tool.name) {
    case 'NotebookEdit':
      // notebook_path 为主字段,path 是文档化别名(execute 用 notebook_path ?? path)。
      return cleanPaths([asString(rec.notebook_path) || asString(rec.path)])

    case 'read_many_files': {
      // paths: string|string[];ranges[].path(用 ranges 时 paths 被忽略,两者都收以求稳)。
      const out = collectStringOrArray(rec.paths)
      collectNestedPathField(rec.ranges, out)
      return cleanPaths(out)
    }

    case 'code_outline':
    case 'file_history': {
      // path(code_outline:string;file_history:string|string[])+ paths(string[]),全收。
      const out = collectStringOrArray(rec.path)
      collectStringOrArray(rec.paths, out)
      return cleanPaths(out)
    }

    case 'patch_files': {
      // 入参形状 { patches: [{ path, patch }] } —— 路径在嵌套数组里,无顶层 path(此前漏挂的洞)。
      const out: string[] = []
      collectNestedPathField(rec.patches, out)
      return cleanPaths(out)
    }

    default:
      // 顶层 path 的工具:read_file / write_file / edit_file / multi_edit_file / patch_file /
      // edit_excel / restore_file。
      return cleanPaths([asString(rec.path)])
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 收 string 或 string[] 到 out(返回 out,便于链式积累)。 */
function collectStringOrArray(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const p of value) if (typeof p === 'string') out.push(p)
  return out
}

/** 从对象数组(如 patches[]/ranges[])里逐个取出 .path 追加到 out。 */
function collectNestedPathField(value: unknown, out: string[]): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).path === 'string') {
      out.push((item as Record<string, unknown>).path as string)
    }
  }
}

function cleanPaths(paths: string[]): string[] {
  return paths.map(p => p.trim()).filter(Boolean)
}

/**
 * 该工具入参里的任一文件路径,是否命中这条路径规则(glob)。deny/ask 命中任一即算命中(安全方向:
 * 宁可拦住),allow 亦同(读动作过度放行风险低)。规则无 ruleContent 由上游处理,不进这里。
 */
export function filePathRuleMatchesInput(ctx: ToolContext, rule: PermissionRule, tool: Tool, input: unknown): boolean {
  const content = rule.ruleValue.ruleContent
  if (content === undefined) return false
  const paths = filePathsFromInput(tool, input)
  if (paths.length === 0) return false
  const workspaceRoot = ctx.workspace.root
  return paths.some(p => fileGlobMatchesPathForRule(workspaceRoot, expandPath(workspaceRoot, p), content, rule.source))
}

// ── 以下为 cc filesystem.ts 的移植 ──────────────────────────────────────────────

/** cc expandPath 简化版:展开 `~`、绝对/相对(相对 workspace 根)、NFC 规范化。 */
function expandPath(workspaceRoot: string, path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return nativeNormalize(workspaceRoot).normalize('NFC')
  if (trimmed === '~') return homedir().normalize('NFC')
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return nativeResolve(homedir(), trimmed.slice(2)).normalize('NFC')
  }
  if (isAbsolute(trimmed)) return nativeNormalize(trimmed).normalize('NFC')
  return nativeResolve(workspaceRoot, trimmed).normalize('NFC')
}

function toPosix(p: string): string {
  return p.replaceAll('\\', '/')
}

/**
 * 单条 gitignore 规则匹配单条绝对路径 —— 逐条移植 cc matchingRuleForInput 的循环体
 * (filesystem.ts:990-1035),glob 判定交给 vendored ignore 引擎(与 cc 同款)。
 *
 * 导出供「输出层 read-ignore 过滤」(./readIgnoreFilter.ts)复用:输入层拒读判定与输出层
 * 结果剔除同引擎,保证不变量「路径出现在 list/glob/grep 输出 ⟺ read_file 不会被 read-deny 拒」。
 */
export function fileGlobMatchesPathForRule(
  workspaceRoot: string,
  absPath: string,
  ruleContent: string,
  source: PermissionRuleSource,
): boolean {
  const cleaned = stripQuotes(toPosix(ruleContent).trim())
  if (!cleaned) return false

  const { relativePattern, root } = patternWithRoot(cleaned, source, workspaceRoot)

  // cc:剥掉尾部 `/**`,ignore 库把命中路径视作连同其内容一起命中。
  let adjusted = relativePattern
  if (adjusted.endsWith('/**')) adjusted = adjusted.slice(0, -3)
  if (!adjusted) return false

  const relativePathStr = posixRelative(toPosix(root), toPosix(absPath))
  // 路径在 root 之外 → 跳过(cc filesystem.ts:1012)。
  if (relativePathStr.startsWith('../')) return false
  // ig.test 给空串会抛(cc filesystem.ts:1018)。空串意味着路径就是 root 本身。
  if (!relativePathStr) return false

  return ignore().add([adjusted]).test(relativePathStr).ignored
}

/**
 * 逐条移植 cc patternWithRoot(filesystem.ts:869)。
 * 差异:cc 的单个 `/` 前缀走 rootPathForSource(各 source 各自设置目录);本产品单一工作区,
 * 用 rootForSource() 收敛(userSettings/policy→home,其余→workspace)。
 */
function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
  workspaceRoot: string,
): { relativePattern: string; root: string } {
  const wsRoot = toPosix(workspaceRoot)
  if (pattern.startsWith('//')) {
    // `//...` 相对文件系统根。
    return { relativePattern: pattern.slice(1), root: '/' }
  }
  if (pattern.startsWith('~/')) {
    // `~/...` 相对 home。cc: relativePattern = pattern.slice(1)(保留前导 `/` → ignore 里锚定)。
    return { relativePattern: pattern.slice(1), root: toPosix(homedir()) }
  }
  if (pattern.startsWith('/')) {
    // 单个 `/` 前缀:相对规则来源根。
    return { relativePattern: pattern, root: toPosix(rootForSource(source, wsRoot)) }
  }
  // 相对模式:剥前导 `./`,根 = workspace(= cc 的 null 根走 cwd)。
  let rel = pattern
  if (rel.startsWith('./')) rel = rel.slice(2)
  return { relativePattern: rel, root: wsRoot }
}

/** cc rootPathForSource + getSettingsRootPathForSource 的单工作区收敛版(见文件头适配说明)。 */
function rootForSource(source: PermissionRuleSource, workspaceRoot: string): string {
  switch (source) {
    case 'userSettings':
    case 'policySettings':
      return toPosix(homedir())
    default:
      return workspaceRoot
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}
