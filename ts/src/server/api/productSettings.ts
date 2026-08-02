/**
 * Product settings REST API
 *
 * GET/PATCH /api/product/settings/user    — 普通产品偏好
 * GET/PATCH /api/product/settings/runtime — 网络运行时偏好
 * GET/PATCH /api/product/settings/desktop — 桌面宿主偏好
 */

import { ProductSettingsRepository } from '../product/productSettingsRepository.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  MAX_AI_REQUEST_TIMEOUT_MS,
  MIN_AI_REQUEST_TIMEOUT_MS,
  normalizeNetworkSettings,
} from '../services/networkSettings.js'

const settingsService = new ProductSettingsRepository()

const PRODUCT_THEME_MODES = ['light', 'dark', 'system'] as const
const CHAT_SEND_BEHAVIORS = ['enter', 'modifierEnter'] as const
const NETWORK_PROXY_MODES = ['direct', 'system', 'manual'] as const
const UPDATE_PROXY_MODES = ['system', 'manual'] as const

const USER_PREFERENCE_KEYS = [
  'theme',
  'chatSendBehavior',
  'language',
  'desktopNotificationsEnabled',
  'webSearch',
  'deepThinkingEnabled',
  'preventSleepWhileRunning',
] as const
const RUNTIME_SETTING_KEYS = [
  'network',
] as const
const DESKTOP_SETTING_KEYS = ['updateProxy'] as const

export async function handleProductSettingsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[3] // 'user' | 'runtime' | 'desktop' | undefined

    if (segments[4]) {
      throw ApiError.notFound('未知产品设置资源')
    }

    switch (sub) {
      case undefined:
        throw ApiError.notFound('未知产品设置资源')

      case 'user':
        return await handleUserSettings(req)

      case 'runtime':
        return await handleRuntimeSettings(req)

      case 'desktop':
        return await handleDesktopSettings(req)

      default:
        throw ApiError.notFound(`Unknown settings endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleUserSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.get()
    return Response.json(projectUserPreferences(settings))
  }

  if (req.method === 'PATCH') {
    const update = validateUserPreferenceUpdate(await parseJsonBody(req))
    await settingsService.mutate(current =>
      mergeUserPreferenceUpdate(current, update),
    )
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleRuntimeSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json(projectRuntimeSettings(await settingsService.get()))
  }

  if (req.method === 'PATCH') {
    const update = validateRuntimeSettingsUpdate(await parseJsonBody(req))
    await settingsService.mutate(current =>
      mergeRuntimeSettingsUpdate(current, update),
    )
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleDesktopSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json(projectDesktopSettings(await settingsService.get()))
  }

  if (req.method === 'PATCH') {
    const update = validateDesktopSettingsUpdate(await parseJsonBody(req))
    await settingsService.mutate(current =>
      mergeDesktopSettingsUpdate(current, update),
    )
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

// ─── Product preference boundary ─────────────────────────────────────────────

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function copyRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {}
}

function isOneOf<T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === 'string' && choices.includes(value as T[number])
}

function assertKnownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  endpoint: string,
): void {
  const unknown = Object.keys(body).filter(key => !allowed.includes(key))
  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Unsupported ${endpoint} setting: ${unknown.join(', ')}`,
    )
  }
}

function assertBoolean(value: unknown, key: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw ApiError.badRequest(`Invalid "${key}" setting`)
  }
}

function assertString(value: unknown, key: string): asserts value is string {
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`Invalid "${key}" setting`)
  }
}

function assertRecord(value: unknown, key: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw ApiError.badRequest(`Invalid "${key}" setting`)
  }
}

