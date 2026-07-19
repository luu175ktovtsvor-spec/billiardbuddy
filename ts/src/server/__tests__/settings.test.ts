/**
 * Unit tests for Settings, model options, and health-check APIs
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SettingsService } from '../services/settingsService.js'
import { handleProductSettingsApi } from '../api/productSettings.js'
import { handleStatusApi } from '../api/status.js'
import {
  clearOpenAIOAuthTokenCache,
} from '../../services/openaiAuth/storage.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import {
  clearKeychainCache,
  primeKeychainCacheFromPrefetch,
} from '../../utils/secureStorage/macOsKeychainHelpers.js'
import type { OpenAIOAuthTokens } from '../../services/openaiAuth/types.js'
import { getModelOptions } from '../../utils/model/modelOptions.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { clearAllOutputStylesCache } from '../../constants/outputStyles.js'
import { clearOutputStyleCaches } from '../../outputStyles/loadOutputStylesDir.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string
let originalConfigDir: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalShell: string | undefined
let originalPath: string | undefined
let originalCliPath: string | undefined
let originalAnthropicApiKey: string | undefined
let originalAnthropicBaseUrl: string | undefined
let originalAnthropicModel: string | undefined
let originalAnthropicDefaultHaikuModel: string | undefined
let originalAnthropicDefaultSonnetModel: string | undefined
let originalAnthropicDefaultOpusModel: string | undefined
let originalNativeFileSearch: string | undefined

async function setup() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-test-'))
  resetSettingsCache()
  clearAllOutputStylesCache()
  clearOutputStyleCaches()
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  originalShell = process.env.SHELL
  originalPath = process.env.PATH
  originalCliPath = process.env.CLAUDE_CLI_PATH
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL
  originalAnthropicModel = process.env.ANTHROPIC_MODEL
  originalAnthropicDefaultHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  originalAnthropicDefaultSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  originalAnthropicDefaultOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  originalNativeFileSearch = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
  process.env.SHELL = '/bin/zsh'
  process.env.PATH = ''
  // Output styles are discovered via loadMarkdownFiles; with PATH emptied above there is no
  // system ripgrep, so force the native fs walk to keep style discovery deterministic here.
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  clearKeychainCache()
  primeKeychainCacheFromPrefetch(null)
  clearOpenAIOAuthTokenCache()
}

async function teardown() {
  plainTextStorage.delete()
  clearKeychainCache()
  clearOpenAIOAuthTokenCache()
  resetSettingsCache()
  clearAllOutputStylesCache()
  clearOutputStyleCaches()

  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }

  if (originalNativeFileSearch !== undefined) {
    process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = originalNativeFileSearch
  } else {
    delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  }

  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }

  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile
  } else {
    delete process.env.USERPROFILE
  }

  if (originalShell !== undefined) {
    process.env.SHELL = originalShell
  } else {
    delete process.env.SHELL
  }

  if (originalPath !== undefined) {
    process.env.PATH = originalPath
  } else {
    delete process.env.PATH
  }

  if (originalCliPath !== undefined) {
    process.env.CLAUDE_CLI_PATH = originalCliPath
  } else {
    delete process.env.CLAUDE_CLI_PATH
  }

  if (originalAnthropicApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  } else {
    delete process.env.ANTHROPIC_API_KEY
  }

  if (originalAnthropicBaseUrl !== undefined) {
    process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl
  } else {
    delete process.env.ANTHROPIC_BASE_URL
  }

  if (originalAnthropicModel !== undefined) {
    process.env.ANTHROPIC_MODEL = originalAnthropicModel
  } else {
    delete process.env.ANTHROPIC_MODEL
  }

  if (originalAnthropicDefaultHaikuModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = originalAnthropicDefaultHaikuModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  if (originalAnthropicDefaultSonnetModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = originalAnthropicDefaultSonnetModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }

  if (originalAnthropicDefaultOpusModel !== undefined) {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalAnthropicDefaultOpusModel
  } else {
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }

  await fs.rm(tmpDir, { recursive: true, force: true })
}

function saveTestOpenAIOAuthTokens(tokens: OpenAIOAuthTokens) {
  plainTextStorage.update({ openaiCodexOauth: tokens })
  clearOpenAIOAuthTokenCache()
}

/** 创建一个模拟 Request */
function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

