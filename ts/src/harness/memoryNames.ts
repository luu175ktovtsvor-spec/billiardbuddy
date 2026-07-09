/**
 * 记忆/指令文件的**品牌命名 + 路径解析**集中处(白标铁律:机制照抄 cc,名字绝不照抄)。
 *
 * cc 用的是 Claude Code 品牌名(CLAUDE.md / .claude / ~/.claude / /etc/claude-code),
 * 照抄会 ① 暴露底层来源(违反白标)② 跟用户已装的 Claude Code 抢读 ~/.claude 打架。
 * 所以这里把 cc 的名字一律换成我们的产品品牌 **BilliardBuddy**。
 * ⚠️ 运行时读用户工作区/全局**只认 BILLIARDBUDDY.md 这套**,不加载 AGENTS.md、也不加载 CLAUDE.md。
 * **集中一处、日后改名只动这个文件**:
 *
 *   cc 名字                        →  我们的名字
 *   CLAUDE.md                      →  BILLIARDBUDDY.md
 *   CLAUDE.local.md                →  BILLIARDBUDDY.local.md
 *   .claude/(项目目录)             →  .billiardbuddy/
 *   .claude/CLAUDE.md              →  .billiardbuddy/BILLIARDBUDDY.md
 *   .claude/rules/                 →  .billiardbuddy/rules/
 *   ~/.claude/(用户全局目录)       →  ~/.billiardbuddy/        (env BILLIARDBUDDY_CONFIG_DIR 可覆盖)
 *   ~/.claude/CLAUDE.md            →  ~/.billiardbuddy/BILLIARDBUDDY.md   ← User 层主指令
 *   ~/.claude/rules/               →  ~/.billiardbuddy/rules/
 *   /etc/claude-code/CLAUDE.md     →  <managedDir>/BILLIARDBUDDY.md(中性 managed 目录,env 可覆盖/默认不存在即跳过)
 *
 * 对应 cc utils/config.ts:1788-1816(getMemoryPath / getManagedClaudeRulesDir /
 * getUserClaudeRulesDir)与 utils/settings/managedPath.ts / utils/envUtils.ts。
 *
 * 注:我们自己 repo 里的 ts/AGENTS.md、ts/CLAUDE.md 是「开发这个产品」用的内部文档,与本文件无关——
 * 这里定义的是「发出去的产品运行时读用户文件夹里哪个文件」的约定,那个只认 BILLIARDBUDDY.md。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 主指令文件名(cc: CLAUDE.md)。运行时唯一认这个。 */
export const MEMORY_MAIN_FILE = 'BILLIARDBUDDY.md'
/** 本地私有指令文件名(cc: CLAUDE.local.md)。 */
export const MEMORY_LOCAL_FILE = 'BILLIARDBUDDY.local.md'
/** 项目点目录名(cc: .claude)。 */
export const MEMORY_DOT_DIR = '.billiardbuddy'
/** 规则子目录名(cc: rules,位于点目录下)。 */
export const MEMORY_RULES_SUBDIR = 'rules'

/** 记忆层类型(对齐 cc memory/types.ts;我们不做 AutoMem/TeamMem)。 */
export const MEMORY_TYPE_VALUES = ['User', 'Project', 'Local', 'Managed'] as const
export type MemoryType = (typeof MEMORY_TYPE_VALUES)[number]

/** 可开关的设置源(对齐 cc SettingSource 的 memory 相关子集)。 */
export type MemorySettingSource = 'userSettings' | 'projectSettings' | 'localSettings' | 'managedSettings'

/**
 * 用户全局配置目录(cc: getClaudeConfigHomeDir,~/.claude)。
 * 我们用 ~/.billiardbuddy;env `BILLIARDBUDDY_CONFIG_DIR` 可覆盖(便于测试/多环境,对齐 cc 的 CLAUDE_CONFIG_DIR)。
 */
export function getUserConfigHomeDir(): string {
  const override = process.env.BILLIARDBUDDY_CONFIG_DIR
  return (override && override.length > 0 ? override : join(homedir(), '.billiardbuddy')).normalize('NFC')
}

/**
 * Managed(机构策略)目录(cc: getManagedFilePath,/etc/claude-code 等)。
 * 用品牌名 BilliardBuddy;env `BILLIARDBUDDY_MANAGED_DIR` 可覆盖。默认路径通常不存在 → 该层自然跳过。
 */
export function getManagedDir(): string {
  const override = process.env.BILLIARDBUDDY_MANAGED_DIR
  if (override && override.length > 0) return override
  switch (process.platform) {
    case 'darwin':
      return '/Library/Application Support/BilliardBuddy'
    case 'win32':
      return 'C:\\ProgramData\\BilliardBuddy'
    default:
      return '/etc/billiardbuddy'
  }
}

/**
 * 四层主指令文件的绝对路径(对齐 cc config.ts:1788-1808 getMemoryPath)。
 * `cwd` 是项目根(我们用 workspace.root)。
 */
export function getMemoryPath(type: MemoryType, cwd: string): string {
  switch (type) {
    case 'User':
      return join(getUserConfigHomeDir(), MEMORY_MAIN_FILE)
    case 'Local':
      return join(cwd, MEMORY_LOCAL_FILE)
    case 'Project':
      return join(cwd, MEMORY_MAIN_FILE)
    case 'Managed':
      return join(getManagedDir(), MEMORY_MAIN_FILE)
  }
}

/** User 层 rules 目录(cc: getUserClaudeRulesDir = ~/.claude/rules)→ ~/.billiardbuddy/rules。 */
export function getUserRulesDir(): string {
  return join(getUserConfigHomeDir(), MEMORY_RULES_SUBDIR)
}

/** Managed 层 rules 目录(cc: getManagedClaudeRulesDir = <managed>/.claude/rules)。 */
export function getManagedRulesDir(): string {
  return join(getManagedDir(), MEMORY_DOT_DIR, MEMORY_RULES_SUBDIR)
}

/** 项目某目录下 .billiardbuddy/ 里的主指令文件(cc: <dir>/.claude/CLAUDE.md)。 */
export function getDotDirMainPath(dir: string): string {
  return join(dir, MEMORY_DOT_DIR, MEMORY_MAIN_FILE)
}

/** 项目某目录下的 .billiardbuddy/rules 目录(cc: <dir>/.claude/rules)。 */
export function getProjectRulesDir(dir: string): string {
  return join(dir, MEMORY_DOT_DIR, MEMORY_RULES_SUBDIR)
}