function projectUserPreferences(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  if (isOneOf(settings.theme, PRODUCT_THEME_MODES)) result.theme = settings.theme
  if (isOneOf(settings.chatSendBehavior, CHAT_SEND_BEHAVIORS)) {
    result.chatSendBehavior = settings.chatSendBehavior
  }
  if (typeof settings.language === 'string') result.language = settings.language
  if (typeof settings.desktopNotificationsEnabled === 'boolean') {
    result.desktopNotificationsEnabled = settings.desktopNotificationsEnabled
  }
  if (typeof settings.deepThinkingEnabled === 'boolean') {
    result.deepThinkingEnabled = settings.deepThinkingEnabled
  }
  if (typeof settings.preventSleepWhileRunning === 'boolean') {
    result.preventSleepWhileRunning = settings.preventSleepWhileRunning
  }
  if (hasOwn(settings, 'webSearch')) {
    const webSearch = copyRecord(settings.webSearch)
    result.webSearch = {
      enabled: typeof webSearch.enabled === 'boolean'
        ? webSearch.enabled
        : webSearch.mode !== 'disabled',
    }
  }

  return result
}

function validateUserPreferenceUpdate(body: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(body, USER_PREFERENCE_KEYS, 'user preference')
  const update: Record<string, unknown> = {}

  if (hasOwn(body, 'theme')) {
    if (!isOneOf(body.theme, PRODUCT_THEME_MODES)) {
      throw ApiError.badRequest('Invalid "theme" setting')
    }
    update.theme = body.theme
  }
  if (hasOwn(body, 'chatSendBehavior')) {
    if (!isOneOf(body.chatSendBehavior, CHAT_SEND_BEHAVIORS)) {
      throw ApiError.badRequest('Invalid "chatSendBehavior" setting')
    }
    update.chatSendBehavior = body.chatSendBehavior
  }
  if (hasOwn(body, 'language')) {
    if (body.language !== null) assertString(body.language, 'language')
    // JSON has no undefined. Null is the explicit clear operation for the
    // product language preference and is omitted on the next atomic write.
    update.language = body.language === null ? undefined : body.language
  }
  if (hasOwn(body, 'desktopNotificationsEnabled')) {
    assertBoolean(body.desktopNotificationsEnabled, 'desktopNotificationsEnabled')
    update.desktopNotificationsEnabled = body.desktopNotificationsEnabled
  }
  if (hasOwn(body, 'deepThinkingEnabled')) {
    assertBoolean(body.deepThinkingEnabled, 'deepThinkingEnabled')
    update.deepThinkingEnabled = body.deepThinkingEnabled
  }
  if (hasOwn(body, 'preventSleepWhileRunning')) {
    assertBoolean(body.preventSleepWhileRunning, 'preventSleepWhileRunning')
    update.preventSleepWhileRunning = body.preventSleepWhileRunning
  }
  if (hasOwn(body, 'webSearch')) {
    assertRecord(body.webSearch, 'webSearch')
    assertKnownKeys(body.webSearch, ['enabled'], 'web search')
    assertBoolean(body.webSearch.enabled, 'webSearch.enabled')
    update.webSearch = body.webSearch.enabled
  }

  return update
}

function mergeUserPreferenceUpdate(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current, ...update }

  if (hasOwn(update, 'webSearch')) {
    const webSearch = copyRecord(current.webSearch)
    // Retire external-search configuration on the next ordinary product
    // update. Only the user-facing native-search toggle remains persisted.
    delete webSearch.mode
    delete webSearch.tavilyApiKey
    delete webSearch.braveApiKey
    webSearch.enabled = update.webSearch
    next.webSearch = webSearch
  }

  return next
}

function projectRuntimeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (hasOwn(settings, 'network')) {
    result.network = normalizeNetworkSettings(settings)
  }
  return result
}

function validateRuntimeSettingsUpdate(body: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(body, RUNTIME_SETTING_KEYS, 'runtime')
  const update: Record<string, unknown> = {}

  if (hasOwn(body, 'network')) {
    update.network = validateNetworkSettingsUpdate(body.network)
  }

  return update
}