// =============================================================================
// SettingsService
// =============================================================================

describe('SettingsService', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('should return empty object when settings file does not exist', async () => {
    const svc = new SettingsService()
    const settings = await svc.getUserSettings()
    expect(settings).toEqual({})
  })

  it('should recover from malformed user settings after an upgrade', async () => {
    await fs.writeFile(path.join(tmpDir, 'settings.json'), '{not json', 'utf-8')

    const svc = new SettingsService()
    const settings = await svc.getUserSettings()
    const files = await fs.readdir(tmpDir)

    expect(settings).toEqual({})
    expect(files.some((name) => name.startsWith('settings.json.invalid-'))).toBe(true)
  })

  it('should write and read user settings', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark', model: 'claude-opus-4-7' })

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.model).toBe('claude-opus-4-7')
  })

  it('should write and read the pure white theme setting', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'white' })

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('white')
  })

  it('should merge settings on update (shallow merge)', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark' })
    await svc.updateUserSettings({ model: 'claude-haiku-4-5' })

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.model).toBe('claude-haiku-4-5')
  })

  it('should not let cached CLI settings overwrite desktop settings updates', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({
      enabledPlugins: {
        'demo@test-market': false,
      },
    })

    expect(getSettingsForSource('userSettings')?.enabledPlugins?.['demo@test-market']).toBe(false)

    await svc.updateUserSettings({
      language: 'chinese',
      desktopNotificationsEnabled: true,
      alwaysThinkingEnabled: false,
    })

    const { error } = updateSettingsForSource('userSettings', {
      enabledPlugins: {
        ...getSettingsForSource('userSettings')?.enabledPlugins,
        'demo@test-market': true,
      },
    })
    expect(error).toBeNull()

    const settings = await svc.getUserSettings()
    expect(settings.language).toBe('chinese')
    expect(settings.desktopNotificationsEnabled).toBe(true)
    expect(settings.alwaysThinkingEnabled).toBe(false)
    expect((settings.enabledPlugins as Record<string, unknown>)['demo@test-market']).toBe(true)
  })

  it('should read and write project settings', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

    const svc = new SettingsService(projectRoot)
    await svc.updateProjectSettings({ outputStyle: 'verbose' })

    const settings = await svc.getProjectSettings()
    expect(settings.outputStyle).toBe('verbose')
  })

  it('should read and write project-local settings', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    const svc = new SettingsService(projectRoot)

    await svc.updateLocalSettings({
      outputStyle: 'Learning',
      preserved: true,
    })
    await svc.updateLocalSettings({
      theme: 'dark',
    })

    const settings = await svc.getLocalSettings()
    expect(settings.outputStyle).toBe('Learning')
    expect(settings.preserved).toBe(true)
    expect(settings.theme).toBe('dark')
  })

  it('should merge user and project settings', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })

    const svc = new SettingsService(projectRoot)
    await svc.updateUserSettings({ theme: 'dark', model: 'claude-opus-4-7' })
    await svc.updateProjectSettings({ theme: 'light' })

    const merged = await svc.getSettings()
    // project overrides user
    expect(merged.theme).toBe('light')
    // user value preserved when not overridden
    expect(merged.model).toBe('claude-opus-4-7')
  })

  it('should get default permission mode', async () => {
    const svc = new SettingsService()
    const mode = await svc.getPermissionMode()
    expect(mode).toBe('default')
  })

  it('should ignore stale invalid permission modes from older installs', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ defaultMode: 'legacy-yolo' }),
      'utf-8',
    )

    const svc = new SettingsService()
    const mode = await svc.getPermissionMode()

    expect(mode).toBe('default')
  })

  it('should set and get permission mode', async () => {
    const svc = new SettingsService()
    await svc.setPermissionMode('plan')
    const mode = await svc.getPermissionMode()
    expect(mode).toBe('plan')
  })

  it('should reject invalid permission mode', async () => {
    const svc = new SettingsService()
    await expect(svc.setPermissionMode('invalid')).rejects.toThrow('Invalid permission mode')
  })

  it('should preserve other settings when updating permission mode', async () => {
    const svc = new SettingsService()
    await svc.updateUserSettings({ theme: 'dark' })
    await svc.setPermissionMode('acceptEdits')

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.defaultMode).toBe('acceptEdits')
  })

  it('should serialize concurrent user settings writes to the same file', async () => {
    const svc = new SettingsService()
    const originalNow = Date.now
    Date.now = () => 1776695497171

    try {
      await Promise.all([
        svc.updateUserSettings({ theme: 'dark' }),
        svc.setPermissionMode('bypassPermissions'),
      ])
    } finally {
      Date.now = originalNow
    }

    const settings = await svc.getUserSettings()
    expect(settings.theme).toBe('dark')
    expect(settings.defaultMode).toBe('bypassPermissions')
  })
})

