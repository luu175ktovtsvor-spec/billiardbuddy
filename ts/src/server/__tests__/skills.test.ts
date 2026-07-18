import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { clearSkillCaches } from '../../skills/loadSkillsDir.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleSkillsApi } from '../api/skills.js'

let tmpHome: string
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalClaudeConfigDir: string | undefined
let originalCwdState: string

type SlashCommandsResponse = {
  commands: Array<{ name: string }>
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

function expectNameOnlyCommands(
  body: SlashCommandsResponse,
  privateValues: readonly string[],
): void {
  expect(Object.keys(body).sort()).toEqual(['commands'])
  for (const command of body.commands) {
    expect(Object.keys(command).sort()).toEqual(['name'])
  }

  const serialized = JSON.stringify(body)
  for (const value of privateValues) {
    expect(serialized).not.toContain(value)
  }
}

describe('Skills API product boundary', () => {
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

  it('keeps ordinary catalog requests empty without scanning or exposing private inputs', async () => {
    const privateValue = 'PRIVATE_SKILL_DESCRIPTION_SENTINEL'
    const { req, url, segments } = makeRequest(
      `/api/skills?cwd=${encodeURIComponent(`/private/${privateValue}`)}`,
    )

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ skills: [] })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('rejects Skill detail requests with a generic code and no request echo', async () => {
    const privateValue = 'PRIVATE_SKILL_DETAIL_SENTINEL'
    const { req, url, segments } = makeRequest(`/api/skills/detail?name=${privateValue}`)

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toEqual({ error: 'SKILL_NOT_AVAILABLE' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('returns only an error code for invalid methods', async () => {
    const privateValue = 'PRIVATE_SKILL_METHOD_SENTINEL'
    const { req, url, segments } = makeRequest(`/api/skills?probe=${privateValue}`, 'POST')

    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toEqual({ error: 'SKILL_REQUEST_INVALID' })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('discovers bundled, user, and project commands only by name after an explicit slash request', async () => {
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

    const { req, url, segments } = makeRequest(
      `/api/skills/slash-commands?cwd=${encodeURIComponent(cwd)}`,
    )
    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectNameOnlyCommands(body, [userDescription, projectDescription, projectBody])
    expect(body.commands).toContainEqual({ name: 'user-skill' })
    expect(body.commands).toContainEqual({ name: 'project-skill' })
    expect(body.commands).toContainEqual({ name: 'image-workbench' })
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

    const { req, url, segments } = makeRequest('/api/skills/slash-commands')
    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectNameOnlyCommands(body, [manifestDescription, skillDescription, marketplaceRoot])
    expect(body.commands).toContainEqual({ name: 'draw:render' })
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

    const { req, url, segments } = makeRequest(
      `/api/skills/slash-commands?cwd=${encodeURIComponent(cwd)}`,
    )
    const response = await handleSkillsApi(req, url, segments)

    expect(response.status).toBe(200)
    const body = await response.json() as SlashCommandsResponse
    expectNameOnlyCommands(body, [description, commandBody])
    expect(body.commands).toContainEqual({ name: 'legacy-command' })
  })
})