function validateNetworkSettingsUpdate(value: unknown): Record<string, unknown> {
  assertRecord(value, 'network')
  assertKnownKeys(value, ['aiRequestTimeoutMs', 'proxy'], 'network')
  const update: Record<string, unknown> = {}

  if (hasOwn(value, 'aiRequestTimeoutMs')) {
    const timeout = value.aiRequestTimeoutMs
    if (
      typeof timeout !== 'number' ||
      !Number.isFinite(timeout) ||
      timeout < MIN_AI_REQUEST_TIMEOUT_MS ||
      timeout > MAX_AI_REQUEST_TIMEOUT_MS
    ) {
      throw ApiError.badRequest('Invalid "network.aiRequestTimeoutMs" setting')
    }
    update.aiRequestTimeoutMs = Math.round(timeout)
  }
  if (hasOwn(value, 'proxy')) {
    assertRecord(value.proxy, 'network.proxy')
    assertKnownKeys(value.proxy, ['mode', 'url'], 'network proxy')
    const proxy: Record<string, unknown> = {}
    if (hasOwn(value.proxy, 'mode')) {
      if (!isOneOf(value.proxy.mode, NETWORK_PROXY_MODES)) {
        throw ApiError.badRequest('Invalid "network.proxy.mode" setting')
      }
      proxy.mode = value.proxy.mode
    }
    if (hasOwn(value.proxy, 'url')) {
      assertString(value.proxy.url, 'network.proxy.url')
      proxy.url = value.proxy.url.trim()
    }
    update.proxy = proxy
  }

  return update
}

function mergeRuntimeSettingsUpdate(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current, ...update }
  if (!hasOwn(update, 'network')) return next

  const currentNetwork = copyRecord(current.network)
  const networkUpdate = copyRecord(update.network)
  const network = { ...currentNetwork, ...networkUpdate }
  if (hasOwn(networkUpdate, 'proxy')) {
    network.proxy = {
      ...copyRecord(currentNetwork.proxy),
      ...copyRecord(networkUpdate.proxy),
    }
  }
  const proxy = copyRecord(network.proxy)
  if (proxy.mode !== 'manual') proxy.url = ''
  network.proxy = proxy
  next.network = network
  return next
}

function projectDesktopSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const updateProxy = copyRecord(settings.updateProxy)
  if (isOneOf(updateProxy.mode, UPDATE_PROXY_MODES)) {
    result.updateProxy = {
      mode: updateProxy.mode,
      url: typeof updateProxy.url === 'string' ? updateProxy.url : '',
    }
  }
  return result
}

function validateDesktopSettingsUpdate(body: Record<string, unknown>): Record<string, unknown> {
  assertKnownKeys(body, DESKTOP_SETTING_KEYS, 'desktop')
  const update: Record<string, unknown> = {}

  if (hasOwn(body, 'updateProxy')) {
    assertRecord(body.updateProxy, 'updateProxy')
    assertKnownKeys(body.updateProxy, ['mode', 'url'], 'update proxy')
    const updateProxy: Record<string, unknown> = {}
    if (hasOwn(body.updateProxy, 'mode')) {
      if (!isOneOf(body.updateProxy.mode, UPDATE_PROXY_MODES)) {
        throw ApiError.badRequest('Invalid "updateProxy.mode" setting')
      }
      updateProxy.mode = body.updateProxy.mode
    }
    if (hasOwn(body.updateProxy, 'url')) {
      assertString(body.updateProxy.url, 'updateProxy.url')
      updateProxy.url = body.updateProxy.url.trim()
    }
    update.updateProxy = updateProxy
  }

  return update
}

function mergeDesktopSettingsUpdate(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current, ...update }

  if (hasOwn(update, 'updateProxy')) {
    const updateProxy = {
      ...copyRecord(current.updateProxy),
      ...copyRecord(update.updateProxy),
    }
    if (updateProxy.mode !== 'manual') updateProxy.url = ''
    next.updateProxy = updateProxy
  }

  return next
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
  if (!isRecord(body)) {
    throw ApiError.badRequest('Settings request body must be an object')
  }
  return body
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
