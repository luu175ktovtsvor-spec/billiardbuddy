import { executeApproved, handleReject, runAgentLoop } from '../harness/loop'
import { getWorkspaceGitStatus } from '../harness/env'
import { buildSystemPrompt } from '../harness/systemPrompt'
import { summarizeWorkspaceProjectInstructions } from '../harness/projectInstructions'
import { scriptedModel } from '../harness/fakeModel'
import { compactPipeline } from '../context/compaction'
import { buildStoreMemoryContext } from '../memory/storeMemoryContext'
import { createModelFromProviderCandidates } from '../model/modelFactory'
import { getConfiguredOrBuiltInModelContextWindow } from '../model/modelContextWindows'
import { SessionService, TurnRegistry, type SessionEventRecord, type SessionStatus, type SessionStreamEvent } from './services/sessionService'
import { ProviderService, type RuntimeProviderResolution } from './services/providerService'
import { ProviderHealthStore, type ProviderHealthEntry } from './services/providerHealthStore'
import { LegacyAgentStore, type LegacyArtifact } from './services/legacyAgentStore'
import { DesktopDataStore } from './services/desktopDataStore'
import { StoreDocsService, createStoreDocsTool } from './services/storeDocsService'
import {
  OfficeDocumentError,
  editXlsxCell,
  isDocxPath,
  isPptxPath,
  isXlsxPath,
  readOfficeDocumentBlocks,
  readXlsxSheet,
  renderMinimalPptx,
  renderMinimalXlsx,
  saveOfficeDocumentBlocks,
} from './services/officeDocuments'
import { VoiceTranscriptionError, transcribeVoiceFile } from './services/voiceTranscription'
import { buildGeneralRegistry } from '../tools/generalTools'
import { workspaceForActiveWorktree } from '../tools/worktreeTools'
import { loadSkillsDir } from '../skills/skillLoader'
import { loadCommandsFromRoots, mergeCommandLibraries, normalizeCommandName, parseCommandInvocation, publicCommand } from '../commands/commandLoader'
import { loadHookRegistryFile } from '../hooks/hookConfig'
import { createDomainPackCommandLibrary, createDomainPackHookRegistry, createDomainPackTools, listPublicDomainPacks, mergeHookRegistries, resolveEnabledPacks, suggestedSkillNamesForPacks, type DomainPack } from '../packs/domainPacks'
import { clearThreadGoalHook, createGoalHookRegistry, ensureThreadGoalHookFromTranscript, getThreadGoal, parseGoalCommand, setThreadGoalHook } from '../goals/goalState'
import { loadAgentsDir } from '../agents/agentLoader'
import { createAgentTaskSidechainTools, createAgentTaskTool } from '../agents/agentTool'
import {
  closeMcpConnections,
  defaultElicitationHandler,
  loadMcpToolsFromFile,
  type McpElicitationHandlerInput,
  type McpSamplingHandlerInput,
} from '../mcp/client'
import { loadMcpConfigFile } from '../mcp/config'
import { addMcpServer, defaultWritableMcpConfigPath, MCP_PRESETS, removeMcpServer, setMcpServerDisabled } from '../mcp/configStore'
import { TaskService, type TaskMeta, type TaskStatus } from '../tasks/taskService'
import { TaskListService } from '../tasks/taskListService'
import { createBackgroundAgentTaskTool, createTaskTools, resumeBackgroundAgentTask, startBackgroundAgentRun, type BackgroundAgentTaskOptions } from '../tasks/taskTools'
import { createStructuredTaskTools } from '../tasks/taskListTools'
import { TeamService } from '../tasks/teamService'
import { createTeamTools } from '../tasks/teamTools'
import { startUdsInbox, type UdsInboxServer } from '../tasks/udsInbox'
import { UdsPeerRegistry, type UdsPeerRecord } from '../tasks/udsPeerRegistry'
import { BridgePeerRegistry } from '../tasks/bridgePeerRegistry'
import { BridgeRemoteState, type BridgeRemotePermissionResponse, type BridgeRemotePermissionStatus, type BridgeRemoteOutboxStatus } from '../tasks/bridgeRemoteState'
import { bridgeRemoteConfigFromEnv, createBridgeRemoteTransport } from '../tasks/bridgeRemoteTransport'
import { MediaJobService, resolveMediaBackendUrl, type MediaJobKind } from '../media/mediaJobs'
import { createMediaTools } from '../media/mediaTools'
import { VideoEditError, VideoEditProjectStore } from '../media/videoEditProjects'
import { loadOutputStyles, publicOutputStyle, renderOutputStylePrompt } from '../outputStyles/outputStyleLoader'
import { defaultPluginInstallDir, defaultPluginRoots, installPluginFromGithub, listPlugins, setPluginEnabled } from '../plugins/pluginLoader'
import { Workspace } from '../workspace/workspace'
import type { AssistantStep, Model } from '../types/model'
import { textBlock, type Message } from '../types/message'
import type { AgentEvent, AskQuestionField } from '../types/events'
import type { FetchLike } from '../proxy/ProxyModel'
import type { PermissionMode } from '../permissions/types'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'

function sseLine(ev: AgentEvent | { type: 'done' }): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

function sseReplayLine(seq: number, ev: SessionStreamEvent): string {
  return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

function legacySseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export interface StartServerOptions {
  host?: string
  port?: number
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  transcriptRoot?: string
  providerRoot?: string
  skillsRoot?: string
  commandsRoot?: string
  hooksPath?: string
  agentsRoot?: string
  mcpConfigPath?: string
  mediaBackendUrl?: string
}

interface WorkspaceTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: WorkspaceTreeEntry[]
  truncated?: boolean
}

const WORKSPACE_TREE_SKIP = new Set([
  '.git',
  '.next',
  '.agent-state',
  '.cache',
  '.mypy_cache',
  '.playwright-cli',
  '.pytest_cache',
  '.ruff_cache',
  '.superpowers',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'output',
])

async function summarizeWorkspaceTree(root: string, opts: { maxDepth?: number; maxEntries?: number } = {}) {
  const maxDepth = opts.maxDepth ?? 2
  const maxEntries = opts.maxEntries ?? 120
  let total = 0
  let truncated = false

  async function walk(dir: string, depth: number): Promise<WorkspaceTreeEntry[]> {
    if (total >= maxEntries) {
      truncated = true
      return []
    }
    let entries = await readdir(dir, { withFileTypes: true })
    entries = entries
      .filter(entry => entry.name !== '.DS_Store')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-Hans-CN'))

    const out: WorkspaceTreeEntry[] = []
    for (const entry of entries) {
      if (total >= maxEntries) {
        truncated = true
        break
      }
      if (entry.isDirectory() && WORKSPACE_TREE_SKIP.has(entry.name)) continue
      const abs = resolve(dir, entry.name)
      const item: WorkspaceTreeEntry = {
        name: entry.name,
        path: relative(root, abs) || entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }
      total += 1
      if (entry.isDirectory() && depth < maxDepth) {
        item.children = await walk(abs, depth + 1)
        if (truncated) item.truncated = true
      }
      out.push(item)
    }
    return out
  }

  try {
    return { root, entries: await walk(root, 0), total, truncated }
  } catch (err) {
    return { root, entries: [], total: 0, truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function localCorsOrigin(req: Request): string | undefined {
  const origin = req.headers.get('origin')
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1') {
      return origin
    }
  } catch {
    return undefined
  }
  return undefined
}

function withLocalCors(res: Response, req: Request): Response {
  const origin = localCorsOrigin(req)
  if (!origin) return res
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.append('Vary', 'Origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

function localCorsPreflight(req: Request): Response | undefined {
  const origin = localCorsOrigin(req)
  if (!origin || req.method !== 'OPTIONS') return undefined
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || 'content-type,authorization',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    },
  })
}

interface AgentWsData {
  conversationId: string
  after: number
}

class TurnSetupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function permissionModeFrom(value: unknown): PermissionMode {
  return value === 'auto_files' || value === 'full' || value === 'plan' || value === 'bypassPermissions'
    ? value
    : 'ask'
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : []
}

function messageText(message: Message): string {
  return message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return block.thinking
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function isSensitiveFilePath(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (name === '.env' || name.startsWith('.env.')) return true
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(name)) return true
  return /(secret|credential|token|password|api[_-]?key)/i.test(name)
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function imageProviderGuess(baseUrl: string | undefined): { provider: string; known: string[] } {
  const url = (baseUrl || '').toLowerCase()
  if (url.includes('openai')) return { provider: 'openai', known: ['gpt-image-1', 'gpt-image-2'] }
  if (url.includes('volc') || url.includes('doubao') || url.includes('ark')) return { provider: 'volcengine', known: ['doubao-seedream-4-5', 'doubao-seedream-4-0', 'doubao-seedance'] }
  if (url.includes('fal')) return { provider: 'fal', known: ['fal-ai/flux', 'fal-ai/imagen4', 'fal-ai/veo3'] }
  if (url.includes('replicate')) return { provider: 'replicate', known: ['black-forest-labs/flux', 'google/imagen'] }
  return { provider: 'unknown', known: [] }
}

function runtimeProviderLabel(runtime: RuntimeProviderResolution): string {
  if (runtime.source === 'saved-provider') return runtime.providerName || runtime.providerId || runtime.config.model
  return `环境变量:${runtime.config.model}`
}

function runtimeProviderKey(runtime: RuntimeProviderResolution): string {
  if (runtime.source === 'saved-provider' && runtime.providerId) return `saved:${runtime.providerId}`
  return `${runtime.source}:${runtime.config.apiFormat}:${runtime.config.baseUrl}:${runtime.config.model}`
}

function sanitizeProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .slice(0, 180)
}

function createModelFromRuntimeProviders(
  runtimes: RuntimeProviderResolution[],
  fetchImpl?: StartServerOptions['fetchImpl'],
  health?: {
    onFailure?: (runtime: RuntimeProviderResolution, err: unknown) => void
    onSuccess?: (runtime: RuntimeProviderResolution) => void
  },
): Model {
  return createModelFromProviderCandidates(
    runtimes.map(runtime => ({
      label: runtimeProviderLabel(runtime),
      config: runtime.config,
      onFailure: err => health?.onFailure?.(runtime, err),
      onSuccess: () => health?.onSuccess?.(runtime),
    })),
    { fetchImpl },
  )
}

const LEGACY_BYOK_TEXT_PROVIDER_ID = 'byok-text'

function validateImageModelPayload(body: Record<string, unknown>) {
  const baseUrl = typeof body.base_url === 'string' ? body.base_url : typeof body.baseUrl === 'string' ? body.baseUrl : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const guessed = imageProviderGuess(baseUrl)
  if (!model) {
    return { ok: false, level: 'warning', message: '缺少生图模型名。', provider: guessed.provider, known_models: guessed.known }
  }
  if (guessed.provider === 'unknown') {
    return { ok: true, level: 'info', message: '未知供应商端点，已跳过模型归属校验。', provider: guessed.provider, known_models: guessed.known }
  }
  const normalized = model.toLowerCase()
  const ok = guessed.known.some(item => normalized.includes(item.toLowerCase())) ||
    (guessed.provider === 'openai' && normalized.startsWith('gpt-image')) ||
    (guessed.provider === 'volcengine' && (normalized.includes('seedream') || normalized.includes('seedance') || normalized.includes('doubao'))) ||
    (guessed.provider === 'fal' && (normalized.includes('flux') || normalized.includes('imagen') || normalized.includes('veo'))) ||
    (guessed.provider === 'replicate' && normalized.includes('/'))
  return {
    ok,
    level: ok ? 'ok' : 'warning',
    message: ok ? '模型名和当前供应商看起来匹配。' : '模型名跟所选供应商可能对不上，建议确认后再生成。',
    provider: guessed.provider,
    known_models: guessed.known,
  }
}