// =============================================================================
// Settings API
// =============================================================================

describe('Settings API', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('rejects the product settings root and unsupported resources', async () => {
    const generic = makeRequest('GET', '/api/product/settings')
    const project = makeRequest('PATCH', '/api/product/settings/project', { theme: 'dark' })

    expect((await handleProductSettingsApi(generic.req, generic.url, generic.segments)).status).toBe(404)
    expect((await handleProductSettingsApi(project.req, project.url, project.segments)).status).toBe(404)
  })

  it('GET /api/product/settings/user should return user settings', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/product/settings/user')
    const res = await handleProductSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({})
  })

  it('PATCH /api/product/settings/user accepts only ordinary product preferences', async () => {
    const { req, url, segments } = makeRequest('PATCH', '/api/product/settings/user', {
      theme: 'dark',
      chatSendBehavior: 'modifierEnter',
      language: 'chinese',
      desktopNotificationsEnabled: true,
      autoDreamEnabled: true,
      webSearch: { enabled: false },
    })
    const res = await handleProductSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Verify persisted
    const { req: r2, url: u2, segments: s2 } = makeRequest('GET', '/api/product/settings/user')
    const res2 = await handleProductSettingsApi(r2, u2, s2)
    const body2 = await res2.json()
    expect(body2).toEqual({
      theme: 'dark',
      chatSendBehavior: 'modifierEnter',
      language: 'chinese',
      desktopNotificationsEnabled: true,
      autoDreamEnabled: true,
      webSearch: { enabled: false },
    })
  })

  it('does not expose or overwrite Core-owned fields while updating web search', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        model: 'private-model',
        permissions: { allow: ['Bash(private-command)'] },
        webSearch: {
          mode: 'tavily',
          tavilyApiKey: 'existing-private-key',
        },
        desktopTerminal: {
          startupShell: 'custom',
          customShellPath: 'C:\\private\\shell.exe',
        },
      }),
      'utf8',
    )

    const rejected = makeRequest('PATCH', '/api/product/settings/user', {
      model: 'renderer-must-not-write-this',
    })
    expect((await handleProductSettingsApi(rejected.req, rejected.url, rejected.segments)).status).toBe(400)

    const update = makeRequest('PATCH', '/api/product/settings/user', {
      webSearch: {
        enabled: false,
      },
    })
    expect((await handleProductSettingsApi(update.req, update.url, update.segments)).status).toBe(200)

    const settingsRaw = await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf8')
    expect(settingsRaw).not.toContain('renderer-must-not-write-this')
    expect(settingsRaw).toContain('private-model')
    expect(settingsRaw).toContain('existing-private-key')
    expect(JSON.parse(settingsRaw).webSearch).toEqual({
      mode: 'disabled',
      tavilyApiKey: 'existing-private-key',
    })

    const read = makeRequest('GET', '/api/product/settings/user')
    const response = await handleProductSettingsApi(read.req, read.url, read.segments)
    const body = await response.json() as { webSearch: Record<string, unknown> }
    expect(body).toEqual({ webSearch: { enabled: false } })
    expect(JSON.stringify(body)).not.toContain('existing-private-key')
    expect(JSON.stringify(body)).not.toContain('private-model')
  })

  it('rejects malformed and unknown ordinary preferences', async () => {
    const invalidTheme = makeRequest('PATCH', '/api/product/settings/user', { theme: 'white' })
    const providerInput = makeRequest('PATCH', '/api/product/settings/user', {
      webSearch: { enabled: true, provider: 'brave' },
    })

    expect((await handleProductSettingsApi(invalidTheme.req, invalidTheme.url, invalidTheme.segments)).status).toBe(400)
    expect((await handleProductSettingsApi(providerInput.req, providerInput.url, providerInput.segments)).status).toBe(400)
  })

  it('does not expose or mutate Core-owned thinking configuration', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({ alwaysThinkingEnabled: false }),
      'utf8',
    )

    const read = makeRequest('GET', '/api/product/settings/runtime')
    expect(await (await handleProductSettingsApi(read.req, read.url, read.segments)).json()).toEqual({})

    const update = makeRequest('PATCH', '/api/product/settings/runtime', {
      alwaysThinkingEnabled: true,
    })
    expect((await handleProductSettingsApi(update.req, update.url, update.segments)).status).toBe(400)
    expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf8')))
      .toMatchObject({ alwaysThinkingEnabled: false })
  })

  it('keeps runtime network fields scoped and preserves private nested fields', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        network: {
          privateTransportSetting: 'keep-me',
          proxy: {
            privateToken: 'keep-this-too',
          },
        },
      }),
      'utf8',
    )
    const update = makeRequest('PATCH', '/api/product/settings/runtime', {
      network: {
        aiRequestTimeoutMs: 120_000,
        proxy: { mode: 'manual', url: '  http://127.0.0.1:7890  ' },
      },
    })
    expect((await handleProductSettingsApi(update.req, update.url, update.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf8'))
    expect(raw.network).toMatchObject({
      privateTransportSetting: 'keep-me',
      aiRequestTimeoutMs: 120_000,
      proxy: {
        privateToken: 'keep-this-too',
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })

    const read = makeRequest('GET', '/api/product/settings/runtime')
    expect(await (await handleProductSettingsApi(read.req, read.url, read.segments)).json()).toEqual({
      network: {
        aiRequestTimeoutMs: 120_000,
        proxy: { mode: 'manual', url: 'http://127.0.0.1:7890' },
      },
    })

    const unknown = makeRequest('PATCH', '/api/product/settings/runtime', { model: 'not-allowed' })
    expect((await handleProductSettingsApi(unknown.req, unknown.url, unknown.segments)).status).toBe(400)
  })

  it('keeps terminal and update proxy settings behind the desktop endpoint', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        desktopTerminal: { privateTerminalValue: 'preserve' },
        updateProxy: { privateProxyValue: 'preserve' },
      }),
      'utf8',
    )
    const update = makeRequest('PATCH', '/api/product/settings/desktop', {
      desktopTerminal: {
        startupShell: 'custom',
        customShellPath: ' C:\\tools\\pwsh.exe ',
      },
      updateProxy: {
        mode: 'manual',
        url: ' http://127.0.0.1:7890 ',
      },
    })
    expect((await handleProductSettingsApi(update.req, update.url, update.segments)).status).toBe(200)

    const raw = JSON.parse(await fs.readFile(path.join(tmpDir, 'settings.json'), 'utf8'))
    expect(raw.desktopTerminal).toMatchObject({
      privateTerminalValue: 'preserve',
      startupShell: 'custom',
      customShellPath: 'C:\\tools\\pwsh.exe',
    })
    expect(raw.updateProxy).toMatchObject({
      privateProxyValue: 'preserve',
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
    })

    const read = makeRequest('GET', '/api/product/settings/desktop')
    expect(await (await handleProductSettingsApi(read.req, read.url, read.segments)).json()).toEqual({
      desktopTerminal: {
        startupShell: 'custom',
        customShellPath: 'C:\\tools\\pwsh.exe',
      },
      updateProxy: { mode: 'manual', url: 'http://127.0.0.1:7890' },
    })

    const invalid = makeRequest('PATCH', '/api/product/settings/desktop', {
      desktopTerminal: { startupShell: 'custom', customShellPath: '' },
    })
    expect((await handleProductSettingsApi(invalid.req, invalid.url, invalid.segments)).status).toBe(400)
  })

  it('GET /api/product/settings/output-styles should include built-in, user, and project styles', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(tmpDir, 'output-styles'), { recursive: true })
    await fs.mkdir(path.join(projectRoot, '.claude', 'output-styles'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, 'output-styles', 'user-style.md'),
      [
        '---',
        'name: User Style',
        'description: User custom voice',
        'keep-coding-instructions: true',
        '---',
        'User prompt',
      ].join('\n'),
      'utf-8',
    )
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'output-styles', 'project-style.md'),
      [
        '---',
        'name: Project Style',
        'description: Project custom voice',
        '---',
        'Project prompt',
      ].join('\n'),
      'utf-8',
    )
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ outputStyle: 'Project Style' }),
      'utf-8',
    )

    clearAllOutputStylesCache()
    clearOutputStyleCaches()

    const { req, url, segments } = makeRequest(
      'GET',
      `/api/product/settings/output-styles?workDir=${encodeURIComponent(projectRoot)}`,
    )
    const res = await handleProductSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outputStyle).toBe('Project Style')
    expect(body.scope).toBe('localSettings')
    expect(body.workDir).toBe(projectRoot)
    expect(body.styles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'default', source: 'built-in' }),
        expect.objectContaining({ value: 'Explanatory', source: 'built-in' }),
        expect.objectContaining({ value: 'Learning', source: 'built-in' }),
        expect.objectContaining({ value: 'User Style', source: 'userSettings' }),
        expect.objectContaining({ value: 'Project Style', source: 'projectSettings' }),
      ]),
    )
  })

  it('PATCH /api/product/settings/output-style should save to project-local settings and preserve fields', async () => {
    const projectRoot = path.join(tmpDir, 'myproject')
    await fs.mkdir(path.join(projectRoot, '.claude'), { recursive: true })
    await fs.writeFile(
      path.join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ preserved: 'yes' }),
      'utf-8',
    )

    const { req, url, segments } = makeRequest('PATCH', '/api/product/settings/output-style', {
      outputStyle: 'Learning',
      workDir: projectRoot,
    })
    const res = await handleProductSettingsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      outputStyle: 'Learning',
      scope: 'localSettings',
      workDir: projectRoot,
    })

    const raw = await fs.readFile(
      path.join(projectRoot, '.claude', 'settings.local.json'),
      'utf-8',
    )
    const settings = JSON.parse(raw)
    expect(settings.outputStyle).toBe('Learning')
    expect(settings.preserved).toBe('yes')
  })

  it('PATCH /api/product/settings/output-style should reject unavailable styles', async () => {
    const { req, url, segments } = makeRequest('PATCH', '/api/product/settings/output-style', {
      outputStyle: 'Missing Style',
    })
    const res = await handleProductSettingsApi(req, url, segments)

    expect(res.status).toBe(400)
  })

  it('should return 404 for unknown settings endpoint', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/product/settings/unknown')
    const res = await handleProductSettingsApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})

