/**
 * Product-facing Skills API.
 *
 * The Agent keeps full Skill definitions private. The generic desktop route
 * deliberately exposes no catalog at all. Name-only discovery is reserved for
 * an explicit slash-command request in a Composer.
 */

import * as path from 'path'
import * as fs from 'fs/promises'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getProjectDirsUpToHome } from '../../utils/markdownConfigLoader.js'
import { getCwd } from '../../utils/cwd.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPlugins, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { getSkillDirCommands } from '../../skills/loadSkillsDir.js'
import { initBundledSkills } from '../../skills/bundled/index.js'
import { getBundledSkillDescriptors } from '../../skills/bundledSkills.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { ApiError } from '../middleware/errorHandler.js'

type LoadedSkill = {
  name: string
  userInvocable: boolean
}

type PluginSkillLocation = {
  skillDir: string
}

export type SkillSlashCommand = {
  name: string
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
        (!entry.isDirectory() && !entry.isSymbolicLink()) ||
        entry.name.startsWith('.') ||
        seenNames.has(entry.name)
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
    clearPluginCache('skills-api-external-plugin-state')
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
    .map((skill) => ({ name: skill.name, userInvocable: skill.userInvocable }))

  return [...bundledSkills, ...userSkills, ...projectSkills, ...pluginSkills]
}

function listCommandNames(skills: ReadonlyArray<LoadedSkill>): string[] {
  const names = new Set<string>()
  for (const skill of skills) {
    if (skill.userInvocable) names.add(skill.name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

async function collectLegacySlashCommands(cwd: string): Promise<SkillSlashCommand[]> {
  const commands = await getSkillDirCommands(cwd)
  return commands
    .filter((command) => (
      command.type === 'prompt' &&
      command.loadedFrom === 'commands_DEPRECATED' &&
      command.userInvocable !== false &&
      !command.isHidden
    ))
    .map((command) => ({ name: command.name }))
}

export async function listSkillSlashCommands(cwd?: string): Promise<SkillSlashCommand[]> {
  const requestedCwd = cwd || getCwd()
  const [skills, legacyCommands] = await Promise.all([
    collectAllSkills(requestedCwd),
    collectLegacySlashCommands(requestedCwd),
  ])
  const names = new Set(listCommandNames(skills))
  for (const command of legacyCommands) names.add(command.name)
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name }))
}

export async function handleSkillsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw new ApiError(405, 'Unsupported Skills request', 'SKILL_REQUEST_INVALID')
    }

    // Normal desktop entry points never enumerate implementation Skills.
    if (segments[2] === undefined) return Response.json({ skills: [] })

    throw new ApiError(404, 'Skill not available', 'SKILL_NOT_AVAILABLE')
  } catch (error) {
    return skillErrorResponse(error)
  }
}

function skillErrorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.statusCode : 500
  const code = error instanceof ApiError && error.code === 'SKILL_NOT_AVAILABLE'
    ? 'SKILL_NOT_AVAILABLE'
    : error instanceof ApiError && error.code === 'SKILL_REQUEST_INVALID'
      ? 'SKILL_REQUEST_INVALID'
      : 'SKILLS_UNAVAILABLE'
  return Response.json({ error: code }, { status })
}