function defaultSkillsRoot(): string {
  const candidates = [
    join(process.cwd(), 'server', 'skills'),
    join(process.cwd(), '..', 'server', 'skills'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function defaultHooksPath(): string | undefined {
  const candidates = [
    join(process.cwd(), 'server', 'hooks.json'),
    join(process.cwd(), '..', 'server', 'hooks.json'),
  ]
  return candidates.find(existsSync)
}

function defaultCommandsRoot(): string {
  const candidates = [
    join(process.cwd(), 'server', 'commands'),
    join(process.cwd(), '..', 'server', 'commands'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function workspaceCommandRoots(workspaceRoot: string): string[] {
  return [
    join(workspaceRoot, '.claude', 'commands'),
    join(workspaceRoot, '.codex', 'commands'),
  ].filter(existsSync)
}

async function loadCommandsForWorkspace(workspaceRoot: string, builtInRoot: string, packs: DomainPack[] = []) {
  const [builtInCommands, workspaceCommands] = await Promise.all([
    loadCommandsFromRoots([builtInRoot]),
    loadCommandsFromRoots(workspaceCommandRoots(workspaceRoot)),
  ])
  return mergeCommandLibraries(builtInCommands, createDomainPackCommandLibrary(packs), workspaceCommands)
}

function localCommandMessage(name: string, args: string, output: string): Message {
  return {
    role: 'user',
    content: [textBlock([
      `<command-name>/${name}</command-name>`,
      `<command-args>${args}</command-args>`,
      '<local-command-stdout>',
      output,
      '</local-command-stdout>',
    ].join('\n'))],
  }
}

async function handleGoalCommand(conversationId: string, args: string, transcript: { load(): Promise<Message[]>; save(messages: Message[]): Promise<void> }): Promise<{ output: string; shouldQuery: boolean }> {
  const messages = await transcript.load()
  let parsed: ReturnType<typeof parseGoalCommand>
  try {
    parsed = parseGoalCommand(args)
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    messages.push(localCommandMessage('goal', args, output))
    await transcript.save(messages)
    return { output, shouldQuery: false }
  }

  if (parsed.type === 'clear') {
    const existing = getThreadGoal(conversationId) ?? ensureThreadGoalHookFromTranscript(conversationId, messages)
    const cleared = clearThreadGoalHook(conversationId)
    const output = cleared || existing ? `Goal cleared: ${(cleared ?? existing)!.objective}` : 'No active goal.'
    messages.push(localCommandMessage('goal', args, output))
    await transcript.save(messages)
    return { output, shouldQuery: false }
  }

  const goal = setThreadGoalHook(conversationId, parsed.objective)
  const output = `Goal set: ${goal.objective}`
  messages.push(localCommandMessage('goal', args, output))
  await transcript.save(messages)
  return { output, shouldQuery: true }
}

function defaultOutputStylesRoot(): string {
  const candidates = [
    join(process.cwd(), 'server', 'output-styles'),
    join(process.cwd(), '..', 'server', 'output-styles'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function defaultAgentsRoot(): string {
  const candidates = [
    join(process.cwd(), 'server', 'agents'),
    join(process.cwd(), '..', 'server', 'agents'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

function defaultMcpConfigPath(workspaceRoot: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const candidates = [
    join(workspaceRoot, '.mcp.json'),
    ...(env.DESKTOP_LIBRARY_DIR ? [join(env.DESKTOP_LIBRARY_DIR, '.mcp.json')] : []),
    join(env.HOME || env.USERPROFILE || process.cwd(), '.billiards-desktop', 'library', '.mcp.json'),
    join(process.cwd(), '.mcp.json'),
    join(process.cwd(), 'server', 'mcp.json'),
    join(process.cwd(), '..', 'server', 'mcp.json'),
  ]
  return candidates.find(existsSync)
}

function jsonError(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status })
}

function jsonDetailError(message: string, status = 400): Response {
  return Response.json({ ok: false, detail: message, error: message }, { status })
}

function providerStatusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('not found')) return 404
  if (message.includes('already exists')) return 409
  if (message.includes('cannot delete active')) return 409
  if (message.includes('cannot activate disabled')) return 409
  if (message.includes('required') || message.includes('unsupported') || message.includes('非法')) return 400
  return 500
}

function providerPath(url: URL): { matched: boolean; segments: string[] } {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'providers') return { matched: true, segments: segments.slice(1) }
  if (segments[0] === 'api' && segments[1] === 'providers') return { matched: true, segments: segments.slice(2) }
  return { matched: false, segments: [] }
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function taskStatusFrom(value: unknown): TaskStatus | undefined {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

function bridgePermissionStatusFrom(value: unknown): BridgeRemotePermissionStatus | undefined {
  return value === 'pending' || value === 'allowed' || value === 'denied' || value === 'cancelled'
    ? value
    : undefined
}

function bridgeOutboxStatusFrom(value: unknown): BridgeRemoteOutboxStatus | undefined {
  return value === 'queued' || value === 'sent' ? value : undefined
}

function bridgePermissionResponseFrom(body: Record<string, unknown>): BridgeRemotePermissionResponse {
  const behavior = body.behavior
  if (behavior === 'allow') {
    return { behavior: 'allow', updatedInput: isRecord(body.updatedInput) ? body.updatedInput : isRecord(body.updated_input) ? body.updated_input : {} }
  }
  if (behavior === 'deny') {
    return { behavior: 'deny', message: stringOr(body.message, 'Permission denied') }
  }
  throw new Error('behavior required')
}

function bridgeRemoteConfigFromBody(rawBody: Record<string, unknown>, env: Record<string, string | undefined>) {
  const fromEnv = bridgeRemoteConfigFromEnv(env)
  const nested = isRecord(rawBody.bridgeRemote) ? rawBody.bridgeRemote : isRecord(rawBody.bridge_remote) ? rawBody.bridge_remote : {}
  const baseUrl = stringOr(rawBody.bridgeRemoteBaseUrl ?? rawBody.bridge_remote_base_url ?? nested.baseUrl ?? nested.base_url, '') || fromEnv?.baseUrl
  const token = stringOr(rawBody.bridgeRemoteToken ?? rawBody.bridge_remote_token ?? nested.token, '') || fromEnv?.token
  if (!baseUrl || !token) return null
  const timeoutRaw = rawBody.bridgeRemoteTimeoutMs ?? rawBody.bridge_remote_timeout_ms ?? nested.timeoutMs ?? nested.timeout_ms
  const timeoutMs = typeof timeoutRaw === 'number'
    ? timeoutRaw
    : typeof timeoutRaw === 'string'
      ? Number.parseInt(timeoutRaw, 10)
      : fromEnv?.timeoutMs
  return {
    baseUrl,
    token,
    orgUuid: stringOr(rawBody.bridgeRemoteOrgUuid ?? rawBody.bridge_remote_org_uuid ?? nested.orgUuid ?? nested.org_uuid, '') || fromEnv?.orgUuid,
    betaHeader: typeof rawBody.bridgeRemoteBetaHeader === 'string'
      ? rawBody.bridgeRemoteBetaHeader
      : typeof rawBody.bridge_remote_beta_header === 'string'
        ? rawBody.bridge_remote_beta_header
        : typeof nested.betaHeader === 'string'
          ? nested.betaHeader
          : typeof nested.beta_header === 'string'
            ? nested.beta_header
            : fromEnv?.betaHeader,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  }
}

function fallbackEventRecord(event: SessionStreamEvent): SessionEventRecord {
  return { seq: 0, ts: new Date().toISOString(), event }
}

function supportContext(rawBody: Record<string, unknown>): string {
  const blocks: string[] = []
  const selectedFiles = stringArray(rawBody.selected_files ?? rawBody.selectedFiles)
  if (selectedFiles.length > 0) {
    blocks.push(`<selected_files>\n${selectedFiles.map(file => `- ${file}`).join('\n')}\n</selected_files>`)
  }
  const goal = stringOr(rawBody.goal, '')
  if (goal) {
    blocks.push(`<user_goal>\n${goal}\n</user_goal>`)
  }
  if (rawBody.deep_thinking === true || rawBody.deepThinking === true) {
    blocks.push('用户打开了深度思考。遇到多步骤任务时，先简短拆解，再动手执行；不要只给建议。')
  }
  return blocks.length > 0 ? blocks.join('\n\n') : ''
}

function workspaceFromBody(rawBody: Record<string, unknown>): Workspace {
  return new Workspace(stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, process.cwd()), {
    allowedPaths: stringArray(rawBody.selected_files ?? rawBody.selectedFiles),
    fullDiskAccess: rawBody.full_disk_access === true || rawBody.fullDiskAccess === true,
  })
}

function messagingSocketPathFrom(rawBody: Record<string, unknown>, env: Record<string, string | undefined>): string {
  return stringOr(
    rawBody.messagingSocketPath ?? rawBody.messaging_socket_path ?? rawBody.udsMessagingSocketPath ?? rawBody.uds_messaging_socket_path,
    '',
  ) || stringOr(env.CLAUDE_CODE_MESSAGING_SOCKET, '')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function mcpSamplingContentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(mcpSamplingContentText).filter(Boolean).join('\n')
  if (!content || typeof content !== 'object') return stringifyForPrompt(content)
  const block = content as Record<string, unknown>
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'image') return `[image mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'audio') return `[audio mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    return `<mcp_sampling_tool_use name="${name}">\n${stringifyForPrompt(block.input)}\n</mcp_sampling_tool_use>`
  }
  if (block.type === 'tool_result') {
    const id = typeof block.toolUseId === 'string' ? block.toolUseId : ''
    return `<mcp_sampling_tool_result id="${id}">\n${mcpSamplingContentText(block.content)}\n</mcp_sampling_tool_result>`
  }
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>
    if (typeof resource.text === 'string') return resource.text
    if (typeof resource.uri === 'string') return `[resource uri=${resource.uri}]`
  }
  if (typeof block.uri === 'string') return `[resource_link uri=${block.uri}]`
  return stringifyForPrompt(block)
}

function mcpSamplingMessages(messages: McpSamplingHandlerInput['params']['messages']): Message[] {
  return messages.map(message => ({
    role: message.role,
    content: [textBlock(mcpSamplingContentText(message.content))],
  }))
}

async function runMcpSampling(model: Model, modelName: string, params: McpSamplingHandlerInput['params'], signal?: AbortSignal) {
  const step = await model.step({
    system: params.systemPrompt,
    messages: mcpSamplingMessages(params.messages),
    tools: [],
    signal,
  })
  const text = step.kind === 'final'
    ? step.text
    : [
        step.text,
        step.calls.length > 0 ? `MCP sampling requested tool use, but this Agent only allows tool execution through the main permission gate: ${step.calls.map(call => call.name).join(', ')}` : '',
      ].filter(Boolean).join('\n\n')
  return {
    model: modelName || 'agent-model',
    role: 'assistant' as const,
    content: { type: 'text' as const, text },
    stopReason: step.kind === 'tool_calls' ? 'toolUse' as const : 'endTurn' as const,
  }
}

const MCP_ELICITATION_TIMEOUT_MS = 120000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function schemaProperties(params: McpElicitationHandlerInput['params']): Record<string, unknown> {
  if (params.mode === 'url') return {}
  const schema = params.requestedSchema
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
}

function schemaRequired(params: McpElicitationHandlerInput['params']): string[] {
  if (params.mode === 'url') return []
  const schema = params.requestedSchema
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
}

function primitiveDefault(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

function defaultsForSchema(params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, prop] of Object.entries(schemaProperties(params))) {
    if (!isRecord(prop) || !Object.prototype.hasOwnProperty.call(prop, 'default')) continue
    const value = primitiveDefault(prop.default)
    if (value !== undefined) content[key] = value
  }
  return content
}

function coerceElicitationValue(raw: unknown, propSchema: unknown): string | number | boolean | string[] | undefined {
  const schema = isRecord(propSchema) ? propSchema : {}
  const type = schema.type
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') {
      const text = raw.trim().toLowerCase()
      if (['true', 'yes', 'y', '1', '允许', '是', '对'].includes(text)) return true
      if (['false', 'no', 'n', '0', '取消', '否', '不'].includes(text)) return false
    }
    return undefined
  }
  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
    if (!Number.isFinite(n)) return undefined
    return type === 'integer' ? Math.trunc(n) : n
  }
  if (type === 'array') {
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw
    if (typeof raw === 'string') return raw.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
    return undefined
  }
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return undefined
  return String(raw)
}

function parseKeyValueAnswer(answer: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of answer.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=：]+)\s*[:=：]\s*(.+?)\s*$/)
    if (match) out[match[1]!.trim()] = match[2]!.trim()
  }
  return out
}

function parseMcpFormAnswer(answer: string, params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> | null {
  if (params.mode === 'url') return null
  const properties = schemaProperties(params)
  const required = schemaRequired(params)
  const merged: Record<string, unknown> = { ...defaultsForSchema(params) }
  const trimmed = answer.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = parseKeyValueAnswer(trimmed)
  }
  if (isRecord(parsed) && Object.keys(parsed).length > 0) {
    Object.assign(merged, parsed)
  } else {
    const missing = required.filter(key => merged[key] === undefined)
    if (missing.length === 1) merged[missing[0]!] = trimmed
  }

  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, raw] of Object.entries(merged)) {
    const prop = properties[key]
    if (!prop) continue
    const value = coerceElicitationValue(raw, prop)
    if (value !== undefined) content[key] = value
  }
  if (required.some(key => content[key] === undefined)) return null
  return content
}

function mcpSchemaFieldLines(params: McpElicitationHandlerInput['params']): string[] {
  const required = new Set(schemaRequired(params))
  return Object.entries(schemaProperties(params)).map(([key, prop]) => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? ` - ${schema.description}` : ''
    const type = typeof schema.type === 'string' ? schema.type : 'value'
    const requiredMark = required.has(key) ? '必填' : '可选'
    const def = Object.prototype.hasOwnProperty.call(schema, 'default') ? `, 默认 ${stringifyForPrompt(schema.default)}` : ''
    return `- ${key} (${title}, ${type}, ${requiredMark}${def})${description}`
  })
}

function mcpSchemaFields(params: McpElicitationHandlerInput['params']): AskQuestionField[] | undefined {
  if (params.mode === 'url') return undefined
  const required = new Set(schemaRequired(params))
  const fields = Object.entries(schemaProperties(params)).map(([key, prop]): AskQuestionField => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? schema.description : undefined
    const enumOptions = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const arrayItemSchema = isRecord(schema.items) ? schema.items : {}
    const arrayOptions = Array.isArray(arrayItemSchema.enum) ? arrayItemSchema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const type = schema.type === 'boolean'
      ? 'boolean'
      : schema.type === 'number' || schema.type === 'integer'
        ? 'number'
        : schema.type === 'array'
          ? arrayOptions?.length ? 'multiselect' : 'textarea'
          : enumOptions?.length ? 'select' : 'text'
    return {
      name: key,
      label: title,
      type,
      required: required.has(key),
      ...(description ? { description } : {}),
      ...(primitiveDefault(schema.default) !== undefined ? { defaultValue: primitiveDefault(schema.default) } : {}),
      ...((enumOptions?.length || arrayOptions?.length) ? { options: (enumOptions ?? arrayOptions)!.slice(0, 30) } : {}),
      ...(schema.type === 'array' && !arrayOptions?.length ? { placeholder: '每行一个值' } : {}),
    }
  })
  return fields.length > 0 ? fields : undefined
}

function isDeclineAnswer(answer: string): boolean {
  return ['取消', '拒绝', '不允许', 'decline', 'cancel', 'no', '否'].includes(answer.trim().toLowerCase())
}

async function waitForInboxAnswer(inbox: string[], startLen: number, signal?: AbortSignal, timeoutMs = MCP_ELICITATION_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    if (inbox.length > startLen) {
      const [answer] = inbox.splice(startLen, 1)
      return typeof answer === 'string' ? answer : null
    }
    await delay(100)
  }
  return null
}

function wsSend(ws: { send(data: string): unknown }, data: unknown): void {
  try {
    ws.send(JSON.stringify(data))
  } catch {
    // WebSocket 可能已经断开;turn 继续跑并落 event log,下次连接 replay。
  }
}

function wsError(ws: { send(data: string): unknown }, message: string): void {
  wsSend(ws, { type: 'error', error: message })
}

function backgroundTaskNotification(task: TaskMeta): Record<string, unknown> | null {
  if (task.kind !== 'background_agent') return null
  const title = task.status === 'completed'
    ? '后台子代理已完成'
    : task.status === 'failed'
      ? '后台子代理失败'
      : task.status === 'cancelled'
        ? '后台子代理已取消'
        : null
  if (!title) return null
  return {
    title,
    body: task.error ? `${task.title}: ${task.error}` : task.title,
    kind: 'background_task',
    meta: {
      taskId: task.id,
      status: task.status,
      title: task.title,
      conversationId: task.conversationId,
      workspaceRoot: task.workspaceRoot,
      agent: typeof task.params?.agent === 'string' ? task.params.agent : undefined,
    },
  }
}

