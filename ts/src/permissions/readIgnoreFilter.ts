// 「输出层」read-ignore 过滤 —— 直接移植 cc-haha 的输出层 ignore 机制。
//
// ── 缺口(本文件修复的东西)──
//   输入层(resolve.ts + filePathRuleMatch.ts)已经拦住「直接读一个被 deny 的文件」;但列目录 /
//   glob / 文件搜索这类工具在**产出结果**时,原来不看 read-deny 规则,会把被忽略的文件路径原样列出
//   —— 被 deny-read 的 .env / **/secrets/** 仍从工具输出里泄漏(路径名 + 存在性)。cc 不这样,cc 在
//   结果产出时按 ignore 规则把这些路径剔掉。本文件把这套「输出层过滤」照抄过来给读出层工具复用。
//
// ── cc 的输出层 ignore 到底怎么做的(读 cc-haha 源码得到的实情)──
//   • 来源工具:GlobTool(utils/glob.ts)、GrepTool(tools/GrepTool/GrepTool.ts)。二者产出结果前
//     都调 `getFileReadIgnorePatterns(toolPermissionContext)`(utils/permissions/filesystem.ts:852)
//     —— 它收集所有 **Read 工具的 deny 规则**,取其 ruleContent 当 gitignore 模式,按规则来源根归类;
//     再 `normalizePatternsToPath(..., searchDir)` 把模式解析到搜索根,最后作为 `--glob !pattern` 交给
//     ripgrep,让命中的路径不出现在结果里。→ ignore 源 = **Read-deny 权限规则**(不是某个 dotfile)。
//   • 默认排除:GrepTool 另有硬编码 VCS 目录列表 `VCS_DIRECTORIES_TO_EXCLUDE`(GrepTool.ts:95-102 =
//     .git/.svn/.hg/.bzr/.jj/.sl),始终 `--glob !<dir>` 排除,避免版本库元数据噪声。见下 DEFAULT_*。
//   • 过滤发生在「遍历/产出时」:ripgrep 边走目录树边按 glob 排除,命中的目录整棵不进结果。我们用
//     Bun.Glob / readdir 自己走树,所以在每条候选路径产出点调 pathHiddenByReadDeny() 逐条剔除。
//   • 目录 vs 文件 / `..` / 绝对 vs 相对 / 符号链接等边界:全部交给与输入层同一个引擎
//     fileGlobMatchesPathForRule(cc matchingRuleForInput 的移植 + vendored `ignore@7.0.5`):目录命中
//     即连同子树剔除(规则尾部 `/**` 被剥,ignore 库把命中目录视作连内容一起命中);`..` 先归一;
//     路径落在规则根之外(相对路径以 `../` 开头)→ 不命中;绝对/`~/`/`//` 前缀按 cc patternWithRoot 归根。
//
// ── white-label(白标)说明 ──
//   cc 的输出层 ignore **没有专用 ignore dotfile**(不存在 `.claudeignore`;`.ignore`/`.rgignore` 只在
//   @-mention 文件建议 hook 和桌面文件浏览 API 里读,不在 LS/Glob/Grep 工具输出路径上)。所以这里
//   不需要把某个 `.claudeignore` 换成 `.billiardbuddyignore` —— 根本没有这样的文件。唯一 Claude 品牌名
//   是配置点目录 `.claude`(我们已在 harness/memoryNames.ts 白标成 `.billiardbuddy` = MEMORY_DOT_DIR);
//   而 cc **不**把 `.claude` 从搜索输出里排除,故我们同样不排除 `.billiardbuddy`(行为对齐 cc)。

import { normalize as nativeNormalize } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import { fileGlobMatchesPathForRule, fileRuleAppliesToTool } from './filePathRuleMatch'

/**
 * 从「列目录 / glob / 文件搜索」输出里默认剔除的版本控制元数据目录段。
 * 逐条对齐 cc GrepTool 的 VCS_DIRECTORIES_TO_EXCLUDE(GrepTool.ts:95-102)。
 * 满足本任务「默认排除至少含 .git」的硬要求,并与 cc 的 VCS 全集一致。
 * (node_modules/dist 等重目录不在 cc 这份 VCS 列表里,由各读出层工具自带的重目录跳过集处理。)
 */
export const DEFAULT_IGNORED_VCS_SEGMENTS: readonly string[] = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/**
 * 一条**绝对路径**是否被任一 Read-deny 规则命中 → 命中即应从 list_dir/glob/grep 的结果里剔除。
 * 对齐 cc getFileReadIgnorePatterns:只看 Read 家族(及通配 `*`)的 **deny** 规则,且只对带 ruleContent
 * 的规则生效(裸 `deny Read` 无路径模式,cc 也不把它变成 ignore 模式,故这里同样跳过)。
 *
 * 与输入层 read_file 拒读判定同引擎(fileGlobMatchesPathForRule),故不变量成立:
 *   路径 P 出现在读出层输出 ⟺ read_file(P) 不会被 read-deny 规则拒。
 * Edit-deny 不外溢到读(fileRuleAppliesToTool(rule,'read') 对 deny 的 Edit 规则返回 false),
 * 与 cc「输出层只收 Read-deny、不收 Edit-deny」一致。
 */
export function pathHiddenByReadDeny(ctx: ToolContext, absPath: string): boolean {
  const rules = ctx.permissionRules
  if (!rules || rules.length === 0) return false
  const root = ctx.workspace.root
  // 归一 `.`/`..` 段 + NFC,与输入层 expandPath(nativeNormalize + NFC)对齐;防非规范化绝对路径漏判。
  const target = nativeNormalize(absPath).normalize('NFC')
  for (const rule of rules) {
    if (rule.ruleBehavior !== 'deny') continue
    if (!fileRuleAppliesToTool(rule, 'read')) continue
    const content = rule.ruleValue.ruleContent
    if (content === undefined || content.trim() === '') continue
    if (fileGlobMatchesPathForRule(root, target, content, rule.source)) return true
  }
  return false
}
