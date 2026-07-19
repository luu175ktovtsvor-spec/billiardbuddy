import * as fs from 'fs/promises'
import * as path from 'path'
import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinition as SharedAgentDefinition,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPlugins, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import { getBundledSkillDescriptors } from '../../skills/bundledSkills.js'
import type { LoadedPlugin } from '../../types/plugin.js'

export type ProductTaskAgentCommand = {
  displayName: string
  runtimeName: string
}

export type ProductTaskSkillCommand = {
  /** Runtime identifier used only by the task command policy and adapter. */
  runtimeName: string
  /** Safe product label from a bundled Skill; never sourced from user files. */
  displayName: string
  /** Safe product summary; never sourced from user files. */
  description: string
}

type LoadedSkill = {
  name: string
  userInvocable: boolean
  displayName?: string
  description?: string
}

type PluginSkillLocation = {
  skillDir: string
}

const GUIDE_RUNTIME_NAME = 'claude-code-guide'
const GUIDE_DISPLAY_NAME = 'agent-guide'
const EXTERNAL_SKILL_DESCRIPTION = '当前环境提供的扩展命令。'

/**
 * The task Composer only needs a safe alias and the Core runtime name. Agent
 * definitions themselves remain inside the Agent Core and are never exposed
 * through the product API.
 */
export async function listProductTaskAgentCommands(
  cwd = getCwd(),
): Promise<ProductTaskAgentCommand[]> {
  const { activeAgents } = await getAgentDefinitionsWithOverrides(cwd)
  return serializeAgentCommands(activeAgents)
}

/**
 * The websocket checks a submitted Agent command against this same product
 * discovery projection in the task's real workspace.
 */
export async function listProductTaskAgentRuntimeNames(cwd: string): Promise<string[]> {
  return (await listProductTaskAgentCommands(cwd)).map((agent) => agent.runtimeName)
}

function serializeAgentCommands(
  agents: SharedAgentDefinition[],
): ProductTaskAgentCommand[] {
  const runtimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: ProductTaskAgentCommand[] = []
  let nextAssistantNumber = 1

  for (const agent of agents) {
    const runtimeName = agent.agentType.trim()
    if (!runtimeName || runtimeNames.has(runtimeName)) continue
    runtimeNames.add(runtimeName)

    const displayName = agent.source === 'built-in' && runtimeName === GUIDE_RUNTIME_NAME
      ? GUIDE_DISPLAY_NAME
      : nextGenericAssistantName(displayNames, () => nextAssistantNumber++)
    displayNames.add(displayName)
    commands.push({ displayName, runtimeName })
  }

  return commands
}

function nextGenericAssistantName(
  usedNames: ReadonlySet<string>,
  nextNumber: () => number,
): string {
  let candidate = ''
  do {
    candidate = `assistant-${nextNumber()}`
  } while (usedNames.has(candidate))
  return candidate
}

function getUserSkillsDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'skills')
}

async function loadSkill(skillDir: string, name: string): Promise<LoadedSkill | null> {
  const skillFile = path.join(skillDir, 'SKILL.md')
  try {
    const raw = await fs.readFile(skillFile, 'utf-8')
    const { frontmatter } = parseFrontmatter(raw, skillFile)
    return {
      name,
      userInvocable: frontmatter['user-invocable'] !== false,
    }
  } catch {
    return null
  }
}

async function collectSkillsFromRoots(skillRoots: string[]): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = []
  const seenNames = new Set<string>()

  for (const root of skillRoots) {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (
        (!entry.isDirectory() && !entry.isSymbolicLink())
        || entry.name.startsWith('.')
        || seenNames.has(entry.name)
      ) {
        continue
      }

      const skill = await loadSkill(path.join(root, entry.name), entry.name)
      if (!skill) continue
      seenNames.add(entry.name)
      skills.push(skill)
    }
  }

  return skills
}

function buildPluginSkillName(pluginName: string, skillDir: string): string {
  return `${pluginName}:${path.basename(skillDir)}`
}