// =============================================================================
describe('Model Options', () => {
  beforeEach(setup)
  afterEach(teardown)

  it('should keep OpenAI OAuth models visible alongside env-configured provider models', () => {
    process.env.ANTHROPIC_API_KEY = 'deepseek-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    saveTestOpenAIOAuthTokens({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
    })

    const options = getModelOptions()
    const values = options
      .map(option => option.value)
      .filter((value): value is string => typeof value === 'string')
    const labels = options.map(option => option.label)

    expect(values).toContain('gpt-5.3-codex')
    expect(values).toContain('gpt-5.4')
    expect(values).toContain('gpt-5.4-mini')
    expect(labels).toContain('deepseek-v4-pro')
    expect(labels).toContain('deepseek-v4-flash')
  })
})

// =============================================================================
// Status API
// =============================================================================

describe('Status API', () => {
  beforeEach(async () => {
    await setup()
  })
  afterEach(teardown)

  it('GET /api/status should return health check', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status')
    const res = await handleStatusApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.version).toBeDefined()
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  it('does not expose retired diagnostics, usage, or user details', async () => {
    for (const path of ['/api/status/diagnostics', '/api/status/usage', '/api/status/user']) {
      const { req, url, segments } = makeRequest('GET', path)
      const res = await handleStatusApi(req, url, segments)
      expect(res.status).toBe(404)
    }
  })

  it('should reject non-GET methods', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/status')
    const res = await handleStatusApi(req, url, segments)
    expect(res.status).toBe(405)
  })

  it('should return 404 for unknown status endpoint', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/status/nonexistent')
    const res = await handleStatusApi(req, url, segments)
    expect(res.status).toBe(404)
  })
})
