import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleAgentsApi } from '../api/agents.js'

let tmpHome: string
let workspace: string
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalSimpleMode: string | undefined
let originalCwdState: string

function makeRequest(
  urlPath: string,
  method = 'GET',
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlPath, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return {
    req: new Request(url.toString(), init),
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

async function writePrivateProjectAgent(): Promise<void> {
  const agentsDir = path.join(workspace, '.claude', 'agents')
  await fs.mkdir(agentsDir, { recursive: true })
  await fs.writeFile(
    path.join(agentsDir, 'custom-agent.md'),
    [
      '---',
      'name: custom-agent',
      'description: PRIVATE_AGENT_DESCRIPTION',
      'tools: Read, Bash',
      'model: PRIVATE_AGENT_MODEL',
      'initialPrompt: PRIVATE_AGENT_INITIAL_PROMPT',
      'mcpServers:',
      '  - private-service',
      '---',
      'PRIVATE_AGENT_SYSTEM_PROMPT',
    ].join('\n'),
    'utf8',
  )
  clearAgentDefinitionsCache()
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

describe('Agents API product boundary', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-agents-api-'))
    workspace = path.join(tmpHome, 'workspace')
    await fs.mkdir(workspace, { recursive: true })

    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalSimpleMode = process.env.CLAUDE_CODE_SIMPLE
    originalCwdState = getCwdState()
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    delete process.env.CLAUDE_CODE_SIMPLE
    setCwdState(workspace)
    clearAgentDefinitionsCache()
    clearInstalledPluginsCache()
    clearPluginCache('agents-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearAgentDefinitionsCache()
    clearInstalledPluginsCache()
    clearPluginCache('agents-api-test-teardown')
    resetSettingsCache()
    setCwdState(originalCwdState)
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir)
    restoreEnv('HOME', originalHome)
    restoreEnv('USERPROFILE', originalUserProfile)
    restoreEnv('CLAUDE_CODE_SIMPLE', originalSimpleMode)
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns only safe display aliases and runtime mappings for discovered Agents', async () => {
    await writePrivateProjectAgent()
    const request = makeRequest(
      `/api/agents?cwd=${encodeURIComponent(workspace)}`,
    )

    const response = await handleAgentsApi(request.req, request.url, request.segments)

    expect(response.status).toBe(200)
    const body = await response.json() as {
      agents: Array<{ displayName: string; runtimeName: string }>
    }
    expect(Object.keys(body)).toEqual(['agents'])
    expect(body.agents).toContainEqual({
      displayName: 'agent-guide',
      runtimeName: 'claude-code-guide',
    })

    const customAgent = body.agents.find((agent) => agent.runtimeName === 'custom-agent')
    expect(customAgent?.displayName).toMatch(/^assistant-\d+$/)
    expect(customAgent?.displayName).not.toContain('custom-agent')
    for (const agent of body.agents) {
      expect(Object.keys(agent).sort()).toEqual(['displayName', 'runtimeName'])
    }

    const serialized = JSON.stringify(body)
    for (const privateValue of [
      'PRIVATE_AGENT_DESCRIPTION',
      'PRIVATE_AGENT_MODEL',
      'PRIVATE_AGENT_INITIAL_PROMPT',
      'PRIVATE_AGENT_SYSTEM_PROMPT',
      'private-service',
      workspace,
      'projectSettings',
      'Read',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(body).not.toHaveProperty('activeAgents')
    expect(body).not.toHaveProperty('allAgents')
  })

  it('does not return saved Agent configuration from the legacy CRUD routes', async () => {
    const privateConfig = {
      name: 'saved-private-agent',
      description: 'PRIVATE_SAVED_AGENT_DESCRIPTION',
      model: 'PRIVATE_SAVED_AGENT_MODEL',
      tools: ['PRIVATE_SAVED_AGENT_TOOL'],
      systemPrompt: 'PRIVATE_SAVED_AGENT_PROMPT',
    }
    const create = makeRequest('/api/agents', 'POST', privateConfig)
    const createResponse = await handleAgentsApi(create.req, create.url, create.segments)
    expect(createResponse.status).toBe(201)
    expect(await createResponse.json()).toEqual({ ok: true })

    const detail = makeRequest('/api/agents/saved-private-agent')
    const detailResponse = await handleAgentsApi(detail.req, detail.url, detail.segments)
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toEqual({ available: true })

    const update = makeRequest('/api/agents/saved-private-agent', 'PUT', {
      description: 'PRIVATE_UPDATED_AGENT_DESCRIPTION',
      tools: ['PRIVATE_UPDATED_AGENT_TOOL'],
    })
    const updateResponse = await handleAgentsApi(update.req, update.url, update.segments)
    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toEqual({ ok: true })
  })
})
