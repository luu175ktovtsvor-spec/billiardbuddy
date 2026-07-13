// 扩展发现默认根:内置技能/命令/子代理与 MCP 配置的定位,以及工作区命令装载。

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveBundledDir } from '../harness/bundledRoot'
import { LIBRARY_DIR_ENV, LIBRARY_DOT_DIR, LIBRARY_SUBDIR } from '../harness/desktopEnvNames'
import { MEMORY_DOT_DIR } from '../harness/memoryNames'
import { bundledSkillsRoot } from '../skills/skillLoader'
import { createBuiltinCommandLibrary } from '../commands/builtinCommands'
import { loadCommandsFromRoots, mergeCommandLibraries } from '../commands/commandLoader'
import { createDomainPackCommandLibrary, registerDomainPackCommandAliases, type DomainPack } from '../packs/domainPacks'

/** app 内置技能根(=cc bundled skills):`ts/src/skills/bundled`。旧值指向已删的 server/skills → 写盘/加载全废,已修。 */
export function defaultSkillsRoot(): string {
  return bundledSkillsRoot()
}

export function defaultCommandsRoot(): string {
  // 内置 slash 命令(doctor/help/model/...)在 ts/commands。⚠️打包态走 resolveBundledDir(execPath 相对,
  // 否则编译二进制 cwd=userData / import.meta.dir=/$bunfs 都找不到,打包后内置命令静默消失)。
  return resolveBundledDir('commands', [
    join(process.cwd(), 'commands'),
    join(process.cwd(), 'ts', 'commands'),
    join(import.meta.dir, '..', '..', 'commands'),
  ])
}

export function workspaceCommandRoots(workspaceRoot: string): string[] {
  // 白标铁律(绝不用 .claude,与记忆/指令/存储同走 .billiardbuddy 命名空间):工作区自定义命令读
  // `<ws>/.billiardbuddy/commands`。丁审计发现此前只读 .claude/.codex、与白标命名不一致,已收口。
  return [
    join(workspaceRoot, MEMORY_DOT_DIR, 'commands'),
  ].filter(existsSync)
}

export async function loadCommandsForWorkspace(workspaceRoot: string, builtInRoot: string, packs: DomainPack[] = [], env: Record<string, string | undefined> = process.env) {
  const [builtInCommands, workspaceCommands] = await Promise.all([
    loadCommandsFromRoots([builtInRoot]),
    // 工作区来源命令的 frontmatter hooks 标 'local'(受信任门约束,防恶意仓库经命令 hooks RCE);
    // app 内置命令省略 → managed(可信)。与 skills 加载的信任分层同构。
    loadCommandsFromRoots(workspaceCommandRoots(workspaceRoot), 'local'),
  ])
  const merged = mergeCommandLibraries(builtInCommands, createBuiltinCommandLibrary(env), createDomainPackCommandLibrary(packs), workspaceCommands)
  // 合并会从 commands 数组重建 byName,丢掉领域包别名键;重新挂上让 /台球、/球房、/billiards 都能解析到入口命令。
  registerDomainPackCommandAliases(merged, packs)
  return merged
}

export function defaultAgentsRoot(): string {
  // app 内置 agents(=cc 的 getBuiltInAgents:general-purpose / Explore / Plan)。cc 把内置 agent 编进代码;
  // 我们放 `ts/src/agents/bundled/<name>.md`。⚠️打包态定位走 resolveBundledDir(execPath 相对,见其文档:
  // 编译二进制 import.meta.dir=/$bunfs、cwd=userData 都失效,不修则打包后子代理静默蒸发)。
  return resolveBundledDir('agents', [
    join(import.meta.dir, '..', 'agents', 'bundled'),
    join(process.cwd(), 'src', 'agents', 'bundled'),
    join(process.cwd(), 'ts', 'src', 'agents', 'bundled'),
  ])
}

export function defaultMcpConfigPath(workspaceRoot: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const libraryDir = env[LIBRARY_DIR_ENV]
  const candidates = [
    join(workspaceRoot, '.mcp.json'),
    ...(libraryDir ? [join(libraryDir, '.mcp.json')] : []),
    join(env.HOME || env.USERPROFILE || process.cwd(), LIBRARY_DOT_DIR, LIBRARY_SUBDIR, '.mcp.json'),
    join(process.cwd(), '.mcp.json'),
  ]
  return candidates.find(existsSync)
}