/** W2/W6 后端。/health + /agent/hello(demo) + /agent/run(真实模型 Agent SSE)。 */
export function startServer(opts: StartServerOptions = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8850
  const stateRoot = opts.transcriptRoot ?? join(process.cwd(), '.agent-state')
  const sessions = new SessionService(stateRoot)
  const providers = new ProviderService(opts.providerRoot ?? stateRoot)
  const desktopData = new DesktopDataStore(stateRoot)
  const tasks = new TaskService(stateRoot, {
    onSettled: async task => {
      const notification = backgroundTaskNotification(task)
      if (notification) await desktopData.addNotification(notification)
    },
  })
  const taskLists = new TaskListService(join(stateRoot, 'task-lists'))
  const teams = new TeamService(stateRoot)
  const udsPeers = new UdsPeerRegistry(stateRoot)
  const bridgePeers = new BridgePeerRegistry(stateRoot)
  const bridgeRemote = new BridgeRemoteState(stateRoot)
  const media = new MediaJobService({
    tasks,
    stateRoot,
    backendUrl: opts.mediaBackendUrl ?? resolveMediaBackendUrl(opts.env ?? process.env),
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
    pollIntervalMs: 100,
    prepareImageBody: (body, mode) => prepareStudioImageBody(body, mode),
  })
  const videoEdits = new VideoEditProjectStore(stateRoot)
  const legacyStore = new LegacyAgentStore(stateRoot)
  const storeDocs = new StoreDocsService(desktopData, stateRoot)
  const turns = new TurnRegistry()
  const steerInboxes = new Map<string, string[]>()
  const providerHealth = new ProviderHealthStore(opts.providerRoot ?? stateRoot)

  function registerProviderFailure(runtime: RuntimeProviderResolution, err: unknown): void {
    const key = runtimeProviderKey(runtime)
    providerHealth.recordFailure(key, runtimeProviderLabel(runtime), sanitizeProviderError(err))
  }

  function registerProviderSuccess(runtime: RuntimeProviderResolution): void {
    providerHealth.recordSuccess(runtimeProviderKey(runtime))
  }

  function orderRuntimeProvidersForAttempt(runtimes: RuntimeProviderResolution[]): { runtimes: RuntimeProviderResolution[]; notices: string[] } {
    const now = Date.now()
    const healthy: RuntimeProviderResolution[] = []
    const cooling: Array<{ runtime: RuntimeProviderResolution; health: ProviderHealthEntry }> = []
    for (const runtime of runtimes) {
      const key = runtimeProviderKey(runtime)
      const health = providerHealth.get(key, now)
      if (health) {
        cooling.push({ runtime, health })
      } else {
        healthy.push(runtime)
      }
    }
    if (healthy.length === 0 || cooling.length === 0) return { runtimes, notices: [] }
    const firstHealthy = healthy[0]!
    const notices = cooling
      .filter(item => item.runtime === runtimes[0])
      .map(item => `模型出口「${item.health.label}」最近失败:${item.health.lastError}；本轮先尝试「${runtimeProviderLabel(firstHealthy)}」。`)
    return { runtimes: [...healthy, ...cooling.map(item => item.runtime)], notices }
  }

  const providerHealthCallbacks = {
    onFailure: registerProviderFailure,
    onSuccess: registerProviderSuccess,
  }

  async function resolveTaskEndpointTarget(id: string, statuses?: TaskStatus[]): Promise<{ task: TaskMeta | null; requestedTaskId: string }> {
    const resolution = await tasks.resolveBackgroundAgentTarget(id, {
      ...(statuses ? { statuses } : {}),
    })
    if (resolution.task) return { task: resolution.task, requestedTaskId: id }
    return { task: await tasks.get(id), requestedTaskId: id }
  }

  function taskAliasPayload(task: TaskMeta, requestedTaskId: string): Record<string, string> {
    const agentId = typeof task.params?.agent_id === 'string' && task.params.agent_id.trim()
      ? task.params.agent_id.trim()
      : ''
    return {
      ...(agentId ? { agentId } : {}),
      ...(requestedTaskId !== task.id ? { requestedTaskId, resolvedTaskId: task.id } : {}),
    }
  }

  function runtimeProviderHealthStatus(runtime: RuntimeProviderResolution, now = Date.now()) {
    const key = runtimeProviderKey(runtime)
    const health = providerHealth.get(key, now)
    if (!health) {
      return {
        source: runtime.source,
        providerId: runtime.providerId,
        providerName: runtime.providerName,
        label: runtimeProviderLabel(runtime),
        model: runtime.config.model,
        state: 'ready',
        failureCount: 0,
        cooldownMsRemaining: 0,
      }
    }
    return {
      source: runtime.source,
      providerId: runtime.providerId,
      providerName: runtime.providerName,
      label: health.label,
      model: runtime.config.model,
      state: 'cooling',
      failureCount: health.failureCount,
      cooldownMsRemaining: Math.max(0, health.cooldownUntil - now),
      lastError: health.lastError,
      failureCategory: health.failureCategory,
    }
  }

  async function syncLegacyByokTextProvider(input: Record<string, unknown>, saved: Record<string, unknown>): Promise<void> {
    const existing = await providers.get(LEGACY_BYOK_TEXT_PROVIDER_ID).catch(() => null)
    if (input.enabled !== true) {
      const list = await providers.list()
      if (existing && list.activeId === LEGACY_BYOK_TEXT_PROVIDER_ID) await providers.clearActive()
      return
    }

    const baseUrl = stringOr(saved.base_url, '').trim()
    const model = stringOr(saved.model, '').trim()
    const apiKey = stringOr(input.api_key, '').trim()
    if (!baseUrl || !model) return

    const payload = {
      id: LEGACY_BYOK_TEXT_PROVIDER_ID,
      name: '自带文字模型',
      apiFormat: 'openai_chat',
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    }
    if (existing) await providers.update(LEGACY_BYOK_TEXT_PROVIDER_ID, payload)
    else {
      if (!apiKey) return
      await providers.create(payload)
    }
    await providers.activate(LEGACY_BYOK_TEXT_PROVIDER_ID)
  }

  async function currentModelStatus() {
    const [list, runtimes] = await Promise.all([
      providers.list(),
      providers.resolveRuntimeConfigs(opts.env ?? process.env),
    ])
    const ordered = orderRuntimeProvidersForAttempt(runtimes)
    const runtime = ordered.runtimes[0]
    const now = Date.now()
    const health = runtimes.map(item => runtimeProviderHealthStatus(item, now))
    return {
      ok: !!runtime,
      activeId: list.activeId,
      providers: list.providers,
      fallbackCount: Math.max(0, runtimes.length - 1),
      coolingCount: health.filter(item => item.state === 'cooling').length,
      health,
      healthHistory: providerHealth.listHistory(8),
      runtime: runtime
        ? {
            source: runtime.source,
            providerId: runtime.providerId,
            providerName: runtime.providerName,
            summary: runtime.summary,
          }
        : null,
    }
  }

  async function clearModelHealth(body: Record<string, unknown>) {
    const all = body.all === true
    const providerId = stringOr(body.providerId, '')
    const source = stringOr(body.source, '')

    if (!all && !providerId && !source) {
      throw new Error('providerId/source required')
    }

    const runtimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    const matched = all
      ? runtimes
      : runtimes.filter(runtime => (
          providerId ? runtime.providerId === providerId : runtime.source === source
        ))
    if (!all && matched.length === 0) throw new Error('provider runtime not found')

    const cleared = all
      ? providerHealth.clearAll()
      : providerHealth.clearAll(matched.map(runtimeProviderKey))
    return { ok: true, cleared, status: await currentModelStatus() }
  }

  async function handleMcpElicitation(
    input: McpElicitationHandlerInput,
    elicitOpts: { conversationId: string; taskId?: string; signal?: AbortSignal },
  ) {
    const fallback = await defaultElicitationHandler(input)
    if (fallback.action === 'accept') return fallback
    if (!elicitOpts.taskId) return fallback

    const task = await tasks.get(elicitOpts.taskId).catch(() => null)
    if (!task) return fallback

    const inbox = steerInboxes.get(elicitOpts.conversationId) ?? []
    steerInboxes.set(elicitOpts.conversationId, inbox)
    const requestId = `mcp_elicit_${crypto.randomUUID()}`
    const question = input.params.mode === 'url'
      ? [
          `MCP「${input.serverName}」需要你打开或确认一个链接。`,
          input.params.message,
          input.params.url,
        ].filter(Boolean).join('\n')
      : [
          `MCP「${input.serverName}」需要补充一组非敏感信息。`,
          input.params.message,
          '请直接在输入框回复 JSON，例如 {"字段":"值"}；只有一个必填字段时也可以直接回复值。',
          ...mcpSchemaFieldLines(input.params),
        ].filter(Boolean).join('\n')
    const options = input.params.mode === 'url'
      ? [
          { label: '允许', description: '允许 MCP 继续这个链接流程。' },
          { label: '取消', description: '拒绝这次 MCP 请求。' },
        ]
      : [{ label: '取消', description: '不向 MCP 提交信息。' }]
    await tasks.appendEvent(elicitOpts.taskId, {
      type: 'ask_question',
      id: requestId,
      question,
      options,
      allowFreeform: input.params.mode !== 'url',
      placeholder: input.params.mode !== 'url' ? '{"字段":"值"}' : undefined,
      fields: mcpSchemaFields(input.params),
      url: input.params.mode === 'url' ? input.params.url : undefined,
    }).catch(() => undefined)

    const answer = await waitForInboxAnswer(inbox, inbox.length, elicitOpts.signal)
    if (!answer) return { action: 'cancel' as const }
    if (isDeclineAnswer(answer)) return { action: 'decline' as const }
    if (input.params.mode === 'url') return { action: 'accept' as const }

    const content = parseMcpFormAnswer(answer, input.params)
    if (!content) {
      await tasks.appendEvent(elicitOpts.taskId, {
        type: 'context_note',
        text: 'MCP 表单回复没有匹配必填字段，已拒绝这次请求。',
      }).catch(() => undefined)
      return { action: 'decline' as const }
    }
    return { action: 'accept' as const, content }
  }

  async function createTurnStream(rawBody: Record<string, unknown>): Promise<{ conversationId: string; stream: AsyncGenerator<SessionEventRecord> }> {
    const rawUserMessage = stringOr(rawBody.message ?? rawBody.userMessage, '')
    if (!rawUserMessage) throw new TurnSetupError('message required', 400)

    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!

    const conversationId = stringOr(rawBody.conversationId, crypto.randomUUID())
    const workspace = workspaceForActiveWorktree(workspaceFromBody(rawBody), conversationId)
    const steerInbox = steerInboxes.get(conversationId) ?? []
    steerInboxes.set(conversationId, steerInbox)
    const explicitMessagingSocketPath = messagingSocketPathFrom(rawBody, opts.env ?? process.env)
    const messagingSocketPath = explicitMessagingSocketPath || udsPeers.defaultSocketPath(conversationId)
    let udsInbox: UdsInboxServer | undefined
    let udsPeer: UdsPeerRecord | undefined
    let udsInboxWarning = ''
    if (messagingSocketPath) {
      try {
        udsInbox = await startUdsInbox({ socketPath: messagingSocketPath, inbox: steerInbox })
        udsPeer = await udsPeers.register({
          socketPath: udsInbox.socketPath,
          conversationId,
          workspaceRoot: workspace.root,
          explicit: !!explicitMessagingSocketPath,
        })
      } catch (err) {
        udsInboxWarning = `UDS messaging socket failed to start:${err instanceof Error ? err.message : String(err)}`
      }
    }
    const transcript = sessions.transcript(conversationId)
    await sessions.touch(conversationId, {
      title: rawUserMessage.slice(0, 40),
      workspaceRoot: workspace.root,
      status: 'running',
    })
    let systemPrompt = await buildSystemPrompt(workspace)
    const outputStyles = await loadOutputStyles()
    const outputStylePrompt = renderOutputStylePrompt(outputStyles, stringOr(rawBody.output_style ?? rawBody.outputStyle, ''))
    const extraContext = [
      supportContext(rawBody),
      buildStoreMemoryContext(await desktopData.listMemories(), rawUserMessage, { workingDir: workspace.root }),
    ].filter(Boolean).join('\n\n')
    if (outputStylePrompt || extraContext) {
      systemPrompt = [systemPrompt, outputStylePrompt, extraContext].filter(Boolean).join('\n\n')
    }
    const model = createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)
    const requestedContextWindowTokens = numberFrom(rawBody.contextWindowTokens ?? rawBody.context_window_tokens, 0)
    const contextWindowTokens = requestedContextWindowTokens > 0
      ? requestedContextWindowTokens
      : getConfiguredOrBuiltInModelContextWindow(providerRuntime.config.model, opts.env ?? process.env)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const skills = await loadSkillsDir(skillsRoot)
    const enabledPacks = resolveEnabledPacks(rawBody)
    const commands = await loadCommandsForWorkspace(workspace.root, opts.commandsRoot ?? defaultCommandsRoot(), enabledPacks)
    const parsedCommand = parseCommandInvocation(rawUserMessage)
    const goalCommandResult = parsedCommand?.name === 'goal'
      ? await handleGoalCommand(conversationId, parsedCommand.args, transcript)
      : undefined
    const matchedCommand = parsedCommand && !goalCommandResult ? commands.byName.get(parsedCommand.name) : undefined
    const commandInvocation = parsedCommand && matchedCommand
      ? {
          name: matchedCommand.name,
          args: parsedCommand.args,
          raw: parsedCommand.raw,
          source: matchedCommand.source,
          contentLength: matchedCommand.contentLength,
          prompt: await matchedCommand.getPrompt(parsedCommand.args, { workspace }),
        }
      : parsedCommand && goalCommandResult
        ? {
            name: 'goal',
            args: parsedCommand.args,
            raw: parsedCommand.raw,
            source: 'commands' as const,
            contentLength: goalCommandResult.output.length,
            prompt: '',
          }
      : undefined
    const userMessage = goalCommandResult?.shouldQuery
      ? `Continue working until this goal is complete: ${parsedCommand?.args ?? ''}`
      : commandInvocation?.prompt ?? rawUserMessage
    const skillRecommendations = suggestedSkillNamesForPacks(enabledPacks)
    const domainPackTools = createDomainPackTools(enabledPacks)
    const configuredHooks = await loadHookRegistryFile(opts.hooksPath ?? defaultHooksPath())
    const transcriptMessagesForHooks = await transcript.load()
    const hooks = mergeHookRegistries(createDomainPackHookRegistry(enabledPacks), configuredHooks, createGoalHookRegistry(conversationId, transcriptMessagesForHooks))
    const agents = await loadAgentsDir(opts.agentsRoot ?? defaultAgentsRoot())
    const controller = turns.start(conversationId)
    const mcpConfigPath = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim()
      ? rawBody.mcpConfigPath.trim()
      : opts.mcpConfigPath ?? defaultMcpConfigPath(workspace.root, opts.env ?? process.env)
    const mcpTools = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspace.root,
      signal: controller.signal,
      timeoutMs: 10000,
      toolTimeoutMs: 120000,
      fetchImpl: opts.fetchImpl,
      elicitationHandler: input => handleMcpElicitation(input, {
        conversationId,
        taskId: typeof rawBody.taskId === 'string' ? rawBody.taskId : undefined,
        signal: controller.signal,
      }),
      samplingHandler: ({ params, signal }) => runMcpSampling(model, providerRuntime.config.model, params, signal ?? controller.signal),
    })
    const taskTools = [...createTaskTools(tasks), ...createStructuredTaskTools(taskLists)]
    let backgroundAgentOptions: BackgroundAgentTaskOptions | undefined
    const teamTools = createTeamTools(teams, {
      tasks,
      udsPeers,
      bridgePeers,
      sendBridgeMessage: bridgeSendMessageFor(rawBody),
      resumeBackgroundAgent: (task, message, toolCtx) => {
        if (!backgroundAgentOptions) throw new Error('background agent runner is not available')
        return resumeBackgroundAgentTask(backgroundAgentOptions, task, message, toolCtx)
      },
    })
    const mediaTools = createMediaTools(media)
    const storeDocTools = [createStoreDocsTool(storeDocs)]
    const backgroundBaseRegistry = buildGeneralRegistry({ skills, skillsRoot, skillRecommendations, commands, extraTools: [...domainPackTools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    const baseRegistry = buildGeneralRegistry({ skills, skillsRoot, skillRecommendations, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    backgroundAgentOptions = {
      tasks,
      agents,
      model,
      baseTools: backgroundBaseRegistry.list(),
      baseSystemPrompt: systemPrompt,
      hooks,
      mcp: {
        mcpConfigPath,
        loadOptions: ({ workspaceRoot, signal, taskId }) => ({
          cwd: workspaceRoot,
          signal,
          timeoutMs: 10000,
          toolTimeoutMs: 120000,
          fetchImpl: opts.fetchImpl,
          elicitationHandler: input => handleMcpElicitation(input, {
            conversationId,
            taskId,
            signal,
          }),
          samplingHandler: ({ params, signal: samplingSignal }) => runMcpSampling(model, providerRuntime.config.model, params, samplingSignal ?? signal ?? controller.signal),
        }),
      },
    }
    const agentSidechainRoot = join(stateRoot, 'agent-task-sidechains')
    const agentTools = agents.length > 0
      ? [createAgentTaskTool({
        agents,
        model,
        baseTools: backgroundAgentOptions.baseTools,
        baseSystemPrompt: systemPrompt,
        sidechainRoot: agentSidechainRoot,
        hooks,
        mcp: backgroundAgentOptions.mcp,
        startBackgroundAgent: (input, toolCtx) => startBackgroundAgentRun(backgroundAgentOptions!, input, toolCtx),
      })]
      : []
    const agentSidechainTools = agents.length > 0 ? createAgentTaskSidechainTools(agentSidechainRoot) : []
    const backgroundTools = agents.length > 0
      ? [createBackgroundAgentTaskTool(backgroundAgentOptions)]
      : []
    const registry = buildGeneralRegistry({ skills, skillsRoot, skillRecommendations, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools, ...agentTools, ...agentSidechainTools, ...backgroundTools] })
    const stream = (async function* (): AsyncGenerator<SessionEventRecord> {
      let finalStatus: SessionStatus = 'idle'
      const record = async (event: SessionStreamEvent): Promise<SessionEventRecord> => {
        if (!turns.isCurrent(conversationId, controller)) return fallbackEventRecord(event)
        try {
          return await sessions.appendEvent(conversationId, event)
        } catch {
          return fallbackEventRecord(event)
        }
      }
      try {
        if (commandInvocation && commandInvocation.source === 'commands') {
          yield await record({
            type: 'command_invocation',
            name: commandInvocation.name,
            args: commandInvocation.args,
            raw: commandInvocation.raw,
            source: 'commands',
            contentLength: commandInvocation.contentLength,
          })
        }
        if (goalCommandResult) {
          yield await record({ type: 'context_note', text: goalCommandResult.output })
          if (!goalCommandResult.shouldQuery) {
            yield await record({ type: 'final', text: goalCommandResult.output })
            finalStatus = 'idle'
            return
          }
        }
        for (const notice of orderedProviderRuntimes.notices) {
          yield await record({ type: 'context_note', text: notice })
        }
        for (const warning of mcpTools.warnings) {
          yield await record({ type: 'context_note', text: warning })
        }
        if (udsInboxWarning) {
          yield await record({ type: 'context_note', text: udsInboxWarning })
        }
        for await (const event of runAgentLoop({
          model,
          registry,
          workspace,
          systemPrompt,
          userMessage,
          transcript,
          conversationId,
          steerInbox,
          signal: controller.signal,
          permissionMode: permissionModeFrom(rawBody.permissionMode),
          contextWindowChars: typeof rawBody.contextWindowChars === 'number' ? rawBody.contextWindowChars : undefined,
          contextWindowTokens,
          toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
          hooks,
          teamInbox: { service: teams },
        })) {
          yield await record(event)
        }
      } catch (err) {
        finalStatus = controller.signal.aborted ? 'interrupted' : 'failed'
        const detail = controller.signal.aborted ? '任务已中断' : err instanceof Error ? err.message : String(err)
        yield await record({ type: 'context_note', text: `任务执行失败:${detail}` })
        yield await record({ type: 'final', text: `任务执行失败:${detail}` })
      } finally {
        if (udsPeer) await udsPeers.unregister(udsPeer.id).catch(() => undefined)
        await udsInbox?.close().catch(() => undefined)
        await closeMcpConnections(mcpTools.connections)
        const done = await record({ type: 'done' })
        const wasCurrent = turns.finish(conversationId, controller)
        if (wasCurrent) {
          steerInboxes.delete(conversationId)
          await sessions.touch(conversationId, { status: finalStatus })
        }
        yield done
      }
    })()
    return { conversationId, stream }
  }

  async function replayWsEvents(ws: { send(data: string): unknown }, conversationId: string, after: number): Promise<void> {
    const events = await sessions.loadEvents(conversationId, { after, limit: 1000 })
    for (const record of events) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event, replay: true })
  }

  async function handleWsRun(ws: { send(data: string): unknown; data: AgentWsData }, body: Record<string, unknown>): Promise<void> {
    try {
      const { conversationId, stream } = await createTurnStream({ ...body, conversationId: body.conversationId ?? ws.data.conversationId })
      ws.data.conversationId = conversationId
      for await (const record of stream) {
        wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
      }
    } catch (err) {
      wsError(ws, err instanceof Error ? err.message : String(err))
    }
  }

  function legacyEventPayload(taskId: string, conversationId: string | undefined, record: { seq: number; event: SessionStreamEvent | import('../tasks/taskService').TaskStreamEvent }): Record<string, unknown> | null {
    const event = record.event
    const base = { offset: record.seq, task_id: taskId }
    if (event.type === 'started') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'thinking') return { ...base, type: 'reasoning', content: event.text }
    if (event.type === 'command_invocation') return { ...base, type: 'context_note', content: `已展开命令 /${event.name}${event.args ? ` ${event.args}` : ''}` }
    if (event.type === 'tool_call') return { ...base, type: 'tool_call', tool: event.tool, args: event.input }
    if (event.type === 'tool_progress') return { ...base, type: 'tool_progress', tool: event.tool, id: event.id, chunk: event.chunk, stream: event.stream }
    if (event.type === 'tool_result') return { ...base, type: 'tool_result', tool: event.tool, content: event.output }
    if (event.type === 'usage_update') return { ...base, ...event }
    if (event.type === 'ask_question') return { ...base, ...event }
    if (event.type === 'approval_request') return { ...base, ...event, args: event.args }
    if (event.type === 'steering') return { ...base, type: 'steering', content: event.content }
    if (event.type === 'todo_update') return { ...base, type: 'todo_update', content: event.content }
    if (event.type === 'context_note') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'final') return { ...base, type: 'final', content: event.text }
    if (event.type === 'done') return { ...base, type: 'done', stopped_reason: 'stop', conversation_id: conversationId, task_id: taskId, offset: record.seq }
    return null
  }

  async function* legacyTaskEventStream(requestedTaskId: string, after: number): AsyncGenerator<string> {
    let cursor = Math.max(0, after)
    for (let tick = 0; tick < 3000; tick++) {
      const resolved = await resolveTaskEndpointTarget(requestedTaskId)
      const requestedId = resolved.requestedTaskId
      const taskId = resolved.task?.id ?? requestedTaskId
      const task = resolved.task ?? await tasks.get(taskId)
      if (!task) {
        yield legacySseLine({ type: 'error', error: 'task not found', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        yield legacySseLine({ type: 'done', stopped_reason: 'error', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        return
      }
      const events = await tasks.loadEvents(taskId, { after: cursor, limit: 100 })
      for (const record of events) {
        cursor = Math.max(cursor, record.seq)
        const payload = legacyEventPayload(taskId, task.conversationId, record)
        if (payload) {
          yield legacySseLine({
            ...payload,
            ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          })
        }
        if (record.event.type === 'done') return
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        yield legacySseLine({
          type: 'done',
          stopped_reason: task.status === 'failed' ? 'error' : task.status === 'cancelled' ? 'cancelled' : 'stop',
          conversation_id: task.conversationId,
          task_id: taskId,
          ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
          ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          offset: cursor,
        })
        return
      }
      await delay(100)
    }
    yield legacySseLine({ type: 'error', error: 'task event stream timeout', task_id: requestedTaskId, offset: cursor })
  }

  async function startLegacyAgentTask(rawBody: Record<string, unknown>): Promise<{ task_id: string; status: string }> {
    const message = stringOr(rawBody.message, '')
    if (!message) throw new TurnSetupError('message required', 400)
    const workspaceRoot = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, process.cwd())
    const conversationId = stringOr(rawBody.conversation_id ?? rawBody.conversationId, crypto.randomUUID())
    const task = await tasks.create({
      title: message.slice(0, 80),
      conversationId,
      workspaceRoot,
    })
    tasks.start(task.id, async taskCtx => {
      let finalText = ''
      const { stream } = await createTurnStream({
        ...rawBody,
        taskId: task.id,
        message,
        conversationId,
        workspaceRoot,
        permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
      })
      for await (const record of stream) {
        if (taskCtx.signal.aborted) break
        if (record.event.type === 'final') finalText = record.event.text
        await taskCtx.emit(record.event)
      }
      return finalText
    })
    return { task_id: task.id, status: 'running' }
  }

  async function archiveSession(id: string, rawBody: Record<string, unknown>) {
    const session = await sessions.get(id)
    if (!session) throw new TurnSetupError('session not found', 404)
    if (session.status === 'running') throw new TurnSetupError('session is running', 409)
    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const providerRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes).runtimes
    const providerRuntime = providerRuntimes[0]!

    const transcript = sessions.transcript(id)
    const messages = await transcript.load()
    const keepRecentMessages = Math.max(1, Math.min(100, numberFrom(rawBody.keepRecentMessages ?? rawBody.keep_recent_messages, 12)))
    const minOldMessages = Math.max(1, Math.min(20, numberFrom(rawBody.minOldMessages ?? rawBody.min_old_messages, 1)))
    const model = createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)
    const compacted = await compactPipeline({
      messages,
      model,
      force: true,
      keepRecentMessages,
      minOldMessages,
      readOnlyToolNames: new Set(),
    })
    if (!compacted.didCompact) {
      return { ok: false, archived: false, reason: 'not enough transcript messages to archive', messages: messages.length }
    }

    const archiveDir = join(stateRoot, 'transcript-archives')
    await mkdir(archiveDir, { recursive: true })
    const archivePath = join(archiveDir, `${id}-${Date.now()}.jsonl`)
    await copyFile(transcript.path, archivePath)
    await transcript.save(compacted.messages)
    await sessions.touch(id, { status: 'idle' })
    return {
      ok: true,
      archived: true,
      archivePath,
      beforeMessages: messages.length,
      afterMessages: compacted.messages.length,
      note: compacted.note,
    }
  }

  async function prewarm(rawBody: Record<string, unknown>) {
    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!
    createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)

    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const hooksPath = opts.hooksPath ?? defaultHooksPath()
    const agentsRoot = opts.agentsRoot ?? defaultAgentsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const [skills, commands, hooks, agents] = await Promise.all([
      loadSkillsDir(skillsRoot),
      loadCommandsForWorkspace(workspace.root, commandsRoot, enabledPacks),
      loadHookRegistryFile(hooksPath),
      loadAgentsDir(agentsRoot),
    ])

    const includeMcp = rawBody.includeMcp === true || rawBody.includeMcp === 'true'
    let mcp: { tools: number; warnings: string[] } | undefined
    if (includeMcp) {
      const mcpConfigPath = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim()
        ? rawBody.mcpConfigPath.trim()
        : opts.mcpConfigPath ?? defaultMcpConfigPath(workspace.root, opts.env ?? process.env)
      const loaded = await loadMcpToolsFromFile(mcpConfigPath, {
        cwd: workspace.root,
        timeoutMs: 5000,
        toolTimeoutMs: 120000,
        fetchImpl: opts.fetchImpl,
      })
      mcp = { tools: loaded.tools.length, warnings: loaded.warnings }
      await closeMcpConnections(loaded.connections)
    }

    const conversationId = typeof rawBody.conversationId === 'string' && rawBody.conversationId.trim() ? rawBody.conversationId.trim() : undefined
    if (conversationId) {
      await sessions.touch(conversationId, {
        workspaceRoot: workspace.root,
        status: 'idle',
      })
    }

    return {
      ok: true,
      provider: {
        source: providerRuntime.source,
        providerId: providerRuntime.providerId,
        providerName: providerRuntime.providerName,
        summary: providerRuntime.summary,
      },
      fallbackCount: Math.max(0, resolvedProviderRuntimes.length - 1),
      ...(orderedProviderRuntimes.notices.length ? { notices: orderedProviderRuntimes.notices } : {}),
      workspaceRoot: workspace.root,
      skills: { root: skillsRoot, count: skills.skills.length },
      commands: { root: commandsRoot, count: commands.commands.length },
      domainTools: { count: createDomainPackTools(enabledPacks).length },
      hooks: { path: hooksPath, count: hooks?.rules.length ?? 0 },
      agents: { root: agentsRoot, count: agents.length },
      ...(mcp ? { mcp } : {}),
    }
  }

  function bridgeSendMessageFor(rawBody: Record<string, unknown>) {
    const config = bridgeRemoteConfigFromBody(rawBody, opts.env ?? process.env)
    if (!config) return undefined
    const transport = createBridgeRemoteTransport({ ...config, fetchImpl: opts.fetchImpl })
    return async (sessionId: string, message: string) => {
      const result = await transport.sendUserMessage(sessionId, message)
      return {
        ok: result.ok,
        error: result.error ?? (result.status ? `Remote Control event POST failed ${result.status}` : undefined),
      }
    }
  }

  async function buildExecutionRegistry(rawBody: Record<string, unknown>) {
    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const domainPackTools = createDomainPackTools(enabledPacks)
    const [skills, commands] = await Promise.all([
      loadSkillsDir(skillsRoot),
      loadCommandsForWorkspace(workspace.root, commandsRoot, enabledPacks),
    ])
    const mcpConfigPath = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim()
      ? rawBody.mcpConfigPath.trim()
      : opts.mcpConfigPath ?? defaultMcpConfigPath(workspace.root, opts.env ?? process.env)
    const mcpTools = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspace.root,
      timeoutMs: 10000,
      toolTimeoutMs: 120000,
      fetchImpl: opts.fetchImpl,
    })
    const registry = buildGeneralRegistry({
      skills,
      skillsRoot,
      skillRecommendations: suggestedSkillNamesForPacks(enabledPacks),
      commands,
      extraTools: [...domainPackTools, ...mcpTools.tools, ...createTaskTools(tasks), ...createStructuredTaskTools(taskLists), ...createTeamTools(teams, { tasks, udsPeers, bridgePeers, sendBridgeMessage: bridgeSendMessageFor(rawBody) }), ...createMediaTools(media), createStoreDocsTool(storeDocs)],
    })
    return { workspace, registry, connections: mcpTools.connections }
  }

  async function executeLegacyAgentTool(body: Record<string, unknown>) {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return jsonDetailError('tool required', 400)
    const tool = body.tool.trim()
    const args = body.args ?? {}
    const approvalArgs = isRecord(body.approval_args) ? body.approval_args : isRecord(body.approvalArgs) ? body.approvalArgs : args
    const token = typeof body.token === 'string' ? body.token : undefined
    const conversationId = stringOr(body.conversation_id ?? body.conversationId, '')
    const built = await buildExecutionRegistry(body)
    try {
      const result = await executeApproved(built.registry, tool, args, token, {
        workspace: built.workspace,
        conversationId: conversationId || undefined,
        permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
        toolResultStoreDir: conversationId ? join(stateRoot, 'tool-results', conversationId) : undefined,
      }, body.remember_approval === true || body.rememberApproval === true, approvalArgs)
      return Response.json({
        tool,
        result: result.output,
        ok: result.ok,
        continuation: '',
        approval: null,
      })
    } finally {
      await closeMcpConnections(built.connections)
    }
  }

  async function rejectLegacyAgentTool(body: Record<string, unknown>) {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return jsonDetailError('tool required', 400)
    const workspace = workspaceFromBody(body)
    handleReject(body.tool.trim(), body.args ?? {}, {
      workspace,
      conversationId: stringOr(body.conversation_id ?? body.conversationId, '') || undefined,
      permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
    })
    return Response.json({ ok: true })
  }

  async function legacyConversations() {
    const deleted = await legacyStore.deletedConversationIds()
    const rows = await sessions.list()
    return {
      conversations: rows
        .filter(session => !deleted.has(session.id))
        .map(session => ({
          conversation_id: session.id,
          title: session.title || '新对话',
          last_at: session.updatedAt,
        })),
    }
  }

  async function legacyConversationMessages(id: string) {
    const session = await sessions.get(id).catch(() => null)
    if (!session) return { conversation_id: id, messages: [] }
    const messages = await sessions.loadTranscript(id)
    return {
      conversation_id: id,
      messages: messages
        .map(message => ({ role: message.role, content: messageText(message) }))
        .filter(message => message.content),
    }
  }

  async function deletedConversationArtifacts(limit: number): Promise<LegacyArtifact[]> {
    const deleted = await legacyStore.listDeletedConversations()
    const out: LegacyArtifact[] = []
    for (const record of deleted) {
      const session = await sessions.get(record.id).catch(() => null)
      out.push({
        id: record.id,
        kind: 'task',
        type: 'agent_conversation',
        title: session?.title || '已删除会话',
        subtitle: 'AI 对话',
        content: null,
        url: null,
        conversation_id: record.id,
        created_at: record.deleted_at,
      })
      if (out.length >= limit) break
    }
    return out
  }

  async function fileDiffFromQuery(url: URL): Promise<Response> {
    const requested = url.searchParams.get('path') || ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    const target = resolve(requested)
    if (isSensitiveFilePath(target)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const backupParam = url.searchParams.get('backup_path') || url.searchParams.get('backupPath') || ''
    const backup = backupParam ? resolve(backupParam) : ''
    if (backup && isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '备份文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const [oldText, newText] = await Promise.all([
      backup ? readTextIfExists(backup) : Promise.resolve(''),
      readTextIfExists(target),
    ])
    return Response.json({ ok: true, path: target, backup_path: backup || null, old: oldText, new: newText })
  }

  async function restoreFileFromBackup(body: Record<string, unknown>): Promise<Response> {
    const requested = typeof body.path === 'string' ? body.path : ''
    const backupRequested = typeof body.backup_path === 'string'
      ? body.backup_path
      : typeof body.backupPath === 'string'
        ? body.backupPath
        : ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    if (!backupRequested.trim()) return Response.json({ ok: false, error: 'backup_path required' }, { status: 400 })
    const target = resolve(requested)
    const backup = resolve(backupRequested)
    if (isSensitiveFilePath(target) || isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    if (!existsSync(backup)) return Response.json({ ok: false, path: target, backup_path: backup, error: '备份文件不存在' })
    const currentBackupPath = join(dirname(target), '.restore-backups', `${basename(target)}.${Date.now()}.bak`)
    await mkdir(dirname(currentBackupPath), { recursive: true })
    if (existsSync(target)) await copyFile(target, currentBackupPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(backup, target)
    return Response.json({ ok: true, path: target, backup_path: backup, current_backup_path: existsSync(currentBackupPath) ? currentBackupPath : undefined })
  }

  async function legacyChatResponse(rawBody: Record<string, unknown>): Promise<Response> {
    const { conversationId, stream } = await createTurnStream({
      ...rawBody,
      conversationId: rawBody.conversation_id ?? rawBody.conversationId,
      permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
    })
    const bodyStream = (async function* () {
      for await (const record of stream) {
        const payload = legacyEventPayload(conversationId, conversationId, record)
        if (payload) yield legacySseLine(payload)
      }
    })()
    return new Response(bodyStream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  function dailyDraftPayload() {
    return {
      drafts: [
        {
          title: '今晚黄金档朋友圈',
          category: 'content',
          prompt_key: 'billiards_evening_peak',
          content: '今晚桌台状态在线，适合约一局放松一下。到店可问前台拿今日空桌安排，三五好友开台更划算。',
        },
        {
          title: '新客体验短文案',
          category: 'content',
          prompt_key: 'billiards_new_guest',
          content: '第一次来不用担心不会打，店里可以帮你安排合适桌型和基础指引。想练球、聚会、放松都可以直接来。',
        },
        {
          title: '助教课转化文案',
          category: 'content',
          prompt_key: 'billiards_coach',
          content: '想把准度和走位练稳定，可以约一节助教体验。先看动作问题，再给你一套能自己练的短计划。',
        },
      ],
      cached: false,
    }
  }

  async function saveUpload(req: Request, kind: 'logo' | 'qrcode') {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return jsonDetailError('file required', 400)
    const ext = extname(file.name || '') || '.bin'
    const rel = `/uploads/local/${kind}-${Date.now()}${ext}`
    const abs = join(stateRoot, 'uploads', 'local', basename(rel))
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, Buffer.from(await file.arrayBuffer()))
    const qrcodeContent = kind === 'qrcode' ? optionalString(form?.get('content')) : null
    const extra = qrcodeContent ? { qrcode_text: qrcodeContent } : {}
    await desktopData.updateStore({ [`${kind}_url`]: rel, ...extra })
    return Response.json({ url: rel })
  }

  async function serveLocalUpload(pathname: string): Promise<Response | null> {
    if (!pathname.startsWith('/uploads/local/')) return null
    const abs = join(stateRoot, 'uploads', 'local', basename(pathname))
    if (!existsSync(abs)) return null
    return new Response(await readFile(abs))
  }

  interface StudioBrandAsset {
    role: 'logo' | 'qrcode' | 'brand'
    url: string
  }

  function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of values) {
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  }

  function existingUploadUrl(value: unknown): string | null {
    const raw = optionalString(value)
    if (!raw || !raw.startsWith('/uploads/')) return null
    if (raw.includes('\0')) return null
    const rel = raw.slice('/uploads/'.length)
    if (!rel || rel.split(/[\\/]/).some(segment => segment === '..')) return null
    const uploadsRoot = resolve(stateRoot, 'uploads')
    const abs = resolve(uploadsRoot, rel)
    if (abs !== uploadsRoot && !abs.startsWith(`${uploadsRoot}/`) && !abs.startsWith(`${uploadsRoot}\\`)) return null
    return existsSync(abs) ? raw : null
  }

  function brandStyleText(value: unknown): string | undefined {
    const raw = optionalString(value)
    if (!raw) return undefined
    const labels: Record<string, string> = {
      lively: '热闹活力',
      professional: '专业可信',
      youthful: '年轻潮流',
      premium: '高端质感',
      minimal: '简约干净',
      luxury: '高档大气',
      sporty: '活力运动',
    }
    return labels[raw] ? `${labels[raw]}(${raw})` : raw
  }

  function storeBrandAssets(store: Record<string, unknown>): StudioBrandAsset[] {
    const assets: StudioBrandAsset[] = []
    const logo = existingUploadUrl(store.logo_url)
    const qrcode = existingUploadUrl(store.qrcode_url)
    if (logo) assets.push({ role: 'logo', url: logo })
    if (qrcode) assets.push({ role: 'qrcode', url: qrcode })
    for (const url of stringArray(store.brand_reference_images).map(existingUploadUrl).filter((item): item is string => !!item).slice(0, 4)) {
      assets.push({ role: 'brand', url })
    }
    return assets
  }

  function storeBrandSuffix(store: Record<string, unknown>, assets: StudioBrandAsset[], body: Record<string, unknown>, mode: 'generate' | 'edit'): string {
    const lines: string[] = []
    const explicitStoreInfo = body.add_store_info === true
    const storeName = optionalString(store.name)
    const city = optionalString(store.city)
    const district = optionalString(store.district)
    const location = [city, district].filter(Boolean).join('')
    const brandStyle = brandStyleText(store.brand_style ?? store.style)
    const brandColor = optionalString(store.brand_color)
    const hasCustomName = !!storeName && storeName !== '我的台球房'
    const hasLogo = assets.some(asset => asset.role === 'logo')
    const hasQrAsset = assets.some(asset => asset.role === 'qrcode')
    const hasQrContent = !!optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const hasQr = hasQrAsset || hasQrContent
    const hasBrandRefs = assets.some(asset => asset.role === 'brand')
    const hasContext = explicitStoreInfo || hasCustomName || !!location || !!brandStyle || !!brandColor || assets.length > 0
    if (!hasContext) return ''

    if ((explicitStoreInfo || hasCustomName) && storeName) lines.push(`门店名称:${storeName}`)
    if (location) lines.push(`门店位置:${location}`)
    if (brandStyle) lines.push(`品牌风格:${brandStyle}`)
    if (brandColor) lines.push(`品牌主色调呼应 ${brandColor}，背景和点缀色协调即可，不要求整图都是这个颜色。`)
    if (hasLogo) lines.push('已附带门店 Logo 作为输入图，可自然融入画面或留出安全位置；不要扭曲、改字或把它当成装饰纹理。')
    if (hasQr) {
      const printNote = body.print_mode === true
        ? '这张图用于印刷/线下投放，二维码必须保持方正、清晰、可扫描，并留出足够静区。'
        : '二维码可作为行动入口自然出现，但必须保持方正、清晰、可扫描，不要重绘成花纹。'
      lines.push(`已附带门店二维码作为输入图，${printNote}`)
    }
    if (hasBrandRefs) lines.push('已附带品牌参考图，只提取品牌质感和配色，不要照搬无关内容。')
    if (mode === 'edit' && assets.length > 0) {
      lines.push('改图时第一张输入图是需要保留血缘的源图，门店素材只作为品牌融合参考。')
    } else if (assets.length > 0) {
      lines.push('输入素材用于品牌约束和版式参考，不要让参考图里的无关背景抢占主画面。')
    }
    return lines.length ? `门店品牌约束:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : ''
  }

  async function prepareStudioImageBody(rawBody: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    if (rawBody._store_brand_pack_applied === true) return rawBody
    const store: Record<string, unknown> = await desktopData.getStore().catch(() => ({}))
    const assets = storeBrandAssets(store)
    const brandReferencePaths = assets.map(asset => asset.url)
    const logoAsset = assets.find(asset => asset.role === 'logo')
    const qrcodeAsset = assets.find(asset => asset.role === 'qrcode')
    const qrcodeText = optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const referenceImagePaths = uniqueStrings([...stringArray(rawBody.reference_image_paths), ...brandReferencePaths]).slice(0, 14)
    const suffix = storeBrandSuffix(store, assets, rawBody, mode)
    const prompt = optionalString(rawBody.image_prompt) ?? optionalString(rawBody.prompt) ?? optionalString(rawBody.description)
    const body: Record<string, unknown> = {
      ...rawBody,
      _store_brand_pack_applied: true,
    }
    if (referenceImagePaths.length > 0) body.reference_image_paths = referenceImagePaths
    if (logoAsset && !body._print_logo_path) body._print_logo_path = logoAsset.url
    if (qrcodeAsset && !body._print_qr_path) body._print_qr_path = qrcodeAsset.url
    if (qrcodeText && !body._print_qr_content) body._print_qr_content = qrcodeText
    if (suffix && prompt) body.image_prompt = `${prompt}\n\n${suffix}`
    return body
  }

  function costPayload() {
    return {
      month: new Date().toISOString().slice(0, 7),
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      est_cost_yuan: 0,
      byok_enabled: false,
    }
  }

  async function handleCanvasRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/canvas/')) return null
    const action = url.pathname.slice('/api/v1/canvas/'.length)
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    if (action === 'edit' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const instruction = typeof body.instruction === 'string' ? body.instruction : ''
      return Response.json({ content: instruction ? `${content}\n\n${instruction}`.trim() : content, mode: 'local_fallback' })
    }
    if (action === 'render' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format.toLowerCase() : 'txt'
      const rendered = renderDeliverableBytes(content, format)
      return Response.json({ base64: Buffer.from(rendered.bytes).toString('base64'), ext: rendered.ext })
    }
    if (action === 'save-to-library' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format : 'txt'
      const rawName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `artifact-${Date.now()}`
      const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '_')
      const rendered = renderDeliverableBytes(content, format)
      const ext = rendered.ext
      const abs = join(stateRoot, 'library', `${safeName}.${ext}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, rendered.bytes)
      return Response.json({ ok: true, path: abs })
    }
    if (action === 'doc' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), render: text.length > 200_000 ? 'toobig' : 'page', html: `<pre>${escapeHtml(text)}</pre>`, truncated: false })
    }
    if (action === 'sheet' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && isXlsxPath(resolve(path))) {
        try {
          return Response.json(await readXlsxSheet(resolve(path), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      const rows = text.split(/\r?\n/).slice(0, 200).map(line => line.split(','))
      return Response.json({ name: basename(path || 'sheet.csv'), sheets: [{ name: 'Sheet1', rows }], truncated: false })
    }
    if (action === 'excel-edit' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      if (path && isTextSheetPath(path)) {
        return Response.json(await editCsvCell(path, String(body.cell ?? ''), String(body.value ?? '')))
      }
      if (path && isXlsxPath(path)) {
        try {
          return Response.json(await editXlsxCell(path, String(body.cell ?? ''), String(body.value ?? ''), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, sheet: 'Sheet1', cell: String(body.cell ?? ''), old: '', new: String(body.value ?? ''), detail: 'TS 本地模式仅支持 csv/xlsx 表格写回' }, { status: 501 })
    }
    if (action === 'doc-blocks' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && (isDocxPath(resolve(path)) || isPptxPath(resolve(path)))) {
        try {
          return Response.json(await readOfficeDocumentBlocks(resolve(path)))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), kind: 'docx', blocks: text.split(/\n{2,}/).slice(0, 200).map((block, i) => ({ id: `b${i}`, kind: 'paragraph', text: block })) })
    }
    if (action === 'doc-save' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      const edits = body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits)
        ? body.edits as Record<string, unknown>
        : {}
      if (path && isTextDocumentPath(path)) {
        return Response.json(await saveTextDocumentBlocks(path, edits))
      }
      if (path && (isDocxPath(path) || isPptxPath(path))) {
        try {
          return Response.json(await saveOfficeDocumentBlocks(path, edits))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, path: String(body.path ?? ''), saved: 0, detail: 'TS 本地模式仅支持 txt/md/html/docx/pptx 文档写回' }, { status: 501 })
    }
    return null
  }

  function canvasOfficeError(error: unknown): Response {
    if (error instanceof OfficeDocumentError) return jsonDetailError(error.message, error.status)
    return jsonDetailError(error instanceof Error ? error.message : String(error), 500)
  }

  function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  function escapeXml(value: string): string {
    return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  }

  function renderDeliverableBytes(content: string, format: string): { bytes: Uint8Array; ext: string } {
    const fmt = format.toLowerCase()
    if (fmt.includes('docx') || fmt.includes('word')) return { bytes: renderMinimalDocx(content), ext: 'docx' }
    if (fmt.includes('pptx') || fmt.includes('powerpoint') || fmt.includes('幻灯片')) return { bytes: renderMinimalPptx(content), ext: 'pptx' }
    if (fmt.includes('xlsx') || fmt.includes('excel') || fmt.includes('表格')) return { bytes: renderMinimalXlsx(content), ext: 'xlsx' }
    if (fmt.includes('html') || fmt.includes('网页')) return { bytes: Buffer.from(renderMarkdownHtml(content), 'utf8'), ext: 'html' }
    if (fmt.includes('md') || fmt.includes('markdown')) return { bytes: Buffer.from(content, 'utf8'), ext: 'md' }
    return { bytes: Buffer.from(stripMarkdown(content), 'utf8'), ext: 'txt' }
  }

  function stripMarkdown(content: string): string {
    return content
      .split('\n')
      .map(line => line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*[-*]\s+/, '- ')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1'))
      .join('\n')
  }

  function renderMarkdownHtml(content: string): string {
    const body: string[] = []
    let inList = false
    for (const raw of content.split('\n')) {
      const line = raw.trimEnd()
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      const bullet = line.match(/^\s*[-*]\s+(.*)$/)
      if (!bullet && inList) {
        body.push('</ul>')
        inList = false
      }
      if (heading) {
        const level = heading[1]!.length
        body.push(`<h${level}>${inlineMarkdownHtml(heading[2]!)}</h${level}>`)
      } else if (bullet) {
        if (!inList) {
          body.push('<ul>')
          inList = true
        }
        body.push(`<li>${inlineMarkdownHtml(bullet[1]!)}</li>`)
      } else if (line.trim()) {
        body.push(`<p>${inlineMarkdownHtml(line)}</p>`)
      }
    }
    if (inList) body.push('</ul>')
    return [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<style>body{font-family:-apple-system,system-ui,'PingFang SC',sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.75;color:#1d1d1f;}h1{font-size:24px;}h2{font-size:20px;}h3{font-size:17px;}</style>",
      '</head><body>',
      body.join('\n'),
      '</body></html>',
    ].join('')
  }

  function inlineMarkdownHtml(value: string): string {
    return escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  }

  function renderMinimalDocx(content: string): Uint8Array {
    const paragraphs = content.split(/\n+/).map(line => line.trim()).filter(Boolean)
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      paragraphs.map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(stripMarkdown(line))}</w:t></w:r></w:p>`).join('') +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
    return zipStore([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
      { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
      { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    ])
  }

  async function backupLocalFile(path: string): Promise<string | null> {
    if (!existsSync(path)) return null
    const bdir = join(dirname(path), '.billiards-backups')
    await mkdir(bdir, { recursive: true })
    const backup = join(bdir, `${basename(path)}.${Date.now()}.bak`)
    await copyFile(path, backup)
    return backup
  }

  function isTextDocumentPath(path: string): boolean {
    if (isSensitiveFilePath(path)) return false
    return ['.txt', '.md', '.markdown', '.html', '.htm'].includes(extname(path).toLowerCase())
  }

  function isTextSheetPath(path: string): boolean {
    if (isSensitiveFilePath(path)) return false
    return extname(path).toLowerCase() === '.csv'
  }

  async function saveTextDocumentBlocks(path: string, edits: Record<string, unknown>) {
    const text = await readTextIfExists(path)
    const blocks = text.split(/\n{2,}/)
    let saved = 0
    for (const [id, value] of Object.entries(edits)) {
      const match = id.match(/^b(\d+)$/)
      if (!match || typeof value !== 'string') continue
      const index = Number(match[1])
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) continue
      blocks[index] = value
      saved++
    }
    if (saved > 0) {
      await backupLocalFile(path)
      await writeFile(path, blocks.join('\n\n'), 'utf8')
    }
    return { ok: true, path, saved }
  }

  async function editCsvCell(path: string, cell: string, value: string) {
    const pos = parseA1Cell(cell)
    if (!pos) return { ok: false, sheet: 'Sheet1', cell, old: '', new: value, detail: `坐标无效:${cell}` }
    const rows = (await readTextIfExists(path)).split(/\r?\n/).map(parseCsvLine)
    while (rows.length <= pos.row) rows.push([])
    while (rows[pos.row]!.length <= pos.col) rows[pos.row]!.push('')
    const old = rows[pos.row]![pos.col] ?? ''
    rows[pos.row]![pos.col] = value
    await backupLocalFile(path)
    await writeFile(path, rows.map(formatCsvLine).join('\n'), 'utf8')
    return { ok: true, sheet: 'Sheet1', cell: cell.toUpperCase(), old, new: value }
  }

  function parseA1Cell(cell: string): { row: number; col: number } | null {
    const match = cell.trim().match(/^([A-Za-z]+)([1-9][0-9]*)$/)
    if (!match) return null
    let col = 0
    for (const ch of match[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
    return { row: Number(match[2]) - 1, col: col - 1 }
  }

  function parseCsvLine(line: string): string[] {
    const out: string[] = []
    let cur = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') {
          quoted = false
        } else {
          cur += ch
        }
      } else if (ch === '"') {
        quoted = true
      } else if (ch === ',') {
        out.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur)
    return out
  }

  function formatCsvLine(row: string[]): string {
    return row.map(value => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')
  }

  function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
    const localParts: Buffer[] = []
    const centralParts: Buffer[] = []
    let offset = 0
    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8')
      const data = Buffer.from(file.data)
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      localParts.push(local, name, data)

      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0, 8)
      central.writeUInt16LE(0, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(data.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(name.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(offset, 42)
      centralParts.push(central, name)
      offset += local.length + name.length + data.length
    }
    const centralOffset = offset
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20)
    return Buffer.concat([...localParts, ...centralParts, end])
  }

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })

  function crc32(data: Uint8Array): number {
    let c = 0xffffffff
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  async function listMcpStatus(rawBody: Record<string, unknown> = {}) {
    const workspaceRoot = stringOr(rawBody.workspaceRoot ?? rawBody.working_dir, process.cwd())
    const mcpConfigPath = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim()
      ? rawBody.mcpConfigPath.trim()
      : opts.mcpConfigPath ?? defaultMcpConfigPath(workspaceRoot, opts.env ?? process.env)
    if (!mcpConfigPath) return { servers: [] }
    const configs = await loadMcpConfigFile(mcpConfigPath).catch(() => [])
    const loaded = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspaceRoot,
      timeoutMs: 5000,
      toolTimeoutMs: 120000,
      fetchImpl: opts.fetchImpl,
    })
    try {
      const connected = new Map(loaded.connections.map(connection => [connection.serverName, connection]))
      const warningText = loaded.warnings.join('\n')
      return {
        servers: configs.map(config => {
          const connection = connected.get(config.name)
          return {
            name: config.name,
            command: config.command,
            url: config.url,
            status: config.disabled === true ? 'disabled' : connection ? 'connected' : warningText.includes(`"${config.name}"`) ? 'error' : 'configured',
            tools: connection?.tools.length ?? 0,
            disabled: config.disabled === true,
          }
        }),
      }
    } finally {
      await closeMcpConnections(loaded.connections)
    }
  }

  async function mediaUnavailable() {
    return Response.json({ ok: false, detail: '媒体后端未配置' }, { status: 503 })
  }

  function videoEditError(error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof VideoEditError ? error.status : 500
    return jsonDetailError(message, status)
  }

  function localStoryboard(body: Record<string, unknown>): Record<string, unknown> {
    const theme = stringOr(body.theme, stringOr(body.prompt, '门店短片'))
    const subject = stringOr(body.subject, '')
    const n = Math.max(2, Math.min(6, numberFrom(body.shots, 3)))
    const subjectText = subject ? `，主体保持为${subject}` : ''
    const shots = Array.from({ length: n }, (_, i) => {
      const step = i + 1
      if (step === 1) return `${theme}开场：给出门店环境或核心物件的建立镜头${subjectText}，运镜稳定。`
      if (step === n) return `${theme}收尾：突出到店行动或活动信息${subjectText}，画面留出文案空间。`
      return `${theme}分镜${step}：切到桌台、灯光、服务或互动细节${subjectText}，节奏自然。`
    })
    return {
      shots,
      caption: `${theme}，今天就来店里体验一下。`,
      local_preview: true,
      message: '媒体后端未配置，当前分镜为 TS 本地结构化占位；配置媒体后端后会调用真实分镜模型。',
    }
  }

  async function handleStudioRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/studio/')) return null
    const action = url.pathname.slice('/api/v1/studio/'.length)
    const generationMatch = action.match(/^generation\/(.+)$/)
    if (generationMatch && req.method === 'GET') {
      const local = media.localGeneration(decodeURIComponent(generationMatch[1]!))
      if (local) return Response.json(local)
      if (media.hasBackend) return Response.json(await media.proxyJson(url.pathname, undefined, 'GET'))
      return Response.json({ ok: false, detail: '没找到这张本地预览成品' }, { status: 404 })
    }
    if (action === 'generate' && req.method === 'POST') {
      const rawBody = await req.json().catch(() => ({})) as Record<string, unknown>
      const trusted = Array.isArray(rawBody.reference_image_paths)
        ? rawBody.reference_image_paths.filter((item): item is string => typeof item === 'string')
        : []
      const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
      return Response.json(await media.startStudioGenerate(body, {
        conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
        workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, process.cwd()),
      }))
    }
    if (action === 'edit' && req.method === 'POST') {
      const rawBody = await req.json().catch(() => ({})) as Record<string, unknown>
      const trusted = typeof rawBody.mask_path === 'string' ? [rawBody.mask_path] : []
      const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
      return Response.json(await media.startStudioEdit(body, {
        conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
        workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, process.cwd()),
      }))
    }
    if (action === 'i2v' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      return Response.json(await media.startStudioI2v(body, {
        conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
        workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, process.cwd()),
      }))
    }
    if (action === 'expand' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/expand', body))
      return Response.json({ image_prompt: stringOr(body.prompt, '') })
    }
    if (action === 'storyboard' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/storyboard', body))
      return Response.json(localStoryboard(body))
    }
    if (media.hasBackend) {
      const body = req.method === 'GET' ? undefined : await req.json().catch(() => ({})) as Record<string, unknown>
      return Response.json(await media.proxyJson(url.pathname, body, req.method))
    }
    return await mediaUnavailable()
  }

  async function handleVideoEditRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/video-edit/')) return null
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
    const workspaceRoot = stringOr(body.workspaceRoot ?? body.working_dir, process.cwd())

    if (url.pathname === '/api/v1/video-edit/localfile' && req.method === 'GET') {
      return await videoEdits.localFileResponse(url.searchParams.get('path'), req.headers.get('range'))
    }

    if (url.pathname === '/api/v1/video-edit/inventory' && req.method === 'POST') {
      const project = typeof body.project === 'string' ? body.project : undefined
      return Response.json(await media.startVideoJob('video_inventory', '/api/v1/video-edit/inventory', body, {
        conversationId,
        workspaceRoot,
        project,
        title: '视频素材理解',
      }))
    }
    if (url.pathname === '/api/v1/video-edit/auto_plan' && req.method === 'POST') {
      const project = typeof body.project === 'string' ? body.project : undefined
      return Response.json(await media.startVideoJob('video_auto_plan', '/api/v1/video-edit/auto_plan', body, {
        conversationId,
        workspaceRoot,
        project,
        title: '视频智能出方案',
      }))
    }
    if (url.pathname === '/api/v1/video-edit/auto_plan_v2' && req.method === 'POST') {
      const project = typeof body.project === 'string' ? body.project : undefined
      return Response.json(await media.startVideoJob('video_auto_plan', '/api/v1/video-edit/auto_plan_v2', body, {
        conversationId,
        workspaceRoot,
        project,
        title: 'V2 视频方案',
      }))
    }

    const renderMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/(render|render_v2)$/)
    if (renderMatch && req.method === 'POST') {
      const project = decodeURIComponent(renderMatch[1]!)
      const action = renderMatch[2]!
      return Response.json(await media.startVideoJob('video_render', `/api/v1/video-edit/projects/${encodeURIComponent(project)}/${action}`, body, {
        conversationId,
        workspaceRoot,
        project,
        title: action === 'render_v2' ? 'V2 视频出片' : '视频出片',
      }))
    }

    const projectActionMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)(?:\/([^/]+))?$/)
    if (projectActionMatch) {
      const project = decodeURIComponent(projectActionMatch[1]!)
      const action = projectActionMatch[2] ? decodeURIComponent(projectActionMatch[2]) : ''
      if (media.hasBackend) {
        return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
      }
      try {
        if (!action && req.method === 'GET') {
          return Response.json(await videoEdits.getProject(project))
        }
        if (action === 'ops' && req.method === 'POST') {
          return Response.json(await videoEdits.applyOperations(project, body.operations))
        }
        if (action === 'auto_caption' && req.method === 'POST') {
          return Response.json(await videoEdits.autoCaption(project, body.track))
        }
        if (action === 'recaption' && req.method === 'POST') {
          return Response.json(await videoEdits.recaption(project, body.tonality))
        }
        if (action === 'edit_feedback' && req.method === 'POST') {
          return Response.json(await videoEdits.editFeedback(project, body.feedback))
        }
      } catch (error) {
        return videoEditError(error)
      }
    }

    if (media.hasBackend) {
      return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
    }
    return await mediaUnavailable()
  }

  return Bun.serve<AgentWsData>({
    hostname: host,
    port,
    idleTimeout: 30,
    async fetch(req, server) {
      const preflight = localCorsPreflight(req)
      if (preflight) return preflight
      const response = await (async (): Promise<Response | undefined> => {
      const url = new URL(req.url)

      if (url.pathname === '/agent/ws') {
        const conversationId = stringOr(url.searchParams.get('conversationId'), crypto.randomUUID())
        const after = numberFrom(url.searchParams.get('after'), 0)
        if (server.upgrade(req, { data: { conversationId, after } satisfies AgentWsData })) {
          return undefined as unknown as Response
        }
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: 'ts-harness', ts: Date.now() })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const localUpload = await serveLocalUpload(url.pathname)
        if (localUpload) return localUpload
        const upload = media.serveUpload(url.pathname)
        if (upload) return upload
      }

      if (url.pathname === '/api/v1/backup/export' && req.method === 'GET') {
        return new Response(JSON.stringify({
          exported_at: new Date().toISOString(),
          store: await desktopData.getStore(),
          byok: await desktopData.getByok(),
          memories: await desktopData.listMemories(),
          scheduled_tasks: await desktopData.listScheduledTasks(),
          store_docs: await desktopData.getStoreDocs(),
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="billiards-ai-backup.json"',
          },
        })
      }

      const studioResponse = await handleStudioRoute(url, req)
      if (studioResponse) return studioResponse

      const videoEditResponse = await handleVideoEditRoute(url, req)
      if (videoEditResponse) return videoEditResponse

      const canvasResponse = await handleCanvasRoute(url, req)
      if (canvasResponse) return canvasResponse

      if (url.pathname === '/api/v1/auth/me') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ id: 'local-user', email: 'local@desktop', name: '本地用户' })
      }

      if (url.pathname === '/api/v1/stores' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.updateStore(body), { status: 201 })
      }

      if (url.pathname === '/api/v1/stores/me') {
        if (req.method === 'GET') return Response.json(await desktopData.getStore())
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.updateStore(body))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/logo' || url.pathname === '/api/v1/stores/me/qrcode') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return await saveUpload(req, url.pathname.endsWith('/logo') ? 'logo' : 'qrcode')
      }

      if (url.pathname === '/api/v1/stores/me/byok') {
        if (req.method === 'GET') return Response.json(await desktopData.getByok())
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const updated = await desktopData.updateByok(body)
          await syncLegacyByokTextProvider(body, updated)
          return Response.json(updated)
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/byok/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.validateByok(body))
      }

      if (url.pathname === '/api/v1/stores/me/byok/profiles') {
        if (req.method === 'GET') return Response.json(await desktopData.listByokProfiles())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.addByokProfile(body))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const byokProfileMatch = url.pathname.match(/^\/api\/v1\/stores\/me\/byok\/profiles\/([^/]+)(?:\/(activate))?$/)
      if (byokProfileMatch) {
        const name = decodeURIComponent(byokProfileMatch[1]!)
        const action = byokProfileMatch[2]
        if (action === 'activate' && req.method === 'POST') return Response.json(await desktopData.activateByokProfile(name))
        if (!action && req.method === 'DELETE') return Response.json(await desktopData.deleteByokProfile(name))
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/voice/transcribe') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const form = await req.formData().catch(() => null)
        const file = form?.get('file')
        if (!(file instanceof File)) return jsonDetailError('file required', 400)
        try {
          return Response.json(await transcribeVoiceFile(file, { stateRoot, env: opts.env ?? process.env }))
        } catch (err) {
          const status = err instanceof VoiceTranscriptionError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/logs/client') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/store-memory' || url.pathname === '/api/v1/store-memory/candidates') {
        if (req.method === 'GET') return Response.json(await desktopData.listMemories())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const content = typeof body.content === 'string' ? body.content : ''
          if (!content.trim()) return jsonDetailError('content required', 400)
          return Response.json(await desktopData.addMemory({
            content,
            type: typeof body.type === 'string' ? body.type : 'semantic',
            source: url.pathname.endsWith('/candidates') ? 'pending' : 'manual',
            workingDir: typeof body.working_dir === 'string' ? body.working_dir : null,
          }), { status: 201 })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const memoryMatch = url.pathname.match(/^\/api\/v1\/store-memory\/([^/]+)(?:\/(confirm))?$/)
      if (memoryMatch) {
        const id = decodeURIComponent(memoryMatch[1]!)
        const action = memoryMatch[2]
        if (!action && req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const item = await desktopData.updateMemory(id, typeof body.content === 'string' ? body.content : '')
          if (!item) return jsonDetailError('memory not found', 404)
          return Response.json(item)
        }
        if (action === 'confirm' && req.method === 'POST') {
          const item = await desktopData.confirmMemory(id)
          if (!item) return jsonDetailError('memory not found', 404)
          return Response.json(item)
        }
        if (!action && req.method === 'DELETE') {
          await desktopData.deleteMemory(id)
          return Response.json({ ok: true })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/scheduled-tasks') {
        if (req.method === 'GET') return Response.json(await desktopData.listScheduledTasks())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.createScheduledTask(body), { status: 201 })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const scheduledMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)$/)
      if (scheduledMatch) {
        const id = decodeURIComponent(scheduledMatch[1]!)
        if (req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const item = await desktopData.updateScheduledTask(id, body)
          if (!item) return jsonDetailError('scheduled task not found', 404)
          return Response.json(item)
        }
        if (req.method === 'DELETE') {
          await desktopData.deleteScheduledTask(id)
          return Response.json({ status: 'ok' })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/store-docs') {
        if (req.method === 'GET') return Response.json(await desktopData.getStoreDocs())
        if (req.method === 'PUT') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await storeDocs.setFolder(typeof body.folder_path === 'string' ? body.folder_path : null))
        }
        if (req.method === 'DELETE') return Response.json(await storeDocs.clear())
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/store-docs/reindex') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json(await storeDocs.reindex())
      }

      if (url.pathname === '/api/v1/store-docs/search') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const query = typeof body.query === 'string' ? body.query : ''
        const top = typeof body.top === 'number' ? body.top : 5
        const paths = Array.isArray(body.paths)
          ? body.paths.filter((item): item is string => typeof item === 'string')
          : typeof body.path === 'string'
            ? body.path
            : undefined
        return Response.json({ hits: await storeDocs.search(query, top, { paths }) })
      }

      if (url.pathname === '/api/v1/dashboard/today') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await desktopData.dashboardToday())
      }

      if (url.pathname === '/api/v1/dashboard/adopt-rec' || url.pathname === '/api/v1/dashboard/dismiss-rec') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.rec_id === 'string' ? body.rec_id : ''
        if (url.pathname.endsWith('/dismiss-rec')) return Response.json(await desktopData.dismissRecommendation(id))
        return Response.json({ status: 'ok', rec_id: id })
      }

      if (url.pathname === '/api/v1/notifications') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await desktopData.notificationsAfter(numberFrom(url.searchParams.get('after'), 0)))
      }

      if (url.pathname === '/api/v1/quota/cost') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(costPayload())
      }

      if (url.pathname === '/model/health/clear' || url.pathname === '/api/model/health/clear') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          return Response.json(await clearModelHealth(body))
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/model' || url.pathname === '/api/model') {
        if (req.method === 'GET') {
          const status = await currentModelStatus()
          return Response.json(status, { status: status.ok ? 200 : 503 })
        }
        if (req.method === 'POST' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const providerId = typeof body.providerId === 'string'
            ? body.providerId.trim()
            : typeof body.id === 'string'
              ? body.id.trim()
              : ''
          try {
            if (!providerId || providerId === 'env' || providerId === 'default') await providers.clearActive()
            else await providers.activate(providerId)
            const status = await currentModelStatus()
            return Response.json(status, { status: status.ok ? 200 : 503 })
          } catch (err) {
            return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
          }
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/skills') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const skills = await loadSkillsDir(opts.skillsRoot ?? defaultSkillsRoot())
        return Response.json({
          skills: skills.skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            argument_hint: skill.whenToUse,
            user_invocable: true,
          })),
        })
      }

      if (url.pathname === '/api/v1/agent/output-styles') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const styles = await loadOutputStyles()
        return Response.json({ output_styles: styles.styles.map(publicOutputStyle) })
      }

      if (url.pathname === '/api/v1/agent/packs') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ packs: listPublicDomainPacks() })
      }

      if (url.pathname === '/api/v1/agent/mcp') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await listMcpStatus({ workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined }))
      }

      if (url.pathname === '/api/v1/agent/workspace-status') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const workspaceRoot = url.searchParams.get('working_dir') || url.searchParams.get('workspaceRoot') || process.cwd()
        const workspace = new Workspace(workspaceRoot)
        const [git, projectInstructions, tree] = await Promise.all([
          getWorkspaceGitStatus(workspaceRoot),
          summarizeWorkspaceProjectInstructions(workspace),
          summarizeWorkspaceTree(workspaceRoot),
        ])
        return Response.json({ git, projectInstructions, tree })
      }

      if (url.pathname === '/api/v1/agent/bridge/peers') {
        try {
          if (req.method === 'GET') return Response.json({ peers: await bridgePeers.list() })
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ peer: await bridgePeers.register({
              sessionId: stringOr(body.sessionId ?? body.session_id, ''),
              label: typeof body.label === 'string' ? body.label : undefined,
              workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : typeof body.workspace_root === 'string' ? body.workspace_root : undefined,
              machineName: typeof body.machineName === 'string' ? body.machineName : typeof body.machine_name === 'string' ? body.machine_name : undefined,
              status: body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error' ? body.status : undefined,
              inboundEnabled: typeof body.inboundEnabled === 'boolean' ? body.inboundEnabled : typeof body.inbound_enabled === 'boolean' ? body.inbound_enabled : undefined,
              lastError: typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined,
            }) }, { status: 201 })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePeerMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/peers\/([^/]+)$/)
      if (bridgePeerMatch) {
        const sessionId = decodeURIComponent(bridgePeerMatch[1]!)
        try {
          if (req.method === 'PATCH') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const status = body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error'
              ? body.status
              : undefined
            if (!status) return jsonError('status required', 400)
            const peer = await bridgePeers.updateStatus(sessionId, status, typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined)
            if (!peer) return jsonError('bridge peer not found', 404)
            return Response.json({ peer })
          }
          if (req.method === 'DELETE') {
            await bridgePeers.unregister(sessionId)
            return Response.json({ ok: true })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeEventsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/events$/)
      if (bridgeEventsMatch) {
        const sessionId = decodeURIComponent(bridgeEventsMatch[1]!)
        try {
          if (req.method === 'GET') {
            return Response.json({
              events: await bridgeRemote.listEvents(sessionId, {
                after: numberFrom(url.searchParams.get('after'), 0),
                limit: numberFrom(url.searchParams.get('limit'), 100),
              }),
            })
          }
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const event = isRecord(body.event) ? body.event : body
            return Response.json(await bridgeRemote.ingestEvent(sessionId, event), { status: 201 })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePermissionsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions$/)
      if (bridgePermissionsMatch) {
        const sessionId = decodeURIComponent(bridgePermissionsMatch[1]!)
        try {
          if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
          return Response.json({ permissions: await bridgeRemote.listPermissions(sessionId, bridgePermissionStatusFrom(url.searchParams.get('status'))) })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePermissionRespondMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions\/([^/]+)\/respond$/)
      if (bridgePermissionRespondMatch) {
        const sessionId = decodeURIComponent(bridgePermissionRespondMatch[1]!)
        const requestId = decodeURIComponent(bridgePermissionRespondMatch[2]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const result = await bridgeRemote.respondToPermission(sessionId, requestId, bridgePermissionResponseFrom(body))
          if (!result) return jsonError('bridge permission request not found', 404)
          return Response.json(result)
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox$/)
      if (bridgeOutboxMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxMatch[1]!)
        try {
          if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
          return Response.json({ outbox: await bridgeRemote.listOutbox(sessionId, bridgeOutboxStatusFrom(url.searchParams.get('status'))) })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxSentMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/([^/]+)\/sent$/)
      if (bridgeOutboxSentMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxSentMatch[1]!)
        const outboxId = decodeURIComponent(bridgeOutboxSentMatch[2]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const item = await bridgeRemote.markOutboxSent(sessionId, outboxId)
          if (!item) return jsonError('bridge outbox item not found', 404)
          return Response.json({ outbox: item })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxFlushMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/flush$/)
      if (bridgeOutboxFlushMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxFlushMatch[1]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const config = bridgeRemoteConfigFromBody(body, opts.env ?? process.env)
          if (!config) return jsonError('bridge remote transport is not configured', 400)
          const transport = createBridgeRemoteTransport({ ...config, fetchImpl: opts.fetchImpl })
          const queued = await bridgeRemote.listOutbox(sessionId, 'queued')
          const results: Array<Record<string, unknown>> = []
          for (const item of queued) {
            const sent = await transport.sendOutboxItem(item)
            if (sent.ok) {
              const marked = await bridgeRemote.markOutboxSent(sessionId, item.id)
              results.push({ id: item.id, requestId: item.requestId, ok: true, status: sent.status, outbox: marked })
            } else {
              results.push({ id: item.id, requestId: item.requestId, ok: false, status: sent.status, error: sent.error })
            }
          }
          return Response.json({ ok: results.every(item => item.ok === true), flushed: results.filter(item => item.ok === true).length, total: results.length, results })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/api/v1/agent/mcp/presets') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ presets: MCP_PRESETS })
      }

      if (url.pathname === '/api/v1/agent/mcp/add') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await addMcpServer(body, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/mcp/remove') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await removeMcpServer(body.name, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/mcp/toggle') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await setMcpServerDisabled(body.name, body.disabled, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/plugins') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ plugins: await listPlugins(defaultPluginRoots(opts.env ?? process.env)) })
      }

      if (url.pathname === '/api/v1/agent/plugins/toggle') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await setPluginEnabled(body.name, body.enabled, defaultPluginRoots(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/plugins/install') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await installPluginFromGithub(body.repo, defaultPluginInstallDir(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/execute') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await executeLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/reject') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await rejectLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/chat') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        server.timeout(req, 0)
        try {
          return await legacyChatResponse(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/agent/daily-drafts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json(dailyDraftPayload())
      }

      if (url.pathname === '/api/v1/agent/conversations') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await legacyConversations())
      }

      const legacyConversationMatch = url.pathname.match(/^\/api\/v1\/agent\/conversations\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyConversationMatch) {
        const conversationId = legacyConversationMatch[1]!
        if (req.method === 'GET') return Response.json(await legacyConversationMessages(conversationId))
        if (req.method === 'DELETE') {
          await legacyStore.setConversationDeleted(conversationId, true)
          return Response.json({ ok: true, conversation_id: conversationId })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/recent-artifacts') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ items: await legacyStore.listArtifacts(numberFrom(url.searchParams.get('limit'), 12), false) })
      }

      if (url.pathname === '/api/v1/agent/saved-artifacts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          const item = await legacyStore.saveArtifact({
            title: typeof body.title === 'string' ? body.title : undefined,
            content: typeof body.content === 'string' ? body.content : '',
            conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : null,
            kind: typeof body.kind === 'string' ? body.kind : null,
          })
          return Response.json(item)
        } catch (err) {
          return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
        }
      }

      const legacyRecentArtifactMatch = url.pathname.match(/^\/api\/v1\/agent\/recent-artifacts\/([A-Za-z0-9_-]{1,128})(?:\/(rating))?$/)
      if (legacyRecentArtifactMatch) {
        const artifactId = legacyRecentArtifactMatch[1]!
        const action = legacyRecentArtifactMatch[2]
        if (!action && req.method === 'DELETE') {
          await legacyStore.setArtifactDeleted(artifactId, true)
          return Response.json({ ok: true, id: artifactId })
        }
        if (action === 'rating' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const rating = body.rating === 'bad' ? 'bad' : body.rating === 'good' ? 'good' : null
          if (!rating) return jsonDetailError('评价只能是 good 或 bad', 400)
          const ok = await legacyStore.rateArtifact(artifactId, rating, typeof body.note === 'string' ? body.note : null)
          if (!ok) return jsonDetailError('没找到这条成品', 404)
          return Response.json({ ok: true, id: artifactId, rating })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/deleted-items') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const limit = numberFrom(url.searchParams.get('limit'), 30)
        const [artifactItems, conversationItems] = await Promise.all([
          legacyStore.listArtifacts(limit, true),
          deletedConversationArtifacts(limit),
        ])
        const items = [...artifactItems, ...conversationItems]
          .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          .slice(0, Math.max(1, Math.min(80, limit)))
        return Response.json({ items })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) await legacyStore.setConversationDeleted(conversationId, false)
        else if (id) await legacyStore.setArtifactDeleted(id, false)
        else return jsonDetailError('缺少要恢复的内容', 400)
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/purge') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) {
          await sessions.remove(conversationId)
          await legacyStore.setConversationDeleted(conversationId, false)
        } else if (id) {
          await legacyStore.purgeArtifact(id)
        } else {
          return jsonDetailError('缺少要彻底删除的内容', 400)
        }
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/clear') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const deletedConversationIds = await legacyStore.clearDeletedConversations()
        await Promise.all(deletedConversationIds.map(id => sessions.remove(id).catch(() => false)))
        await legacyStore.clearDeletedArtifacts()
        return Response.json({ ok: true, removed_file_backups: 0 })
      }

      if (url.pathname === '/api/v1/agent/file-diff') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return await fileDiffFromQuery(url)
      }

      if (url.pathname === '/api/v1/agent/file-restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await restoreFileFromBackup(body)
      }

      if (url.pathname === '/api/v1/agent/image/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(validateImageModelPayload(body))
      }

      if (url.pathname === '/api/v1/agent/tasks') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          return Response.json(await startLegacyAgentTask(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, detail: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      const legacyTaskMatch = url.pathname.match(/^\/api\/v1\/agent\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel|message))$/)
      if (legacyTaskMatch) {
        const id = legacyTaskMatch[1]!
        const action = legacyTaskMatch[2]!
        if (action === 'events' && req.method === 'GET') {
          server.timeout(req, 0)
          const after = Number.parseInt(url.searchParams.get('after') ?? '-1', 10)
          return new Response(legacyTaskEventStream(id, after), {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }
        if (action === 'cancel' && req.method === 'POST') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id, ['queued', 'running'])
          const interrupted = task?.conversationId ? turns.interrupt(task.conversationId) : false
          const taskId = task?.id ?? id
          const cancelled = await tasks.cancel(taskId)
          return Response.json({
            ok: true,
            task_id: taskId,
            ...(task && task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task?.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            status: cancelled || interrupted ? 'cancelled' : task?.status ?? 'unknown',
          })
        }
        if (action === 'message' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) return Response.json({ ok: false, detail: 'message required' }, { status: 400 })
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task?.conversationId) return Response.json({ ok: false, detail: 'task not found' }, { status: 404 })
          const inbox = steerInboxes.get(task.conversationId) ?? []
          inbox.push(message)
          steerInboxes.set(task.conversationId, inbox)
          await tasks.appendEvent(task.id, { type: 'steering', content: message }).catch(() => undefined)
          return Response.json({
            ok: true,
            task_id: task.id,
            ...(task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            queued: inbox.length,
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const legacyMediaJobMatch = url.pathname.match(/^\/api\/v1\/agent\/media-jobs\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyMediaJobMatch) {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const status = await media.status(legacyMediaJobMatch[1]!)
        if (!status) return Response.json({ ok: false, detail: '任务不存在或已过期' }, { status: 404 })
        return Response.json(status)
      }

      const providerRoute = providerPath(url)
      if (providerRoute.matched) {
        try {
          const [id, action] = providerRoute.segments

          if (!id) {
            if (req.method === 'GET') return Response.json(await providers.list())
            if (req.method === 'POST') {
              const body = await req.json().catch(() => ({})) as Record<string, unknown>
              return Response.json({ provider: await providers.create(body) }, { status: 201 })
            }
            return new Response('Method not allowed', { status: 405 })
          }

          if (id === 'reorder' && !action && req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const ids = stringArray(body.ids ?? body.providerIds ?? body.order)
            return Response.json(await providers.reorder(ids))
          }

          if (id === 'active' && action === 'clear' && req.method === 'POST') {
            await providers.clearActive()
            return Response.json({ ok: true })
          }

          if (action === 'clear-health' && req.method === 'POST') {
            return Response.json(await clearModelHealth({ providerId: id }))
          }

          if (id === 'test' && req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ result: await providers.testProviderConfig(body, { fetchImpl: opts.fetchImpl }) })
          }

          if (action === 'activate' && req.method === 'POST') {
            return Response.json({ provider: await providers.activate(id) })
          }

          if ((action === 'enable' || action === 'disable') && req.method === 'POST') {
            return Response.json({ provider: await providers.setEnabled(id, action === 'enable') })
          }

          if (action === 'enabled' && (req.method === 'POST' || req.method === 'PATCH')) {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ provider: await providers.setEnabled(id, body.enabled !== false) })
          }

          if (action === 'test' && req.method === 'POST') {
            return Response.json({ result: await providers.testProvider(id, { fetchImpl: opts.fetchImpl }) })
          }

          if (!action && req.method === 'GET') {
            const provider = await providers.get(id)
            if (!provider) return jsonError('provider not found', 404)
            return Response.json({ provider })
          }
          if (!action && (req.method === 'PUT' || req.method === 'PATCH')) {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ provider: await providers.update(id, body) })
          }
          if (!action && req.method === 'DELETE') {
            await providers.delete(id)
            return Response.json({ ok: true })
          }

          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const commandRoute = url.pathname.match(/^\/(?:api\/)?commands(?:\/(expand))?$/)
      if (commandRoute) {
        const queryPacks = [
          ...url.searchParams.getAll('knowledge_packs'),
          ...url.searchParams.getAll('knowledgePacks'),
          ...url.searchParams.getAll('enabled_packs'),
          ...url.searchParams.getAll('enabledPacks'),
        ].filter(Boolean)
        const bodyForWorkspace = req.method === 'GET'
          ? {
              working_dir: url.searchParams.get('working_dir') ?? undefined,
              workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined,
              knowledge_packs: queryPacks.length > 0 ? queryPacks : undefined,
              billiards_mode: url.searchParams.get('billiards_mode') === 'true' || url.searchParams.get('billiardsMode') === 'true',
            }
          : await req.clone().json().catch(() => ({})) as Record<string, unknown>
        const workspace = workspaceFromBody(bodyForWorkspace)
        const commands = await loadCommandsForWorkspace(workspace.root, opts.commandsRoot ?? defaultCommandsRoot(), resolveEnabledPacks(bodyForWorkspace))
        if (!commandRoute[1] && req.method === 'GET') {
          return Response.json({ commands: commands.commands.map(publicCommand) })
        }
        if (commandRoute[1] === 'expand' && req.method === 'POST') {
          const body = bodyForWorkspace
          if (typeof body.name !== 'string') return Response.json({ ok: false, error: 'name required' }, { status: 400 })
          const command = commands.byName.get(normalizeCommandName(body.name))
          if (!command) return Response.json({ ok: false, error: 'command not found' }, { status: 404 })
          return Response.json({ command: publicCommand(command), prompt: await command.getPrompt(typeof body.args === 'string' ? body.args : '', { workspace }) })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/sessions') {
        if (req.method === 'GET') {
          return Response.json({ sessions: await sessions.list() })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const meta = await sessions.create({
            id: typeof body.id === 'string' ? body.id : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            workspaceRoot: stringOr(body.workspaceRoot, process.cwd()),
          })
          return Response.json({ session: meta })
        }
      }

      if (url.pathname === '/tasks') {
        if (req.method === 'GET') {
          return Response.json({
            tasks: await tasks.list({
              conversationId: url.searchParams.get('conversationId') ?? undefined,
              status: taskStatusFrom(url.searchParams.get('status')),
              limit: numberFrom(url.searchParams.get('limit'), 200),
              collapseResumedBackgroundAgents: true,
            }),
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel))?$/)
      if (taskMatch) {
        const id = taskMatch[1]!
        const action = taskMatch[2]
        if (!action && req.method === 'GET') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
          const includeEvents = url.searchParams.get('includeEvents') === '1'
          return Response.json({
            task,
            ...taskAliasPayload(task, requestedTaskId),
            ...(includeEvents ? { events: await tasks.loadEvents(task.id, { limit: 100 }) } : {}),
          })
        }
        if (action === 'events' && req.method === 'GET') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          const events = await tasks.loadEvents(task.id, { after, limit })
          return Response.json({
            events,
            ...taskAliasPayload(task, requestedTaskId),
            nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
          })
        }
        if (action === 'cancel' && req.method === 'POST') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id, ['queued', 'running'])
          const taskId = task?.id ?? id
          return Response.json({
            ok: true,
            cancelled: await tasks.cancel(taskId),
            taskId,
            ...(task && task.id !== requestedTaskId ? { requestedTaskId } : {}),
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(interrupt|events|messages|archive))?$/)
      if (sessionMatch) {
        const id = sessionMatch[1]!
        const action = sessionMatch[2]
        if (!action && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const includeEvents = url.searchParams.get('includeEvents') === '1'
          const includeMessages = url.searchParams.get('includeMessages') !== '0'
          return Response.json({
            session,
            ...(includeMessages ? { messages: await sessions.loadTranscript(id) } : {}),
            ...(includeEvents ? { events: await sessions.loadEvents(id, { limit: 100 }) } : {}),
          })
        }
        if (action === 'messages' && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          return Response.json(await sessions.loadTranscriptPage(id, { after, limit }))
        }
        if (action === 'events' && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          const events = await sessions.loadEvents(id, { after, limit })
          if (url.searchParams.get('format') === 'sse') {
            const body = events.map(record => sseReplayLine(record.seq, record.event)).join('')
            return new Response(body, {
              headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
            })
          }
          return Response.json({
            events,
            nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
          })
        }
        if (action === 'interrupt' && req.method === 'POST') {
          const interrupted = turns.interrupt(id)
          if (interrupted) {
            await sessions.touch(id, { status: 'interrupted' })
            await sessions.appendEvent(id, { type: 'context_note', text: '任务已请求中断' }).catch(() => undefined)
          }
          return Response.json({ ok: true, interrupted })
        }
        if (action === 'archive' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          try {
            return Response.json(await archiveSession(id, body))
          } catch (err) {
            const status = err instanceof TurnSetupError ? err.status : 500
            return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
          }
        }
      }

      if (url.pathname === '/agent/hello') {
        server.timeout(req, 0) // 关掉 Bun 空闲掐断,否则安静的 SSE 流会被杀
        const workspace = new Workspace(process.cwd())
        const systemPrompt = await buildSystemPrompt(workspace)
        // demo model:请求列一次工作区,拿到结果后收敛。真模型出口留 W6。
        const demoSteps: AssistantStep[] = [
          { kind: 'tool_calls', text: '看看工作区里有什么', calls: [{ id: '1', name: 'list_dir', input: {} }] },
          { kind: 'final', text: '这是当前工作区的内容。' },
        ]
        const body = (async function* () {
          for await (const ev of runAgentLoop({
            model: scriptedModel(demoSteps),
            registry: buildGeneralRegistry(),
            workspace,
            systemPrompt,
            userMessage: '列一下工作区',
          })) {
            yield sseLine(ev)
          }
          yield sseLine({ type: 'done' })
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      if (url.pathname === '/agent/prewarm') {
        if (req.method !== 'POST' && req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const body = req.method === 'POST'
          ? await req.json().catch(() => ({})) as Record<string, unknown>
          : Object.fromEntries(url.searchParams.entries())
        try {
          return Response.json(await prewarm(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      if (url.pathname === '/agent/run') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>

        server.timeout(req, 0)
        let turn: { stream: AsyncGenerator<SessionEventRecord> }
        try {
          turn = await createTurnStream(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
        const bodyStream = (async function* () {
          for await (const record of turn.stream) {
            yield sseLine(record.event)
          }
        })()
        return new Response(bodyStream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      return new Response('Not found', { status: 404 })
      })()
      return response ? withLocalCors(response, req) : undefined as unknown as Response
    },
    websocket: {
      open(ws) {
        wsSend(ws, { type: 'ready', conversationId: ws.data.conversationId })
        if (ws.data.after > 0) {
          void replayWsEvents(ws, ws.data.conversationId, ws.data.after).catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
        }
      },
      message(ws, message) {
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'))
        } catch {
          wsError(ws, 'invalid websocket JSON message')
          return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          wsError(ws, 'websocket message must be an object')
          return
        }
        const body = parsed as Record<string, unknown>
        const type = typeof body.type === 'string' ? body.type : 'run'
        if (type === 'run') {
          void handleWsRun(ws, body)
          return
        }
        if (type === 'replay') {
          const conversationId = stringOr(body.conversationId, ws.data.conversationId)
          const after = numberFrom(body.after, 0)
          ws.data.conversationId = conversationId
          void replayWsEvents(ws, conversationId, after).catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        if (type === 'interrupt') {
          const conversationId = stringOr(body.conversationId, ws.data.conversationId)
          const interrupted = turns.interrupt(conversationId)
          void (async () => {
            if (interrupted) {
              await sessions.touch(conversationId, { status: 'interrupted' })
              const record = await sessions.appendEvent(conversationId, { type: 'context_note', text: '任务已请求中断' }).catch(() => null)
              if (record) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
            }
            wsSend(ws, { type: 'interrupt_result', conversationId, interrupted })
          })().catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        wsError(ws, `unknown websocket message type: ${type}`)
      },
    },
  })
}
