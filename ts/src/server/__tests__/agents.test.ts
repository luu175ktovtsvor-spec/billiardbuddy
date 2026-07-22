import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { clearAgentDefinitionsCache } from '../../tools/AgentTool/loadAgentsDir.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handleProductTaskCommandsApi } from '../api/productTaskCommands.js'
import { handleApiRequest } from '../router.js'

let tmpHome: string
let workspace: string
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalSimpleMode: string | undefined
let originalNativeFileSearch: string | undefined
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

describe('product task Agent command discovery', () => {
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-agents-api-'))
    workspace = path.join(tmpHome, 'workspace')
    await fs.mkdir(workspace, { recursive: true })

    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    originalSimpleMode = process.env.CLAUDE_CODE_SIMPLE
    originalNativeFileSearch = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
    originalCwdState = getCwdState()
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude')
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    delete process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
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
    restoreEnv('CLAUDE_CODE_USE_NATIVE_FILE_SEARCH', originalNativeFileSearch)
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  it('returns only safe display aliases and runtime mappings for discovered Agents', async () => {
    await writePrivateProjectAgent()
    const request = makeRequest(
      `/api/product/task-commands/agents?cwd=${encodeURIComponent(workspace)}`,
    )

    const response = await handleApiRequest(request.req, request.url)

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

  it('keeps local discovery failures inside the product error boundary', async () => {
    const privateValue = '/private/workspace/.claude/agents/internal.md'
    const request = makeRequest('/api/product/task-commands/agents?cwd=/private/workspace')
    const response = await handleProductTaskCommandsApi(
      request.req,
      request.url,
      request.segments,
      {
        listAgents: async () => {
          throw new Error(`unable to read ${privateValue}`)
        },
        listSkills: async () => [],
      },
    )

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toEqual({
      error: 'PRODUCT_TASK_COMMANDS_UNAVAILABLE',
      message: '暂时无法读取可用命令，请稍后重试。',
    })
    expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it('retires generic Agent and Skill discovery routes alongside legacy Agent CRUD', async () => {
    const requests = [
      makeRequest('/api/agents'),
      makeRequest('/api/agents', 'POST', {
        name: 'saved-private-agent',
        description: 'PRIVATE_SAVED_AGENT_DESCRIPTION',
        model: 'PRIVATE_SAVED_AGENT_MODEL',
        tools: ['PRIVATE_SAVED_AGENT_TOOL'],
        systemPrompt: 'PRIVATE_SAVED_AGENT_PROMPT',
      }),
      makeRequest('/api/agents/saved-private-agent'),
      makeRequest('/api/agents/saved-private-agent', 'PUT', {
        description: 'PRIVATE_UPDATED_AGENT_DESCRIPTION',
      }),
      makeRequest('/api/agents/saved-private-agent', 'DELETE'),
      makeRequest('/api/skills/slash-commands'),
      makeRequest('/api/tasks'),
      makeRequest('/api/tasks/lists/legacy-task-list'),
    ]

    for (const { req, url } of requests) {
      const response = await handleApiRequest(req, url)
      expect(response.status).toBe(404)
    }
  })
})