async function collectPluginSkillDirectories(): Promise<Map<string, PluginSkillLocation>> {
  const locations = new Map<string, PluginSkillLocation>()

  let enabledPlugins: LoadedPlugin[]
  try {
    resetSettingsCache()
    clearInstalledPluginsCache()
    clearPluginCache('task-command-discovery-external-plugin-state')
    const result = await loadAllPluginsCacheOnly()
    enabledPlugins = result.errors.some((error) => error.type === 'plugin-cache-miss')
      ? (await loadAllPlugins()).enabled
      : result.enabled
  } catch {
    return locations
  }

  for (const plugin of enabledPlugins) {
    const roots = [plugin.skillsPath, ...(plugin.skillsPaths ?? [])]
    for (const root of roots) {
      if (!root) continue

      try {
        if ((await fs.stat(path.join(root, 'SKILL.md'))).isFile()) {
          const name = buildPluginSkillName(plugin.name, root)
          if (!locations.has(name)) locations.set(name, { skillDir: root })
          continue
        }
      } catch {
        // A plugin can expose either one Skill folder or a root of folders.
      }

      let entries: import('fs').Dirent[]
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const skillDir = path.join(root, entry.name)
        try {
          if (!(await fs.stat(path.join(skillDir, 'SKILL.md'))).isFile()) continue
        } catch {
          continue
        }

        const name = buildPluginSkillName(plugin.name, skillDir)
        if (!locations.has(name)) locations.set(name, { skillDir })
      }
    }
  }

  return locations
}

async function collectPluginSkills(): Promise<LoadedSkill[]> {
  const locations = await collectPluginSkillDirectories()
  const skills: LoadedSkill[] = []
  for (const [name, location] of locations) {
    const skill = await loadSkill(location.skillDir, name)
    if (skill) skills.push(skill)
  }
  return skills
}

async function collectAllSkills(cwd = getCwd()): Promise<LoadedSkill[]> {
  const [userSkills, projectSkills, pluginSkills] = await Promise.all([
    collectSkillsFromRoots([getUserSkillsDir()]),
    collectSkillsFromRoots(getProjectDirsUpToHome('skills', cwd)),
    collectPluginSkills(),
  ])

  initBundledSkills()
  const bundledSkills: LoadedSkill[] = getBundledSkillDescriptors()
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      name: skill.name,
      userInvocable: skill.userInvocable,
      ...(skill.displayName?.trim() ? { displayName: skill.displayName.trim() } : {}),
      ...(skill.displayName?.trim() && skill.description.trim()
        ? { description: skill.description.trim() }
        : {}),
    }))

  return [...bundledSkills, ...userSkills, ...projectSkills, ...pluginSkills]
}

function productSkillCommand(skill: LoadedSkill): ProductTaskSkillCommand {
  const runtimeName = skill.name
  const displayName = skill.displayName?.trim()
  if (!displayName) {
    return {
      runtimeName,
      displayName: runtimeName,
      description: EXTERNAL_SKILL_DESCRIPTION,
    }
  }

  const description = skill.description?.trim() || EXTERNAL_SKILL_DESCRIPTION
  return {
    runtimeName,
    displayName,
    description,
  }
}

function listSkillCommands(skills: ReadonlyArray<LoadedSkill>): ProductTaskSkillCommand[] {
  const commandsByRuntimeName = new Map<string, ProductTaskSkillCommand>()
  for (const skill of skills) {
    if (!skill.userInvocable || commandsByRuntimeName.has(skill.name)) continue
    commandsByRuntimeName.set(skill.name, productSkillCommand(skill))
  }
  return [...commandsByRuntimeName.values()].sort((left, right) => (
    left.runtimeName.localeCompare(right.runtimeName)
  ))
}

async function collectLegacySlashCommands(cwd: string): Promise<ProductTaskSkillCommand[]> {
  const commands = await getSkillDirCommands(cwd)
  return commands
    .filter((command) => (
      command.type === 'prompt'
      && command.loadedFrom === 'commands_DEPRECATED'
      && command.userInvocable !== false
      && !command.isHidden
    ))
    .map((command) => ({
      runtimeName: command.name,
      displayName: command.name,
      description: EXTERNAL_SKILL_DESCRIPTION,
    }))
}

/**
 * Enumerates user-invocable slash command names plus product-safe labels for
 * bundled Skills. Skill text, paths, frontmatter and plugin metadata stay
 * private to the Agent Core.
 */
export async function listProductTaskSkillCommands(
  cwd = getCwd(),
): Promise<ProductTaskSkillCommand[]> {
  const [skills, legacyCommands] = await Promise.all([
    collectAllSkills(cwd),
    collectLegacySlashCommands(cwd),
  ])
  const commandsByRuntimeName = new Map<string, ProductTaskSkillCommand>()
  for (const command of listSkillCommands(skills)) {
    commandsByRuntimeName.set(command.runtimeName, command)
  }
  for (const command of legacyCommands) {
    if (!commandsByRuntimeName.has(command.runtimeName)) {
      commandsByRuntimeName.set(command.runtimeName, command)
    }
  }
  return [...commandsByRuntimeName.values()].sort((left, right) => (
    left.runtimeName.localeCompare(right.runtimeName)
  ))
}

export async function listProductTaskSkillNames(cwd: string): Promise<string[]> {
  return (await listProductTaskSkillCommands(cwd)).map((command) => command.runtimeName)
}
