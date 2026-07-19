import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import {
  getBundledSkillExtractDir,
  getBundledSkills,
} from '../../skills/bundledSkills.js'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleApiRequest } from '../router.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalCwdState: string

type SlashCommandsResponse = {
  commands: Array<{
    runtimeName: string
    displayName: string
    description: string
  }>
}

function makeRequest(
  path: string,
  method = 'GET',
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(path, 'http://localhost:3456')
  return {
    req: new Request(url.toString(), { method }),
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  const skillDir = path.join(root, name)
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function expectSafeProductCommands(
  body: SlashCommandsResponse,
  privateValues: readonly string[],
): void {
  expect(Object.keys(body).sort()).toEqual(['commands'])
  for (const command of body.commands) {
    expect(typeof command.runtimeName).toBe('string')
    expect(typeof command.displayName).toBe('string')
    expect(typeof command.description).toBe('string')
    expect(Object.keys(command).sort()).toEqual(['description', 'displayName', 'runtimeName'])
  }

  const serialized = JSON.stringify(body)
  for (const value of privateValues) {
    expect(serialized).not.toContain(value)
  }
}

describe('product task Skill command discovery', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skills-test-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalCwdState = getCwdState()
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    setCwdState(tmpHome)
    clearSkillCaches()
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearSkillCaches()
    clearInstalledPluginsCache()
    clearPluginCache('skills-api-test-teardown')
    resetSettingsCache()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    setCwdState(originalCwdState)
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('rejects unknown task command resources without echoing private input', async () => {
    const privateValue = 'PRIVATE_SKILL_DETAIL_SENTINEL'
    const { req, url } = makeRequest(`/api/product/task-commands/${privateValue}?cwd=/private/${privateValue}`)

    const response = await handleApiRequest(req, url)

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toEqual({ error: 'NOT_FOUND', message: '未知任务命令资源' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('returns a safe product error for invalid methods', async () => {
    const privateValue = 'PRIVATE_SKILL_METHOD_SENTINEL'
    const { req, url } = makeRequest(`/api/product/task-commands/skills?probe=${privateValue}`, 'POST')

    const response = await handleApiRequest(req, url)

    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toEqual({ error: 'METHOD_NOT_ALLOWED', message: '当前任务命令操作暂不支持' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('projects bundled Skills with safe Chinese labels while keeping user and project Skill details private', async () => {
    const userDescription = 'USER_SKILL_PRIVATE_DESCRIPTION_SENTINEL'
    const projectDescription = 'PROJECT_SKILL_PRIVATE_DESCRIPTION_SENTINEL'
    const projectBody = 'PROJECT_SKILL_PRIVATE_BODY_SENTINEL'
    const projectRoot = path.join(tmpHome, 'workspace')
    const cwd = path.join(projectRoot, 'packages', 'app')

    await writeSkill(
      path.join(tmpHome, '.claude', 'skills'),
      'user-skill',
      ['---', `description: ${userDescription}`, '---', '', '# User skill'].join('\n'),
    )
    await writeSkill(
      path.join(projectRoot, '.claude', 'skills'),
      'project-skill',
      ['---', `description: ${projectDescription}`, '---', '', projectBody].join('\n'),
    )

    const { req, url } = makeRequest(
      `/api/product/task-commands/skills?cwd=${encodeURIComponent(cwd)}`,
    )
    const response = await handleApiRequest(req, url)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectSafeProductCommands(body, [userDescription, projectDescription, projectBody])
    expect(body.commands).toContainEqual({
      runtimeName: 'user-skill',
      displayName: 'user-skill',
      description: '当前环境提供的扩展命令。',
    })
    expect(body.commands).toContainEqual({
      runtimeName: 'project-skill',
      displayName: 'project-skill',
      description: '当前环境提供的扩展命令。',
    })
    expect(body.commands).toContainEqual({
      runtimeName: 'image-workbench',
      displayName: '做海报和图片',
      description: '把活动、招聘、朋友圈等自然语言需求整理成可确认的图片草稿。',
    })
  })

  it('writes billiards references only after invoking a discovered command', async () => {
    const macroTarget = globalThis as typeof globalThis & {
      MACRO?: { VERSION: string }
    }
    const previousMacro = macroTarget.MACRO
    if (!previousMacro) macroTarget.MACRO = { VERSION: 'skills-api-test' }

    const skillName = 'venue-daily-review'
    const skillDir = getBundledSkillExtractDir(skillName)
    await fs.rm(skillDir, { recursive: true, force: true })

    try {
      const { req, url } = makeRequest('/api/product/task-commands/skills')
      const response = await handleApiRequest(req, url)
      const body = await response.json() as SlashCommandsResponse

      expect(response.status).toBe(200)
      expect(body.commands).toContainEqual({
        runtimeName: skillName,
        displayName: '复盘今天经营',
        description: '把球房营业数据和当天情况整理成看得懂、能继续跟进的经营复盘。',
      })
      expect(await pathExists(skillDir)).toBe(false)

      const command = getBundledSkills().find((candidate) => candidate.name === skillName)
      expect(command?.type).toBe('prompt')
      if (!command || command.type !== 'prompt') {
        throw new Error(`Bundled skill ${skillName} was not registered as a prompt command`)
      }

      const prompt = await command.getPromptForCommand('整理昨天的营业数据', undefined as never)
      const firstBlock = prompt[0]
      expect(firstBlock?.type).toBe('text')
      if (firstBlock?.type !== 'text') {
        throw new Error(`Bundled skill ${skillName} did not return a text prompt`)
      }

      expect(firstBlock.text).toStartWith(`Base directory for this skill: ${skillDir}`)
      expect(await fs.readFile(path.join(skillDir, 'references', 'README.md'), 'utf-8')).toContain(
        '本资源帮助 Agent 理解球房经营语境',
      )
    } finally {
      await fs.rm(skillDir, { recursive: true, force: true })
      if (previousMacro === undefined) delete macroTarget.MACRO
      else macroTarget.MACRO = previousMacro
    }
  })

  it('discovers an enabled plugin command only by name', async () => {
    const manifestDescription = 'PLUGIN_MANIFEST_PRIVATE_DESCRIPTION_SENTINEL'
    const skillDescription = 'PLUGIN_SKILL_PRIVATE_DESCRIPTION_SENTINEL'
    const marketplaceRoot = path.join(tmpHome, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpHome, '.claude', 'plugins')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })
    await writeSkill(
      path.join(pluginRoot, 'skills'),
      'render',
      ['---', `description: ${skillDescription}`, '---', '', '# Render'].join('\n'),
    )
    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'draw', version: '1.0.0', description: manifestDescription }),
      'utf-8',
    )
    await fs.mkdir(path.join(marketplaceRoot, '.claude-plugin'), { recursive: true })
    await fs.writeFile(
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [{ name: 'draw', source: './plugins/draw', version: '1.0.0' }],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpHome, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'draw@test-market': true } }),
      'utf-8',
    )

    const { req, url } = makeRequest('/api/product/task-commands/skills')
    const response = await handleApiRequest(req, url)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectSafeProductCommands(body, [manifestDescription, skillDescription, marketplaceRoot])
    expect(body.commands).toContainEqual({
      runtimeName: 'draw:render',
      displayName: 'draw:render',
      description: '当前环境提供的扩展命令。',
    })
  })

  it('discovers a legacy command only by name', async () => {
    const description = 'LEGACY_COMMAND_PRIVATE_DESCRIPTION_SENTINEL'
    const commandBody = 'LEGACY_COMMAND_PRIVATE_BODY_SENTINEL'
    const cwd = path.join(tmpHome, 'workspace', 'app')
    await fs.mkdir(path.join(tmpHome, '.claude', 'commands'), { recursive: true })
    await fs.writeFile(
      path.join(tmpHome, '.claude', 'commands', 'legacy-command.md'),
      ['---', `description: ${description}`, '---', '', commandBody].join('\n'),
      'utf-8',
    )

    const { req, url } = makeRequest(
      `/api/product/task-commands/skills?cwd=${encodeURIComponent(cwd)}`,
    )
    const response = await handleApiRequest(req, url)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectSafeProductCommands(body, [description, commandBody])
    expect(body.commands).toContainEqual({
      runtimeName: 'legacy-command',
      displayName: 'legacy-command',
      description: '当前环境提供的扩展命令。',
    })
  })
})
