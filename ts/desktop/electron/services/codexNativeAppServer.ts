import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import {
  BILLIARDBUDDY_AGENT_ENGINE_NAME,
  CODEX_CODE_MODE_HOST_NAME,
  CODEX_ENGINE_MANIFEST_SCHEMA,
  CODEX_ENGINE_PRODUCT_PATCHES,
  CODEX_ENGINE_SOURCE_REPOSITORY,
  CODEX_ENGINE_SOURCE_REVISION,
} from '../../../shared/product/codexEngineContract'
import {
  binaryIntegritySha256,
  type BinaryHashMode,
} from '../../../shared/product/binaryIntegrity'
import {
  startCodexNativeProvider,
  type CodexNativeModelRoute,
  type StartedCodexNativeProvider,
} from './codexNativeProvider'

type JsonPrimitive = string | number | boolean | null
export type CodexNativeJsonValue = JsonPrimitive | CodexNativeJsonObject | CodexNativeJsonValue[]
export type CodexNativeJsonObject = { [key: string]: CodexNativeJsonValue | undefined }

type PendingRequest = {
  resolve(value: CodexNativeJsonValue): void
  reject(error: Error): void
}

export type CodexNativeNotification = {
  method: string
  params?: CodexNativeJsonValue
}

export type CodexNativeServerRequest = CodexNativeNotification & {
  id: string | number
}

export type CodexNativeAppServerClientOptions = {
  /** Resolved BilliardBuddy-owned binary; never a renderer-provided command. */
  command: readonly string[]
  /** BilliardBuddy's private Agent runtime home. This is the sole Agent Thread Store. */
  engineHome: string
  /** Do not let process start-up implicitly enter an untrusted workspace. */
  cwd?: string
  configOverrides: readonly string[]
  environment: Readonly<Record<string, string>>
  onNotification?(notification: CodexNativeNotification): void | Promise<void>
  onServerRequest?(request: CodexNativeServerRequest): Promise<CodexNativeJsonValue | undefined>
  /** Release product UI waiters when this specific Rust child is no longer usable. */
  onUnavailable?(error: Error): void
}

/**
 * BilliardBuddy names the three source-native Codex permission experiences.
 * These are inputs to Rust, never a second permission engine in Electron.
 */
export type NativeCodexPermissionMode = 'ask' | 'approve-for-me' | 'full-access'

/** Exact source-native Windows sandbox setup selections. */
export type NativeCodexWindowsSandboxSetupMode = 'elevated' | 'unelevated'
export type NativeCodexWindowsSandboxReadiness = 'ready' | 'notConfigured' | 'updateRequired'

export type NativeCodexWindowsSandboxReadinessResponse = {
  status: NativeCodexWindowsSandboxReadiness
}

export type NativeCodexWindowsSandboxSetupStartResponse = {
  started: boolean
}

export type NativeCodexWindowsSandboxInput = {
  /** Verified workspace used only to boot the Rust App Server. */
  cwd: string
  route: CodexNativeModelRoute
}

export type NativeCodexWindowsSandboxSetupInput = NativeCodexWindowsSandboxInput & {
  mode: NativeCodexWindowsSandboxSetupMode
}

export type NativeCodexThread = {
  id: string
  /** Projected from the authoritative App Server Thread settings response. */
  permissionMode: NativeCodexPermissionMode
  /** Live source-native Turns recovered from `thread/resume`; never a second durable status store. */
  activeTurnIds: string[]
  /** Source relation used by the desktop host to inherit a child Thread owner. */
  parentThreadId?: string
  /** Opaque source-native cursors used to continue lazy history hydration. */
  turnsBackwardsCursor?: string
  itemsBackwardsCursor?: string
}

export type NativeCodexTurn = {
  id: string
}

/** A source-native Codex review target; Electron never synthesizes review prompts. */
export type NativeCodexReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch', branch: string }
  | { type: 'commit', sha: string, title?: string }
  | { type: 'custom', instructions: string }

export type NativeCodexReviewDelivery = 'inline' | 'detached'

export type NativeCodexStartReviewInput = {
  target: NativeCodexReviewTarget
  /** Omitted keeps the upstream App Server default: inline. */
  delivery?: NativeCodexReviewDelivery
}

export type NativeCodexReview = {
  turn: NativeCodexTurn
  /** Equals the parent Thread for inline reviews; a source-forked Thread otherwise. */
  reviewThreadId: string
}

/** The two collaboration presets published by the pinned App Server. */
export type NativeCodexCollaborationMode = 'default' | 'plan'

/**
 * The value is passed unchanged to Codex's `mcp_servers.<name>` schema. Rust
 * validates the transport and owns the persisted configuration; Electron only
 * fixes the writable key-space and the caller's Thread ownership.
 */
export type NativeCodexMcpServerConfig = CodexNativeJsonObject

/** Exactly one source-native skill selector: its display name or SKILL.md path. */
export type NativeCodexSkillSelector = {
  name?: string
  path?: string
}

/** An exact Hook identity returned by `hooks/list`; Electron never invents it. */
export type NativeCodexHookTrustInput = {
  cwd: string
  hookKey: string
  currentHash: string
}

/** Source-native marketplace input. Electron never clones or parses plugins itself. */
export type NativeCodexMarketplaceAddInput = {
  source: string
  refName?: string
  sparsePaths?: string[]
}

/** Local marketplace reference returned by Codex's own plugin catalog. */
export type NativeCodexPluginReference = {
  marketplacePath: string
  pluginName: string
}

/** Opaque source-native migration item returned by externalAgentConfig/detect. */
export type NativeExternalAgentMigrationItem = CodexNativeJsonObject

export type NativeCodexStartThreadInput = {
  cwd: string
  route: CodexNativeModelRoute
  permissionMode: NativeCodexPermissionMode
}

export type NativeCodexResumeThreadInput = {
  threadId: string
  cwd: string
  route: CodexNativeModelRoute
}

/** Source kinds emitted by the pinned App Server for top-level and spawned Threads. */
export type NativeCodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown'

export type NativeCodexThreadListInput = {
  /** A verified directory used only to start the private App Server process. */
  cwd: string
  route: CodexNativeModelRoute
  cursor?: string
  limit?: number
  archived?: boolean
  searchTerm?: string
  sortKey?: 'created_at' | 'updated_at' | 'recency_at'
  sortDirection?: 'asc' | 'desc'
  /** Omitted means every section; null selects only unsectioned Threads. */
  sectionId?: string | null
  /** Exact, verified workspace paths to include in the source-native query. */
  filterCwds?: string[]
  sourceKinds?: NativeCodexThreadSourceKind[]
  /** Experimental source-native relation filters; they are mutually exclusive. */
  parentThreadId?: string
  ancestorThreadId?: string
}

export type NativeCodexLoadedThreadListInput = {
  /** A verified directory used only to start the private App Server process. */
  cwd: string
  route: CodexNativeModelRoute
  cursor?: string
  limit?: number
}

export type NativeCodexThreadMetadataGitInfoUpdate = {
  sha?: string | null
  branch?: string | null
  originUrl?: string | null
}

export type NativeCodexThreadUnsubscribeStatus = 'notLoaded' | 'notSubscribed' | 'unsubscribed'

export type NativeCodexThreadUnsubscribeResponse = {
  status: NativeCodexThreadUnsubscribeStatus
}

export type NativeCodexThreadSettingsPatch = {
  permissionProfileId?: string
  effort?: string
  summary?: 'auto' | 'concise' | 'detailed' | 'none'
  personality?: 'none' | 'friendly' | 'pragmatic'
}

export type NativeCodexClientSettingsProjection = {
  model: string | null
  modelProvider: string | null
  modelContextWindow: number | null
  modelAutoCompactTokenLimit: number | null
  modelAutoCompactTokenLimitScope: string | null
  approvalPolicy: CodexNativeJsonValue
  sandboxMode: string | null
  webSearch: string | null
  reasoningEffort: string | null
  reasoningSummary: string | null
  verbosity: string | null
  serviceTier: string | null
  memoryFeatureEnabled: boolean
  memoryUseEnabled: boolean
  memoryGenerationEnabled: boolean
  origins: Record<string, { source: string, version: string }>
  layers: Array<{ source: string, version: string, disabledReason: string | null }>
}

export type NativeCodexThreadSearchInput = {
  /** A verified directory used only to start the private App Server process. */
  cwd: string
  route: CodexNativeModelRoute
  searchTerm: string
  cursor?: string
  limit?: number
  archived?: boolean
  sortKey?: 'created_at' | 'updated_at' | 'recency_at'
  sortDirection?: 'asc' | 'desc'
}

export type NativeCodexThreadPageInput = {
  cursor?: string
  limit?: number
  sortDirection?: 'asc' | 'desc'
}

export type NativeCodexThreadTurnsPageInput = NativeCodexThreadPageInput & {
  itemsView?: 'notLoaded' | 'summary' | 'full'
}

export type NativeCodexThreadItemsPageInput = NativeCodexThreadPageInput & {
  turnId?: string
}

/** Source-native model catalog pagination for the active provider route. */
export type NativeCodexModelListInput = {
  cursor?: string
  limit?: number
  includeHidden?: boolean
}

/** Source-native permission profiles resolved for one workspace. */
export type NativeCodexPermissionProfileListInput = {
  cwd: string
  cursor?: string
  limit?: number
}

/** Source-native visible-message occurrence search within one Thread. */
export type NativeCodexThreadOccurrenceSearchInput = {
  searchTerm: string
  cursor?: string
  limit?: number
}

/** Source-native persistent Thread section pagination. */
export type NativeCodexThreadSectionListInput = {
  cursor?: string
  limit?: number
}

/** Source-native durable goal statuses. Electron does not invent a parallel task state. */
export type NativeCodexThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete'

/**
 * Patch input for Codex's durable Thread Goal. `null` clears only the native
 * token budget; omitting it leaves the existing source-owned value unchanged.
 */
export type NativeCodexThreadGoalSetInput = {
  objective?: string
  status?: NativeCodexThreadGoalStatus
  tokenBudget?: number | null
}

/** Opaque source-native pagination over background unified-exec terminals. */
export type NativeCodexBackgroundTerminalsPageInput = {
  cursor?: string
  limit?: number
}

export type NativeCodexTextElement = {
  byteRange: { start: number, end: number }
  placeholder?: string
}

export type NativeCodexAdditionalContextEntry = {
  value: string
  kind: 'untrusted' | 'application'
}

export type NativeCodexAdditionalContext = Record<string, NativeCodexAdditionalContextEntry>

export type NativeCodexTurnInput =
  | { type: 'text'; text: string; textElements?: NativeCodexTextElement[] }
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'localImage'; path: string; detail?: 'auto' | 'low' | 'high' | 'original' }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export type NativeCodexMemoryConfiguration = {
  enabled: boolean
  useMemories: boolean
  generateMemories: boolean
}

export type NativeCodexTerminalSize = { rows: number, cols: number }

export type NativeCodexCommandExecResponse = {
  exitCode: number
  stdout: string
  stderr: string
}

export type NativeCodexIntegratedTerminalInput = {
  processId: string
  command: string[]
  size: NativeCodexTerminalSize
}

export type NativeCodexFuzzyFileSearchResult = {
  root: string
  path: string
  matchType: 'file' | 'directory'
  fileName: string
  score: number
  indices?: number[]
}

export type ElectronCodexNativeRuntimeOptions = {
  /** The unpacked desktop root, where verified staged binaries are stored. */
  desktopRoot: string
  /** Electron app userData; never the user's standalone Codex home. */
  userDataPath: string
  onNotification?(notification: CodexNativeNotification): void | Promise<void>
  /**
   * App Server issues approvals, user questions and MCP forms as server
   * requests. The UI bridge supplies a source-shaped response; it never
   * invents Agent state, tools, or a permission grant.
   */
  onServerRequest?(request: CodexNativeServerRequest): Promise<CodexNativeJsonValue | undefined>
  /** Product-owned projection state must not outlive a failed Rust child. */
  onAppServerUnavailable?(error: Error): void
}

const MAX_JSON_RPC_FRAME_BYTES = 128 * 1024 * 1024
const APP_SERVER_SHUTDOWN_WAIT_MS = 1_000
const NATIVE_PROVIDER_ID = 'billiardbuddy'
const NATIVE_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/
const WINDOWS_SANDBOX_HELPER_FILENAMES = [
  'codex-windows-sandbox-setup.exe',
  'codex-command-runner.exe',
] as const

function engineError(message: string, detail?: string): Error {
  return new Error(detail ? `${message}: ${detail}` : message)
}

function jsonObject(value: unknown): CodexNativeJsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CodexNativeJsonObject : undefined
}

/**
 * The native requirements endpoint is the authority for whether an Electron
 * host may capture an Appshot. Absence of a requirements file means Core has
 * no restriction; a malformed response never authorizes a privileged capture.
 */
export function nativeConfigRequirementsAllowAppshots(value: CodexNativeJsonObject): boolean {
  if (!Object.hasOwn(value, 'requirements')) throw new Error('CODEX_NATIVE_CONFIG_REQUIREMENTS_INVALID')
  const rawRequirements = value.requirements
  if (rawRequirements === null) return true
  const requirements = jsonObject(rawRequirements)
  if (!requirements) throw new Error('CODEX_NATIVE_CONFIG_REQUIREMENTS_INVALID')
  const allowed = requirements.allowAppshots
  if (allowed === undefined) return true
  if (typeof allowed !== 'boolean') throw new Error('CODEX_NATIVE_CONFIG_REQUIREMENTS_INVALID')
  return allowed
}

function jsonRpcError(value: unknown): { code: number; message: string } | undefined {
  const error = jsonObject(value)
  return error && typeof error.code === 'number' && typeof error.message === 'string'
    ? { code: error.code, message: error.message }
    : undefined
}

function nonEmptyText(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function windowsSandboxSetupMode(value: unknown): NativeCodexWindowsSandboxSetupMode {
  if (value === 'elevated' || value === 'unelevated') return value
  throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_MODE_INVALID')
}

function windowsSandboxReadiness(value: CodexNativeJsonObject): NativeCodexWindowsSandboxReadinessResponse {
  const status = value.status
  if (status === 'ready' || status === 'notConfigured' || status === 'updateRequired') return { status }
  throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_READINESS_INVALID')
}

function windowsSandboxSetupStarted(value: CodexNativeJsonObject): NativeCodexWindowsSandboxSetupStartResponse {
  if (typeof value.started !== 'boolean') throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_SETUP_RESPONSE_INVALID')
  return { started: value.started }
}

function absoluteDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('CODEX_NATIVE_PATH_INVALID')
  return path.resolve(value)
}

function routeKey(route: CodexNativeModelRoute): string {
  if (route.kind === 'managed') {
    return `managed\0${route.gatewayUrl}\0${route.model}\0${[...route.capabilities].sort().join(',')}`
  }
  // A profile can keep its id, endpoint and model while the user rotates its
  // secret or changes a Chat-adapter option. Keep only a non-reversible route
  // fingerprint in process memory, never the raw key, so the next idle use
  // cannot reuse a child started with stale provider capability.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(route.profile))
    .digest('base64url')
  return `personal\0${fingerprint}`
}

function supportedEngineTarget(
  platform = process.platform,
  arch = process.arch,
): 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc' {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  throw new Error(`CODEX_NATIVE_PLATFORM_UNSUPPORTED:${platform}/${arch}`)
}

async function privateDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_NATIVE_HOME_INVALID')
  return await fs.realpath(resolved)
}

function matchesEngineProductPatches(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === CODEX_ENGINE_PRODUCT_PATCHES.length
    && value.every((patch, index) => {
      const expected = CODEX_ENGINE_PRODUCT_PATCHES[index]
      const object = jsonObject(patch)
      if (!expected) return false
      return Object.keys(object ?? {}).length === 2
        && object?.file === expected.file
        && object?.sha256 === expected.sha256
    })
}

function binaryHashMode(value: unknown): value is BinaryHashMode {
  return value === 'sha256' || value === 'mach-o-code-signature-neutral-sha256'
}

async function hasVerifiedManagedBinary(
  directory: string,
  fileName: unknown,
  hashMode: unknown,
  expectedSha256: unknown,
  expectedSize: unknown,
): Promise<boolean> {
  if (
    typeof fileName !== 'string'
    || !binaryHashMode(hashMode)
    || typeof expectedSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || typeof expectedSize !== 'number'
    || !Number.isSafeInteger(expectedSize)
    || expectedSize < 1_000_000
  ) return false
  const candidate = path.join(directory, fileName)
  const stat = await fs.lstat(candidate)
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) return false
  if (hashMode === 'sha256' && stat.size !== expectedSize) return false
  const resolved = await fs.realpath(candidate)
  if (path.dirname(resolved) !== directory) return false
  return binaryIntegritySha256(await fs.readFile(resolved), hashMode) === expectedSha256
}

async function hasVerifiedNativeEngineManifest(
  directory: string,
  target: ReturnType<typeof supportedEngineTarget>,
  binaryName: string,
): Promise<boolean> {
  const manifestPath = path.join(directory, `agent-engine-manifest-${target}.json`)
  try {
    const stat = await fs.lstat(manifestPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return false
    const resolved = await fs.realpath(manifestPath)
    if (path.dirname(resolved) !== directory) return false
    const manifest = jsonObject(JSON.parse(await fs.readFile(resolved, 'utf8')))
    if (!(manifest?.schemaVersion === CODEX_ENGINE_MANIFEST_SCHEMA
      && manifest.engine === BILLIARDBUDDY_AGENT_ENGINE_NAME
      && manifest.sourceRepository === CODEX_ENGINE_SOURCE_REPOSITORY
      && manifest.sourceRevision === CODEX_ENGINE_SOURCE_REVISION
      && manifest.target === target
      && manifest.binary === binaryName
      && manifest.codeModeHost === `${CODEX_CODE_MODE_HOST_NAME}${target.includes('windows') ? '.exe' : ''}`
      && manifest.ripgrep === `${target.includes('windows') ? 'rg.exe' : 'rg'}`
      && matchesEngineProductPatches(manifest.productPatches))) return false
    if (!await hasVerifiedManagedBinary(
      directory,
      manifest.binary,
      manifest.binaryHashMode,
      manifest.binarySha256,
      manifest.binarySize,
    )) return false
    if (!await hasVerifiedManagedBinary(
      directory,
      manifest.codeModeHost,
      manifest.codeModeHostHashMode,
      manifest.codeModeHostSha256,
      manifest.codeModeHostSize,
    )) return false
    if (!await hasVerifiedManagedBinary(
      directory,
      manifest.ripgrep,
      manifest.ripgrepHashMode,
      manifest.ripgrepSha256,
      manifest.ripgrepSize,
    )) return false
    if (!target.includes('windows')) return manifest.windowsSandboxHelpers === undefined
    const helpers = manifest.windowsSandboxHelpers
    if (!Array.isArray(helpers) || helpers.length !== WINDOWS_SANDBOX_HELPER_FILENAMES.length) return false
    return await Promise.all(helpers.map(async (helper, index) => {
      const expectedName = WINDOWS_SANDBOX_HELPER_FILENAMES[index]
      const entry = jsonObject(helper)
      if (
        !expectedName
        || entry?.name !== expectedName
        || typeof entry.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || typeof entry.size !== 'number'
        || !Number.isSafeInteger(entry.size)
        || entry.size < 64 * 1024
      ) return false
      const helperPath = path.join(directory, expectedName)
      const helperStat = await fs.lstat(helperPath)
      if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.size !== entry.size) return false
      return createHash('sha256').update(await fs.readFile(helperPath)).digest('hex') === entry.sha256
    })).then(values => values.every(Boolean))
  } catch {
    return false
  }
}

async function nativeAppServerCommand(desktopRoot: string): Promise<string[]> {
  const target = supportedEngineTarget()
  const extension = process.platform === 'win32' ? '.exe' : ''
  const binaryDirectory = path.join(absoluteDirectory(desktopRoot), 'runtime-assets', 'binaries')
  const directory = await fs.realpath(binaryDirectory)
  const binary = path.join(directory, `billiardbuddy-agent-engine-${target}${extension}`)
  const stat = await fs.lstat(binary)
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) {
    throw new Error('CODEX_NATIVE_BINARY_UNAVAILABLE')
  }
  const resolved = await fs.realpath(binary)
  if (path.dirname(resolved) !== directory) throw new Error('CODEX_NATIVE_BINARY_UNAVAILABLE')
  if (!await hasVerifiedNativeEngineManifest(directory, target, path.basename(binary))) {
    throw new Error('CODEX_NATIVE_BINARY_UNAVAILABLE')
  }
  return [resolved]
}

function childEnvironment(
  input: Readonly<Record<string, string>>,
  managedBinaryDirectory?: string,
): Record<string, string> {
  // This is the same non-secret ambient set that the pinned Rust Core calls
  // its `ShellEnvironmentPolicyInherit::Core` environment.  The App Server
  // itself deliberately does not inherit Electron's complete environment,
  // but its native shell tools still need a real user home/profile, shell and
  // platform tool locations for ordinary git, package-manager and PowerShell
  // workflows. Loopback model capability tokens remain explicit `input`
  // values and are removed again by the Core shell KEY/SECRET/TOKEN exclusion
  // policy.
  const inheritedKeys = process.platform === 'win32'
    ? [
      'PATH', 'PATHEXT', 'SHELL', 'ComSpec', 'SystemRoot', 'SystemDrive',
      'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData',
      'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'POWERSHELL', 'PWSH',
    ]
    : ['PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER']
  const environment: Record<string, string> = {}
  for (const key of inheritedKeys) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  for (const [key, value] of Object.entries(input)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) environment[key] = value
  }
  if (managedBinaryDirectory) {
    const separator = process.platform === 'win32' ? ';' : ':'
    environment.PATH = environment.PATH
      ? `${managedBinaryDirectory}${separator}${environment.PATH}`
      : managedBinaryDirectory
  }
  return environment
}

function threadId(value: CodexNativeJsonObject): string {
  const thread = jsonObject(value.thread)
  if (!nonEmptyText(thread?.id)) throw new Error('CODEX_NATIVE_THREAD_RESPONSE_INVALID')
  return thread.id
}

function turnId(value: CodexNativeJsonObject): string {
  const turn = jsonObject(value.turn)
  if (!nonEmptyText(turn?.id)) throw new Error('CODEX_NATIVE_TURN_RESPONSE_INVALID')
  return turn.id
}

function permissionModeFromThreadResponse(value: CodexNativeJsonObject): NativeCodexPermissionMode {
  // The App Server serializes the effective legacy policy alongside the
  // canonical permission profile. Use the effective policy because that is
  // what the Rust Core will actually enforce for the next turn.
  const sandboxType = jsonObject(value.sandbox)?.type
  if (sandboxType === 'dangerFullAccess' && value.approvalPolicy === 'never') return 'full-access'
  if (
    sandboxType === 'workspaceWrite'
    && value.approvalPolicy === 'on-request'
    && value.approvalsReviewer === 'auto_review'
  ) return 'approve-for-me'
  return 'ask'
}

function sourceThreadParentId(thread: CodexNativeJsonObject): string | undefined {
  if (nonEmptyText(thread.parentThreadId, 200)) return thread.parentThreadId
  if (nonEmptyText(thread.forkedFromId, 200)) return thread.forkedFromId
  const source = jsonObject(thread.source)
  const subAgent = jsonObject(source?.subAgent)
  const spawn = jsonObject(subAgent?.thread_spawn) ?? jsonObject(subAgent?.threadSpawn)
  const nested = spawn?.parent_thread_id ?? spawn?.parentThreadId
  return nonEmptyText(nested, 200) ? nested : undefined
}

function sourceActiveTurnIds(value: CodexNativeJsonObject): string[] {
  const thread = jsonObject(value.thread)
  const initialPage = jsonObject(value.initialTurnsPage)
  const candidates = [
    ...(Array.isArray(thread?.turns) ? thread.turns : []),
    ...(Array.isArray(initialPage?.data) ? initialPage.data : []),
  ]
  const ids: string[] = []
  for (const candidate of candidates) {
    const turn = jsonObject(candidate)
    if (turn?.status !== 'inProgress' || !nonEmptyText(turn.id, 200) || ids.includes(turn.id)) continue
    ids.push(turn.id)
  }
  return ids
}

/**
 * Project only the Thread fields the desktop host must own. The Rust response
 * remains authoritative for history and live Turn status.
 */
export function projectNativeCodexThreadResponse(value: CodexNativeJsonObject): NativeCodexThread {
  const thread = jsonObject(value.thread)
  const id = threadId(value)
  const parentThreadId = thread ? sourceThreadParentId(thread) : undefined
  const turnsBackwardsCursor = nonEmptyText(value.turnsBackwardsCursor, 4_096)
    ? value.turnsBackwardsCursor
    : undefined
  const itemsBackwardsCursor = nonEmptyText(value.itemsBackwardsCursor, 4_096)
    ? value.itemsBackwardsCursor
    : undefined
  return {
    id,
    permissionMode: permissionModeFromThreadResponse(value),
    activeTurnIds: sourceActiveTurnIds(value),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(turnsBackwardsCursor === undefined ? {} : { turnsBackwardsCursor }),
    ...(itemsBackwardsCursor === undefined ? {} : { itemsBackwardsCursor }),
  }
}

function nativePermissionSettings(mode: NativeCodexPermissionMode): {
  sandbox: 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'on-request' | 'never'
  approvalsReviewer: 'user' | 'auto_review'
} {
  switch (mode) {
    case 'ask':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
    case 'approve-for-me':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    case 'full-access':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }
  }
}

/** `thread/settings/update` uses the v2 tagged SandboxPolicy, not SandboxMode. */
function nativeSandboxPolicy(mode: NativeCodexPermissionMode): CodexNativeJsonObject {
  return mode === 'full-access'
    ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite' }
}

function nativeCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!nonEmptyText(value, 4_096) || /[\u0000\r\n]/.test(value)) throw new Error('CODEX_NATIVE_CURSOR_INVALID')
  return value
}

function nativePageLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error('CODEX_NATIVE_PAGE_LIMIT_INVALID')
  }
  return value
}

function nativeSortDirection(value: unknown): 'asc' | 'desc' | undefined {
  if (value === undefined) return undefined
  if (value !== 'asc' && value !== 'desc') throw new Error('CODEX_NATIVE_SORT_DIRECTION_INVALID')
  return value
}

function nativeThreadListSortKey(value: unknown): 'created_at' | 'updated_at' | 'recency_at' | undefined {
  if (value === undefined) return undefined
  if (value !== 'created_at' && value !== 'updated_at' && value !== 'recency_at') {
    throw new Error('CODEX_NATIVE_THREAD_SORT_KEY_INVALID')
  }
  return value
}

const NATIVE_THREAD_SOURCE_KINDS = new Set<NativeCodexThreadSourceKind>([
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
])

function nativeThreadSourceKinds(value: unknown): NativeCodexThreadSourceKind[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > NATIVE_THREAD_SOURCE_KINDS.size) {
    throw new Error('CODEX_NATIVE_THREAD_SOURCE_KINDS_INVALID')
  }
  const kinds = value.map(kind => {
    if (typeof kind !== 'string' || !NATIVE_THREAD_SOURCE_KINDS.has(kind as NativeCodexThreadSourceKind)) {
      throw new Error('CODEX_NATIVE_THREAD_SOURCE_KINDS_INVALID')
    }
    return kind as NativeCodexThreadSourceKind
  })
  if (new Set(kinds).size !== kinds.length) throw new Error('CODEX_NATIVE_THREAD_SOURCE_KINDS_INVALID')
  return kinds
}

function nativeThreadRelationId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!nonEmptyText(value, 200) || /[\u0000\r\n]/.test(value)) {
    throw new Error('CODEX_NATIVE_THREAD_RELATION_ID_INVALID')
  }
  return value
}

function nativeThreadSectionFilter(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  if (!nonEmptyText(value, 200) || /[\u0000\r\n]/.test(value)) {
    throw new Error('CODEX_NATIVE_THREAD_SECTION_ID_INVALID')
  }
  return value.trim()
}

function nativeMetadataLine(value: unknown, limit: number): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.length > limit || /[\u0000\r\n]/.test(value) || !value.trim()) {
    throw new Error('CODEX_NATIVE_THREAD_METADATA_INVALID')
  }
  return value.trim()
}

function nativeThreadMetadataGitInfo(
  value: NativeCodexThreadMetadataGitInfoUpdate,
): NativeCodexThreadMetadataGitInfoUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_NATIVE_THREAD_METADATA_INVALID')
  }
  const sha = nativeMetadataLine(value.sha, 128)
  const branch = nativeMetadataLine(value.branch, 1_024)
  const originUrl = nativeMetadataLine(value.originUrl, 4_096)
  if (sha === undefined && branch === undefined && originUrl === undefined) {
    throw new Error('CODEX_NATIVE_THREAD_METADATA_INVALID')
  }
  return {
    ...(sha === undefined ? {} : { sha }),
    ...(branch === undefined ? {} : { branch }),
    ...(originUrl === undefined ? {} : { originUrl }),
  }
}

function nativeThreadSettingsPatch(value: NativeCodexThreadSettingsPatch): CodexNativeJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_NATIVE_THREAD_SETTINGS_INVALID')
  }
  let permissionProfileId: string | undefined
  if (value.permissionProfileId !== undefined) {
    if (!nonEmptyText(value.permissionProfileId, 200) || /[\u0000\r\n]/.test(value.permissionProfileId)) {
      throw new Error('CODEX_NATIVE_PERMISSION_PROFILE_INVALID')
    }
    permissionProfileId = value.permissionProfileId.trim()
  }
  let effort: string | undefined
  if (value.effort !== undefined) {
    if (!nonEmptyText(value.effort, 64) || !/^[A-Za-z0-9_-]+$/.test(value.effort)) {
      throw new Error('CODEX_NATIVE_REASONING_EFFORT_INVALID')
    }
    effort = value.effort
  }
  const summary = value.summary
  if (summary !== undefined && summary !== 'auto' && summary !== 'concise' && summary !== 'detailed' && summary !== 'none') {
    throw new Error('CODEX_NATIVE_REASONING_SUMMARY_INVALID')
  }
  const personality = value.personality
  if (personality !== undefined && personality !== 'none' && personality !== 'friendly' && personality !== 'pragmatic') {
    throw new Error('CODEX_NATIVE_PERSONALITY_INVALID')
  }
  if (permissionProfileId === undefined && effort === undefined && summary === undefined && personality === undefined) {
    throw new Error('CODEX_NATIVE_THREAD_SETTINGS_INVALID')
  }
  return {
    ...(permissionProfileId === undefined ? {} : { permissions: permissionProfileId }),
    ...(effort === undefined ? {} : { effort }),
    ...(summary === undefined ? {} : { summary }),
    ...(personality === undefined ? {} : { personality }),
  }
}

function projectedString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 4_096 && !value.includes('\u0000') ? value : null
}

function projectedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function projectedBoolean(value: unknown): boolean {
  return value === true
}

function projectedApprovalPolicy(value: unknown): CodexNativeJsonValue {
  if (value === 'untrusted' || value === 'on-request' || value === 'never') return value
  const granular = jsonObject(jsonObject(value)?.granular)
  if (!granular) return null
  const keys = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'] as const
  if (Object.keys(granular).some(key => !keys.includes(key as typeof keys[number]))) return null
  if (keys.some(key => typeof granular[key] !== 'boolean')) return null
  return { granular: Object.fromEntries(keys.map(key => [key, granular[key]])) as CodexNativeJsonObject }
}

function projectedConfigLayerSource(value: unknown): string {
  const type = jsonObject(value)?.type
  return typeof type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(type) ? type : 'unknown'
}

const PROJECTED_CONFIG_ORIGINS = new Map<string, keyof NativeCodexClientSettingsProjection>([
  ['model', 'model'],
  ['model_provider', 'modelProvider'],
  ['model_context_window', 'modelContextWindow'],
  ['model_auto_compact_token_limit', 'modelAutoCompactTokenLimit'],
  ['model_auto_compact_token_limit_scope', 'modelAutoCompactTokenLimitScope'],
  ['approval_policy', 'approvalPolicy'],
  ['sandbox_mode', 'sandboxMode'],
  ['web_search', 'webSearch'],
  ['model_reasoning_effort', 'reasoningEffort'],
  ['model_reasoning_summary', 'reasoningSummary'],
  ['model_verbosity', 'verbosity'],
  ['service_tier', 'serviceTier'],
  ['features.memories', 'memoryFeatureEnabled'],
  ['memories.use_memories', 'memoryUseEnabled'],
  ['memories.generate_memories', 'memoryGenerationEnabled'],
])

/**
 * Strip instructions, arbitrary additional config, layer bodies, MCP values
 * and every unknown field before any effective Core settings reach Renderer.
 */
export function projectNativeCodexClientSettings(value: unknown): NativeCodexClientSettingsProjection {
  const response = jsonObject(value)
  const config = jsonObject(response?.config)
  if (!response || !config) throw new Error('CODEX_NATIVE_CONFIG_RESPONSE_INVALID')
  const features = jsonObject(config.features)
  const memories = jsonObject(config.memories)

  const origins: NativeCodexClientSettingsProjection['origins'] = {}
  const rawOrigins = jsonObject(response.origins)
  if (rawOrigins) {
    for (const [sourceField, productField] of PROJECTED_CONFIG_ORIGINS) {
      const metadata = jsonObject(rawOrigins[sourceField])
      if (!metadata) continue
      const version = projectedString(metadata.version)
      if (version === null) continue
      origins[String(productField)] = {
        source: projectedConfigLayerSource(metadata.name),
        version,
      }
    }
  }

  const layers: NativeCodexClientSettingsProjection['layers'] = []
  if (Array.isArray(response.layers)) {
    for (const candidate of response.layers) {
      const layer = jsonObject(candidate)
      if (!layer) continue
      const version = projectedString(layer.version)
      if (version === null) continue
      layers.push({
        source: projectedConfigLayerSource(layer.name),
        version,
        disabledReason: projectedString(layer.disabledReason),
      })
    }
  }

  return {
    model: projectedString(config.model),
    modelProvider: projectedString(config.model_provider),
    modelContextWindow: projectedInteger(config.model_context_window),
    modelAutoCompactTokenLimit: projectedInteger(config.model_auto_compact_token_limit),
    modelAutoCompactTokenLimitScope: projectedString(config.model_auto_compact_token_limit_scope),
    approvalPolicy: projectedApprovalPolicy(config.approval_policy),
    sandboxMode: projectedString(config.sandbox_mode),
    webSearch: projectedString(config.web_search),
    reasoningEffort: projectedString(config.model_reasoning_effort),
    reasoningSummary: projectedString(config.model_reasoning_summary),
    verbosity: projectedString(config.model_verbosity),
    serviceTier: projectedString(config.service_tier),
    memoryFeatureEnabled: projectedBoolean(features?.memories),
    memoryUseEnabled: projectedBoolean(memories?.use_memories),
    memoryGenerationEnabled: projectedBoolean(memories?.generate_memories),
    origins,
    layers,
  }
}

function nativeThreadSearchTerm(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!nonEmptyText(value, 512) || /[\u0000\r\n]/.test(value)) throw new Error('CODEX_NATIVE_THREAD_SEARCH_INVALID')
  return value.trim()
}

function nativeTurnItemsView(value: unknown): 'notLoaded' | 'summary' | 'full' | undefined {
  if (value === undefined) return undefined
  if (value !== 'notLoaded' && value !== 'summary' && value !== 'full') {
    throw new Error('CODEX_NATIVE_TURN_ITEMS_VIEW_INVALID')
  }
  return value
}

function nativeThreadGoalStatus(value: unknown): NativeCodexThreadGoalStatus | undefined {
  if (value === undefined) return undefined
  if (
    value === 'active'
    || value === 'paused'
    || value === 'blocked'
    || value === 'usageLimited'
    || value === 'budgetLimited'
    || value === 'complete'
  ) return value
  throw new Error('CODEX_NATIVE_THREAD_GOAL_STATUS_INVALID')
}

function nativeThreadGoalObjective(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_000 || value.includes('\u0000')) {
    throw new Error('CODEX_NATIVE_THREAD_GOAL_INVALID')
  }
  const trimmed = value.trim()
  if (!trimmed) throw new Error('CODEX_NATIVE_THREAD_GOAL_INVALID')
  return trimmed
}

function nativeThreadGoalSetInput(value: NativeCodexThreadGoalSetInput): NativeCodexThreadGoalSetInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_NATIVE_THREAD_GOAL_INVALID')
  }
  const objective = value.objective === undefined
    ? undefined
    : nativeThreadGoalObjective(value.objective)
  const status = nativeThreadGoalStatus(value.status)
  let tokenBudget: number | null | undefined
  if (value.tokenBudget === undefined) tokenBudget = undefined
  else if (value.tokenBudget === null) tokenBudget = null
  else if (typeof value.tokenBudget === 'number' && Number.isSafeInteger(value.tokenBudget) && value.tokenBudget >= 0) {
    tokenBudget = value.tokenBudget
  } else {
    throw new Error('CODEX_NATIVE_THREAD_GOAL_TOKEN_BUDGET_INVALID')
  }
  if (objective === undefined && status === undefined && tokenBudget === undefined) {
    throw new Error('CODEX_NATIVE_THREAD_GOAL_INVALID')
  }
  return {
    ...(objective === undefined ? {} : { objective }),
    ...(status === undefined ? {} : { status }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  }
}

function nativeBackgroundTerminalProcessId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error('CODEX_NATIVE_BACKGROUND_TERMINAL_ID_INVALID')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error('CODEX_NATIVE_BACKGROUND_TERMINAL_ID_INVALID')
  }
  return value
}

function nativeOperationId(value: unknown, error: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) throw new Error(error)
  return value
}

function nativeTerminalSize(value: unknown): NativeCodexTerminalSize {
  const size = jsonObject(value)
  if (
    typeof size?.rows !== 'number'
    || !Number.isSafeInteger(size.rows)
    || size.rows < 1
    || size.rows > 1_000
    || typeof size.cols !== 'number'
    || !Number.isSafeInteger(size.cols)
    || size.cols < 1
    || size.cols > 1_000
  ) throw new Error('CODEX_NATIVE_TERMINAL_SIZE_INVALID')
  return { rows: size.rows, cols: size.cols }
}

function nativeTerminalCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error('CODEX_NATIVE_TERMINAL_COMMAND_INVALID')
  }
  return value.map(argument => {
    if (typeof argument !== 'string' || argument.length === 0 || argument.length > 4_096 || argument.includes('\u0000')) {
      throw new Error('CODEX_NATIVE_TERMINAL_COMMAND_INVALID')
    }
    return argument
  })
}

function nativeFuzzyQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || value.includes('\u0000')) {
    throw new Error('CODEX_NATIVE_FUZZY_QUERY_INVALID')
  }
  return value
}

function projectCommandExecResponse(value: CodexNativeJsonObject): NativeCodexCommandExecResponse {
  if (
    typeof value.exitCode !== 'number'
    || !Number.isSafeInteger(value.exitCode)
    || typeof value.stdout !== 'string'
    || typeof value.stderr !== 'string'
  ) throw new Error('CODEX_NATIVE_COMMAND_EXEC_RESPONSE_INVALID')
  return { exitCode: value.exitCode, stdout: value.stdout, stderr: value.stderr }
}

function projectFuzzyFileSearchResponse(value: CodexNativeJsonObject): { files: NativeCodexFuzzyFileSearchResult[] } {
  if (!Array.isArray(value.files) || value.files.length > 2_000) {
    throw new Error('CODEX_NATIVE_FUZZY_RESPONSE_INVALID')
  }
  const files = value.files.map(candidate => {
    const item = jsonObject(candidate)
    if (
      !item
      || !nonEmptyText(item.root, 4_096)
      || !nonEmptyText(item.path, 4_096)
      || (item.matchType !== 'file' && item.matchType !== 'directory')
      || !nonEmptyText(item.fileName, 4_096)
      || typeof item.score !== 'number'
      || !Number.isSafeInteger(item.score)
      || item.score < 0
      || (item.indices !== undefined && (
        !Array.isArray(item.indices)
        || item.indices.length > 4_096
        || !item.indices.every(index => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0)
      ))
    ) throw new Error('CODEX_NATIVE_FUZZY_RESPONSE_INVALID')
    const matchType: NativeCodexFuzzyFileSearchResult['matchType'] = item.matchType
    return {
      root: item.root,
      path: item.path,
      matchType,
      fileName: item.fileName,
      score: item.score,
      ...(item.indices === undefined ? {} : { indices: [...item.indices] as number[] }),
    }
  })
  return { files }
}

function nativeReviewLine(value: unknown, limit: number, error: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit || /[\u0000\r\n]/.test(value)) {
    throw new Error(error)
  }
  const trimmed = value.trim()
  if (!trimmed) throw new Error(error)
  return trimmed
}

function nativeReviewTarget(value: NativeCodexReviewTarget): NativeCodexReviewTarget {
  if (!value || typeof value !== 'object') throw new Error('CODEX_NATIVE_REVIEW_TARGET_INVALID')
  switch (value.type) {
    case 'uncommittedChanges':
      return { type: 'uncommittedChanges' }
    case 'baseBranch':
      return { type: 'baseBranch', branch: nativeReviewLine(value.branch, 512, 'CODEX_NATIVE_REVIEW_TARGET_INVALID') }
    case 'commit':
      return {
        type: 'commit',
        sha: nativeReviewLine(value.sha, 512, 'CODEX_NATIVE_REVIEW_TARGET_INVALID'),
        ...(value.title === undefined ? {} : { title: nativeReviewLine(value.title, 512, 'CODEX_NATIVE_REVIEW_TARGET_INVALID') }),
      }
    case 'custom':
      if (typeof value.instructions !== 'string' || value.instructions.length === 0 || value.instructions.length > (1 << 20) || value.instructions.includes('\u0000')) {
        throw new Error('CODEX_NATIVE_REVIEW_TARGET_INVALID')
      }
      if (!value.instructions.trim()) throw new Error('CODEX_NATIVE_REVIEW_TARGET_INVALID')
      return { type: 'custom', instructions: value.instructions.trim() }
    default:
      throw new Error('CODEX_NATIVE_REVIEW_TARGET_INVALID')
  }
}

function nativeReviewDelivery(value: NativeCodexReviewDelivery | undefined): NativeCodexReviewDelivery | undefined {
  if (value === undefined || value === 'inline' || value === 'detached') return value
  throw new Error('CODEX_NATIVE_REVIEW_DELIVERY_INVALID')
}

function nativeCollaborationMode(value: NativeCodexCollaborationMode | undefined): NativeCodexCollaborationMode | undefined {
  if (value === undefined || value === 'default' || value === 'plan') return value
  throw new Error('CODEX_NATIVE_COLLABORATION_MODE_INVALID')
}

function nativeCollaborationSettings(
  mode: NativeCodexCollaborationMode,
  model: string,
): CodexNativeJsonObject {
  if (!nonEmptyText(model, 200)) throw new Error('CODEX_NATIVE_COLLABORATION_MODEL_INVALID')
  return {
    mode,
    settings: {
      model,
      // This is deliberately null instead of a BilliardBuddy prompt. The
      // upstream App Server expands it to its own built-in mode instructions.
      developer_instructions: null,
      reasoning_effort: mode === 'plan' ? 'medium' : null,
    },
  }
}

function nativeTextElements(text: string, value: unknown): NativeCodexTextElement[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 256) throw new Error('CODEX_NATIVE_TEXT_ELEMENTS_INVALID')
  const boundaries = new Set<number>([0])
  let byteOffset = 0
  for (const character of text) {
    byteOffset += Buffer.byteLength(character)
    boundaries.add(byteOffset)
  }
  let previousEnd = 0
  return value.map(elementValue => {
    const element = jsonObject(elementValue)
    const range = jsonObject(element?.byteRange)
    const start = range?.start
    const end = range?.end
    const placeholder = element?.placeholder
    if (
      typeof start !== 'number'
      || !Number.isSafeInteger(start)
      || typeof end !== 'number'
      || !Number.isSafeInteger(end)
      || start < previousEnd
      || start < 0
      || end <= start
      || end > byteOffset
      || !boundaries.has(start)
      || !boundaries.has(end)
      || (placeholder !== undefined && (
        typeof placeholder !== 'string'
        || placeholder.length > 1_024
        || placeholder.includes('\u0000')
      ))
    ) throw new Error('CODEX_NATIVE_TEXT_ELEMENTS_INVALID')
    previousEnd = end
    return {
      byteRange: { start, end },
      ...(placeholder === undefined ? {} : { placeholder }),
    }
  })
}

function nativeAdditionalContext(value: NativeCodexAdditionalContext | undefined): CodexNativeJsonObject | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CODEX_NATIVE_ADDITIONAL_CONTEXT_INVALID')
  }
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 32) throw new Error('CODEX_NATIVE_ADDITIONAL_CONTEXT_INVALID')
  let totalBytes = 0
  const projected: CodexNativeJsonObject = {}
  for (const [source, rawEntry] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source)) {
      throw new Error('CODEX_NATIVE_ADDITIONAL_CONTEXT_INVALID')
    }
    const entry = jsonObject(rawEntry)
    if (
      !entry
      || (entry.kind !== 'untrusted' && entry.kind !== 'application')
      || typeof entry.value !== 'string'
      || entry.value.length === 0
      || entry.value.includes('\u0000')
    ) throw new Error('CODEX_NATIVE_ADDITIONAL_CONTEXT_INVALID')
    totalBytes += Buffer.byteLength(source) + Buffer.byteLength(entry.value)
    if (totalBytes > (1 << 20)) throw new Error('CODEX_NATIVE_ADDITIONAL_CONTEXT_INVALID')
    projected[source] = { value: entry.value, kind: entry.kind }
  }
  return projected
}

function validateTurnInput(value: NativeCodexTurnInput): boolean {
  if (value.type === 'text') {
    if (!nonEmptyText(value.text, 1 << 20)) return false
    try {
      nativeTextElements(value.text, value.textElements)
      return true
    } catch {
      return false
    }
  }
  const validDetail = (detail: unknown) => detail === undefined || ['auto', 'low', 'high', 'original'].includes(String(detail))
  if (value.type === 'image') {
    return nonEmptyText(value.url, 32 * 1024 * 1024)
      && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.url)
      && validDetail(value.detail)
  }
  if (value.type === 'localImage') {
    return nonEmptyText(value.path, 4_096) && path.isAbsolute(value.path) && !/[\u0000\r\n]/.test(value.path) && validDetail(value.detail)
  }
  if (value.type === 'audio') {
    return nonEmptyText(value.url, 64 * 1024 * 1024)
      && /^data:audio\/(?:wav|mpeg|mp4|webm|ogg);base64,[A-Za-z0-9+/=]+$/.test(value.url)
  }
  if (value.type === 'localAudio') {
    return nonEmptyText(value.path, 4_096) && path.isAbsolute(value.path) && !/[\u0000\r\n]/.test(value.path)
  }
  if (value.type === 'skill') {
    return nonEmptyText(value.name, 512) && !/[\u0000\r\n]/.test(value.name)
      && nonEmptyText(value.path, 4_096) && path.isAbsolute(value.path) && path.basename(value.path) === 'SKILL.md'
  }
  return value.type === 'mention'
    && nonEmptyText(value.name, 512) && !/[\u0000\r\n]/.test(value.name)
    && nonEmptyText(value.path, 4_096) && /^(?:app|plugin):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/.test(value.path)
}

function pathInside(file: string, root: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function recognizedImageHeader(header: Buffer): boolean {
  return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || header.subarray(0, 6).toString('ascii') === 'GIF87a'
    || header.subarray(0, 6).toString('ascii') === 'GIF89a'
    || (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP')
}

function recognizedAudioHeader(file: string, header: Buffer): boolean {
  const extension = path.extname(file).toLowerCase()
  if (extension === '.wav') {
    return header.subarray(0, 4).toString('ascii') === 'RIFF'
      && header.subarray(8, 12).toString('ascii') === 'WAVE'
  }
  if (extension === '.mp3') {
    return header.subarray(0, 3).toString('ascii') === 'ID3'
      || (header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0)
  }
  if (extension === '.m4a') return header.subarray(4, 8).toString('ascii') === 'ftyp'
  if (extension === '.webm') return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (extension === '.ogg') return header.subarray(0, 4).toString('ascii') === 'OggS'
  return false
}

function nativeMcpServerName(value: string): string {
  if (!NATIVE_MCP_SERVER_NAME.test(value)) throw new Error('CODEX_NATIVE_MCP_SERVER_NAME_INVALID')
  return value
}

function nativeJsonValue(value: unknown, depth = 0): value is CodexNativeJsonValue {
  if (depth > 16 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 16
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => nativeJsonValue(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const entries = Object.entries(record)
  return entries.length <= 256
    && entries.every(([key, item]) => (
      key.length > 0
      && key.length <= 256
      && key !== '__proto__'
      && key !== 'constructor'
      && key !== 'prototype'
      && nativeJsonValue(item, depth + 1)
    ))
}

function nativeMcpConfig(value: unknown): NativeCodexMcpServerConfig {
  const config = jsonObject(value)
  if (!config || !nativeJsonValue(config) || Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) {
    throw new Error('CODEX_NATIVE_MCP_CONFIGURATION_INVALID')
  }
  return config
}

function nativeSkillSelector(value: NativeCodexSkillSelector): NativeCodexSkillSelector {
  const name = value.name
  const skillPath = value.path
  if (
    (typeof name === 'string' && nonEmptyText(name.trim(), 512) && skillPath === undefined)
    || (typeof skillPath === 'string' && nonEmptyText(skillPath, 4_096) && path.isAbsolute(skillPath) && !/[\u0000\r\n]/.test(skillPath) && name === undefined)
  ) {
    return name === undefined ? { path: skillPath } : { name: name.trim() }
  }
  throw new Error('CODEX_NATIVE_SKILL_SELECTOR_INVALID')
}

function nativePluginText(value: string, maximum: number, error: string): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000\r\n]/.test(value) || !value.trim()) {
    throw new Error(error)
  }
  return value.trim()
}

type NativeCodexListedHook = {
  key: string
  currentHash: string
  trustStatus: 'managed' | 'untrusted' | 'trusted' | 'modified'
}

function nativeHookTrustText(value: unknown, maximum: number, error: string): string {
  if (!nonEmptyText(value, maximum) || value.trim() !== value || /[\u0000\r\n]/.test(value)) {
    throw new Error(error)
  }
  return value
}

function listedNativeHook(
  response: CodexNativeJsonObject,
  hookKey: string,
  currentHash: string,
): NativeCodexListedHook {
  if (!Array.isArray(response.data)) throw new Error('CODEX_NATIVE_HOOK_LIST_INVALID')
  const hooks: NativeCodexListedHook[] = []
  for (const entry of response.data) {
    const group = jsonObject(entry)
    if (!group || !Array.isArray(group.hooks)) throw new Error('CODEX_NATIVE_HOOK_LIST_INVALID')
    for (const rawHook of group.hooks) {
      const hook = jsonObject(rawHook)
      const key = hook?.key
      const hash = hook?.currentHash
      const trustStatus = hook?.trustStatus
      if (
        !nonEmptyText(key, 4_096)
        || !nonEmptyText(hash, 1_024)
        || (trustStatus !== 'managed' && trustStatus !== 'untrusted' && trustStatus !== 'trusted' && trustStatus !== 'modified')
      ) throw new Error('CODEX_NATIVE_HOOK_LIST_INVALID')
      hooks.push({ key, currentHash: hash, trustStatus })
    }
  }
  const matching = hooks.filter(hook => hook.key === hookKey && hook.currentHash === currentHash)
  const match = matching[0]
  if (matching.length !== 1 || !match) throw new Error('CODEX_NATIVE_HOOK_TRUST_STALE')
  return match
}

function nativeMarketplaceAddInput(value: NativeCodexMarketplaceAddInput): NativeCodexMarketplaceAddInput {
  const source = nativePluginText(value.source, 4_096, 'CODEX_NATIVE_MARKETPLACE_SOURCE_INVALID')
  const refName = value.refName === undefined
    ? undefined
    : nativePluginText(value.refName, 512, 'CODEX_NATIVE_MARKETPLACE_REF_INVALID')
  if (value.sparsePaths === undefined) return { source, ...(refName === undefined ? {} : { refName }) }
  if (!Array.isArray(value.sparsePaths) || value.sparsePaths.length > 64) {
    throw new Error('CODEX_NATIVE_MARKETPLACE_SPARSE_PATHS_INVALID')
  }
  return {
    source,
    ...(refName === undefined ? {} : { refName }),
    sparsePaths: value.sparsePaths.map(item => nativePluginText(item, 4_096, 'CODEX_NATIVE_MARKETPLACE_SPARSE_PATHS_INVALID')),
  }
}

function nativePluginReference(value: NativeCodexPluginReference): NativeCodexPluginReference {
  if (!path.isAbsolute(value.marketplacePath)) throw new Error('CODEX_NATIVE_PLUGIN_MARKETPLACE_PATH_INVALID')
  return {
    marketplacePath: nativePluginText(value.marketplacePath, 4_096, 'CODEX_NATIVE_PLUGIN_MARKETPLACE_PATH_INVALID'),
    pluginName: nativePluginText(value.pluginName, 512, 'CODEX_NATIVE_PLUGIN_NAME_INVALID'),
  }
}

/**
 * Electron-Main JSON-RPC client for the official Codex App Server.
 *
 * It speaks the source's JSONL stdio transport directly. There is no Bun
 * Product Server, local HTTP bridge, retired task state, or legacy permission
 * envelope on this path.
 */
export class CodexNativeAppServerClient {
  private process?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private closed = false
  private unavailableSignaled = false

  constructor(private readonly options: CodexNativeAppServerClientOptions) {}

  async start(): Promise<void> {
    if (this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_ALREADY_STARTED')
    if (this.options.command.length === 0 || this.options.command.some(value => !nonEmptyText(value, 4_096))) {
      throw new Error('CODEX_NATIVE_APP_SERVER_COMMAND_INVALID')
    }
    const command = this.options.command[0]!
    const engineHome = await privateDirectory(this.options.engineHome)
    const environment = childEnvironment(
      { ...this.options.environment, CODEX_HOME: engineHome },
      path.dirname(command),
    )
    const args = [
      ...this.options.command.slice(1),
      ...this.options.configOverrides.flatMap(value => ['--config', value]),
      '--listen',
      'stdio://',
    ]
    const child = spawn(command, args, {
      cwd: this.options.cwd ? absoluteDirectory(this.options.cwd) : engineHome,
      env: environment,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    })
    this.process = child
    void this.readStdout(child)
    void this.drainStderr(child).catch(() => undefined)
    child.once('error', error => {
      this.markUnavailable(child, engineError('CODEX_NATIVE_APP_SERVER_SPAWN_FAILED', error.message))
    })
    child.once('exit', (code, signal) => {
      this.markUnavailable(child, engineError('CODEX_NATIVE_APP_SERVER_EXITED', `code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
    try {
      const initialized = await this.request<CodexNativeJsonObject>('initialize', {
        clientInfo: { name: 'billiardbuddy', title: 'BilliardBuddy', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      if (initialized.codexHome !== engineHome) throw new Error('CODEX_NATIVE_APP_SERVER_HOME_MISMATCH')
      this.notify('initialized', {})
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async request<T extends CodexNativeJsonValue = CodexNativeJsonValue>(method: string, params?: CodexNativeJsonValue): Promise<T> {
    if (!nonEmptyText(method)) throw new Error('CODEX_NATIVE_APP_SERVER_METHOD_INVALID')
    if (!this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_UNAVAILABLE')
    const id = ++this.nextRequestId
    const result = new Promise<CodexNativeJsonValue>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return await result as T
  }

  /** True only while the BilliardBuddy-owned stdio child can accept RPC. */
  isAvailable(): boolean {
    return !this.closed && this.process !== undefined
  }

  notify(method: string, params?: CodexNativeJsonValue): void {
    if (!nonEmptyText(method)) throw new Error('CODEX_NATIVE_APP_SERVER_METHOD_INVALID')
    if (!this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_UNAVAILABLE')
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.process
    this.process = undefined
    this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_CLOSED'))
    if (!child) return
    try { child.stdin.end() } catch {}
    const exited = await Promise.race([
      new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), APP_SERVER_SHUTDOWN_WAIT_MS)),
    ])
    if (!exited) {
      try { child.kill() } catch {}
    }
  }

  /**
   * Electron's `before-quit` hook cannot await JSON-RPC. Kill only the
   * BilliardBuddy-owned child synchronously so closing the desktop app never
   * leaves an App Server process running against its private CODEX_HOME.
   */
  closeImmediately(): void {
    if (this.closed) return
    this.closed = true
    const child = this.process
    this.process = undefined
    this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_CLOSED'))
    if (!child) return
    try { child.stdin.destroy() } catch {}
    try { child.kill() } catch {}
  }

  private write(frame: CodexNativeJsonObject): void {
    const stdin = this.process?.stdin
    if (!stdin || stdin.destroyed) throw new Error('CODEX_NATIVE_APP_SERVER_STDIN_UNAVAILABLE')
    const serialized = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(serialized) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
    stdin.write(serialized)
  }

  private async readStdout(child: ChildProcessWithoutNullStreams): Promise<void> {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    try {
      for await (const chunk of child.stdout) {
        buffer += String(chunk)
        if (Buffer.byteLength(buffer) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
        let boundary: number
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          if (!line) continue
          if (Buffer.byteLength(line) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
          let message: unknown
          try { message = JSON.parse(line) } catch { throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID') }
          await this.handleMessage(message)
        }
      }
      if (buffer.trim()) throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    } catch (error) {
      this.markUnavailable(child, error instanceof Error ? error : engineError('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID'))
      try { child.kill() } catch {}
    }
  }

  private async drainStderr(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stderr.setEncoding('utf8')
    // Rust diagnostics can contain user-path or provider messages. Drain them
    // so the child cannot block, but do not retain or forward them as Agent
    // state or a renderer-visible error channel.
    for await (const _chunk of child.stderr) {}
  }

  private async handleMessage(value: unknown): Promise<void> {
    const message = jsonObject(value)
    if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) {
      throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      const error = message.error === undefined ? undefined : jsonRpcError(message.error)
      if (message.error !== undefined && !error) return pending.reject(engineError('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID'))
      if (error) return pending.reject(engineError('CODEX_NATIVE_APP_SERVER_REQUEST_FAILED', `${error.code} ${error.message}`))
      return pending.resolve(message.result ?? null)
    }
    if (!nonEmptyText(message.method)) throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    const notification: CodexNativeNotification = {
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') {
      await this.options.onNotification?.(notification)
      return
    }
    // Server requests are intentionally not awaited from the stdout reader.
    // A user can interrupt a Turn while an approval/input form is open; Rust
    // then emits `serverRequest/resolved`. Keeping the reader live is what
    // lets Main discard the pending UI request and continue streaming the
    // source-native lifecycle instead of deadlocking behind that form.
    void this.handleServerRequest({ ...notification, id: message.id })
  }

  private async handleServerRequest(request: CodexNativeServerRequest): Promise<void> {
    try {
      if (!this.options.onServerRequest) throw new Error('CODEX_NATIVE_APP_SERVER_REQUEST_UNHANDLED')
      const result = await this.options.onServerRequest(request)
      this.write({ jsonrpc: '2.0', id: request.id, result: result ?? {} })
    } catch (error) {
      const description = error instanceof Error ? error.message : 'CODEX_NATIVE_APP_SERVER_REQUEST_FAILED'
      try {
        this.write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: description } })
      } catch {}
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private markUnavailable(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process === child) this.process = undefined
    this.closed = true
    this.failAllPending(error)
    if (!this.unavailableSignaled) {
      this.unavailableSignaled = true
      try { this.options.onUnavailable?.(error) } catch {}
    }
  }
}

/**
 * Direct Thread/Turn owner for BilliardBuddy Agent.
 *
 * The upstream Rust Core persists Threads, Items, compactions, approvals,
 * forks and recovery below this object's private `CODEX_HOME`. This manager
 * holds only process handles and a non-secret route identity while alive.
 */
export class ElectronCodexNativeRuntime {
  private client?: CodexNativeAppServerClient
  private provider?: StartedCodexNativeProvider
  private configuredRouteKey?: string
  private activeTurns = new Set<string>()
  private activeTurnThreads = new Map<string, string>()
  private pendingTurnStarts = 0
  private readonly pendingTurnThreads = new Map<string, number>()
  private readonly workspaceMutationRoots = new Map<string, Set<string>>()
  /**
   * Ephemeral Main-process reconnect hints only. Rust remains the durable
   * Thread owner; these paths are never persisted or used as Agent history.
   */
  private readonly threadWorkspaces = new Map<string, string>()
  private readonly loadedThreads = new Set<string>()
  /** Clients/providers launched before they become current must also be revocable. */
  private readonly startingClients = new Set<CodexNativeAppServerClient>()
  private readonly startingProviders = new Set<StartedCodexNativeProvider>()
  /** Source setup changes durable Core config, so no Turn may start mid-setup. */
  private windowsSandboxSetupInProgress = false
  private routeGeneration = 0
  private closePromise?: Promise<void>
  private startingRouteKey?: string
  private startClientPromise?: Promise<CodexNativeAppServerClient>

  constructor(private readonly options: ElectronCodexNativeRuntimeOptions) {}

  /** Read the exact status computed by the source-native Windows sandbox. */
  async getWindowsSandboxReadiness(
    input: NativeCodexWindowsSandboxInput,
  ): Promise<NativeCodexWindowsSandboxReadinessResponse> {
    this.assertWindowsSandboxSetupNotInProgress()
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    return windowsSandboxReadiness(await client.request<CodexNativeJsonObject>('windowsSandbox/readiness'))
  }

  /**
   * Start the source-native setup only after Main has received explicit user
   * consent. Rust owns UAC, provisioning, persistence and the completion
   * notification; Electron only holds the process stable while that happens.
   */
  async startWindowsSandboxSetup(
    input: NativeCodexWindowsSandboxSetupInput,
  ): Promise<NativeCodexWindowsSandboxSetupStartResponse> {
    this.assertWindowsSandboxSetupNotInProgress()
    this.assertModelRouteMayChange()
    this.windowsSandboxSetupInProgress = true
    try {
      const cwd = await this.workspace(input.cwd)
      const client = await this.ensureClient(input.route, cwd)
      const mode = windowsSandboxSetupMode(input.mode)
      const response = windowsSandboxSetupStarted(
        await client.request<CodexNativeJsonObject>('windowsSandbox/setupStart', { mode, cwd }),
      )
      if (!response.started) this.windowsSandboxSetupInProgress = false
      return response
    } catch (error) {
      this.windowsSandboxSetupInProgress = false
      throw error
    }
  }

  async startThread(input: NativeCodexStartThreadInput): Promise<NativeCodexThread> {
    this.assertWindowsSandboxSetupNotInProgress()
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const permissions = nativePermissionSettings(input.permissionMode)
    const response = await client.request<CodexNativeJsonObject>('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      model: this.provider!.model,
      modelProvider: NATIVE_PROVIDER_ID,
      ...permissions,
    })
    const thread = projectNativeCodexThreadResponse(response)
    const id = thread.id
    this.threadWorkspaces.set(id, cwd)
    this.loadedThreads.add(id)
    return thread
  }

  async resumeThread(input: NativeCodexResumeThreadInput): Promise<NativeCodexThread> {
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    this.threadWorkspaces.set(input.threadId, cwd)
    this.loadedThreads.delete(input.threadId)
    return await this.resumeStoredThread(input.threadId, input.route)
  }

  /**
   * Lists durable Rust Thread Store records without creating a BilliardBuddy
   * mirror. `cwd` only gives the child a verified process working directory;
   * it does not implicitly filter the source-owned history.
   */
  async listThreads(input: NativeCodexThreadListInput): Promise<CodexNativeJsonObject> {
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const sectionId = nativeThreadSectionFilter(input.sectionId)
    const sourceKinds = nativeThreadSourceKinds(input.sourceKinds)
    const parentThreadId = nativeThreadRelationId(input.parentThreadId)
    const ancestorThreadId = nativeThreadRelationId(input.ancestorThreadId)
    if (parentThreadId && ancestorThreadId) throw new Error('CODEX_NATIVE_THREAD_RELATION_FILTER_CONFLICT')
    let filterCwds: string[] | undefined
    if (input.filterCwds !== undefined) {
      if (!Array.isArray(input.filterCwds) || input.filterCwds.length === 0 || input.filterCwds.length > 64) {
        throw new Error('CODEX_NATIVE_THREAD_CWD_FILTER_INVALID')
      }
      filterCwds = await Promise.all(input.filterCwds.map(filter => this.workspace(filter)))
      filterCwds = [...new Set(filterCwds)]
    }
    return await client.request<CodexNativeJsonObject>('thread/list', {
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(nativeThreadSearchTerm(input.searchTerm) ? { searchTerm: nativeThreadSearchTerm(input.searchTerm) } : {}),
      ...(nativeThreadListSortKey(input.sortKey) ? { sortKey: nativeThreadListSortKey(input.sortKey) } : {}),
      ...(nativeSortDirection(input.sortDirection) ? { sortDirection: nativeSortDirection(input.sortDirection) } : {}),
      ...(sectionId === undefined ? {} : { sectionId }),
      ...(filterCwds === undefined ? {} : { cwd: filterCwds }),
      ...(sourceKinds === undefined ? {} : { sourceKinds }),
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
      ...(ancestorThreadId === undefined ? {} : { ancestorThreadId }),
    })
  }

  /** List the Rust sessions currently loaded by this App Server process. */
  async listLoadedThreads(input: NativeCodexLoadedThreadListInput): Promise<CodexNativeJsonObject> {
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    return await client.request<CodexNativeJsonObject>('thread/loaded/list', {
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
    })
  }

  /**
   * Detach this App Server connection from an idle Thread. The durable Thread
   * remains in Rust storage and can later be resumed with an explicit cwd.
   */
  async unsubscribeThread(
    thread: Pick<NativeCodexThread, 'id'>,
    route: CodexNativeModelRoute,
  ): Promise<NativeCodexThreadUnsubscribeResponse> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if ([...this.activeTurnThreads.values()].includes(thread.id)) {
      throw new Error('CODEX_NATIVE_THREAD_UNSUBSCRIBE_REQUIRES_IDLE')
    }
    const cwd = this.threadWorkspaces.get(thread.id)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const client = await this.ensureClient(route, cwd)
    const response = await client.request<CodexNativeJsonObject>('thread/unsubscribe', { threadId: thread.id })
    const status = response.status
    if (status !== 'notLoaded' && status !== 'notSubscribed' && status !== 'unsubscribed') {
      throw new Error('CODEX_NATIVE_THREAD_UNSUBSCRIBE_RESPONSE_INVALID')
    }
    this.loadedThreads.delete(thread.id)
    this.threadWorkspaces.delete(thread.id)
    return { status }
  }

  /** Update only source-owned Git display metadata; this never writes the repository. */
  async updateThreadMetadata(
    thread: Pick<NativeCodexThread, 'id'>,
    gitInfo: NativeCodexThreadMetadataGitInfoUpdate,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/metadata/update', {
      threadId: thread.id,
      gitInfo: nativeThreadMetadataGitInfo(gitInfo),
    })
  }

  /** Source-native full-text thread search; results stay in the Rust state database. */
  async searchThreads(input: NativeCodexThreadSearchInput): Promise<CodexNativeJsonObject> {
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const searchTerm = nativeThreadSearchTerm(input.searchTerm)
    if (!searchTerm) throw new Error('CODEX_NATIVE_THREAD_SEARCH_INVALID')
    return await client.request<CodexNativeJsonObject>('thread/search', {
      searchTerm,
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
      ...(nativeThreadListSortKey(input.sortKey) ? { sortKey: nativeThreadListSortKey(input.sortKey) } : {}),
      ...(nativeSortDirection(input.sortDirection) ? { sortDirection: nativeSortDirection(input.sortDirection) } : {}),
    })
  }

  /** Restore an archived source Thread, then attach it to the current private process. */
  async unarchiveThread(input: NativeCodexResumeThreadInput): Promise<NativeCodexThread> {
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    await client.request('thread/unarchive', { threadId: input.threadId })
    this.threadWorkspaces.set(input.threadId, cwd)
    this.loadedThreads.delete(input.threadId)
    return await this.resumeStoredThread(input.threadId, input.route)
  }

  /** Permanently remove one Rust Thread Store record; Electron keeps no copy. */
  async deleteThread(input: NativeCodexResumeThreadInput): Promise<void> {
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    await client.request('thread/delete', { threadId: input.threadId })
    this.threadWorkspaces.delete(input.threadId)
    this.loadedThreads.delete(input.threadId)
  }

  /**
   * Re-open an already owned Rust Thread after a local provider process was
   * deliberately revoked. The workspace is an in-memory reconnect hint, not
   * a replacement Thread record; the source Thread Store validates and owns
   * the returned session.
   */
  async ensureThread(thread: Pick<NativeCodexThread, 'id'>, route: CodexNativeModelRoute): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = this.threadWorkspaces.get(thread.id)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    await this.ensureClient(route, cwd)
    if (this.loadedThreads.has(thread.id)) return
    await this.resumeStoredThread(thread.id, route)
  }

  /** Return only the current host cwd hint; Rust remains the Thread owner. */
  threadWorkspace(thread: Pick<NativeCodexThread, 'id'>): string {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = this.threadWorkspaces.get(thread.id)
    if (!workspace) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    return workspace
  }

  /**
   * Main uses this host-local lookup only to protect a shared checkout while
   * Core-owned background terminals still run. It never mirrors terminal
   * state: the App Server remains the source queried below.
   */
  threadIdsUsingWorkspaces(workspaces: readonly string[]): string[] {
    const roots = new Set<string>()
    for (const candidate of workspaces) {
      if (!nonEmptyText(candidate, 4_096) || /[\u0000\r\n]/.test(candidate) || !path.isAbsolute(candidate)) {
        throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_INVALID')
      }
      roots.add(path.normalize(candidate))
    }
    return [...this.threadWorkspaces]
      .filter(([, workspace]) => roots.has(path.normalize(workspace)))
      .map(([threadId]) => threadId)
  }

  /** Fail closed before a host mutation can race a source-native background process. */
  async assertWorkspacesHaveNoBackgroundTerminals(workspaces: readonly string[]): Promise<void> {
    for (const threadId of this.threadIdsUsingWorkspaces(workspaces)) {
      const page = await this.listBackgroundTerminals({ id: threadId }, { limit: 1 })
      if (!Array.isArray(page.data)) throw new Error('CODEX_NATIVE_BACKGROUND_TERMINALS_RESPONSE_INVALID')
      if (page.data.length > 0) throw new Error('CODEX_NATIVE_WORKSPACE_BACKGROUND_TERMINAL_ACTIVE')
    }
  }

  /**
   * Atomically reserve an idle Thread cwd while Electron performs a bounded
   * Worktree/Handoff/Local Environment host operation. New native Turns and
   * integrated terminals fail closed until Main releases the reservation.
   */
  beginThreadWorkspaceMutation(
    thread: Pick<NativeCodexThread, 'id'>,
    relatedWorkspaces: readonly string[] = [],
  ): void {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = this.threadWorkspace(thread)
    const roots = new Set([workspace])
    for (const candidate of relatedWorkspaces) {
      if (!nonEmptyText(candidate, 4_096) || /[\u0000\r\n]/.test(candidate) || !path.isAbsolute(candidate)) {
        throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_INVALID')
      }
      roots.add(path.normalize(candidate))
    }
    if (
      this.workspaceMutationRoots.has(thread.id)
      || [...this.workspaceMutationRoots.values()].some(existing => [...roots].some(root => existing.has(root)))
    ) {
      throw new Error('CODEX_NATIVE_WORKSPACE_MUTATION_IN_PROGRESS')
    }
    this.assertWorkspacesHaveNoTurn(roots)
    this.workspaceMutationRoots.set(thread.id, roots)
  }

  endThreadWorkspaceMutation(thread: Pick<NativeCodexThread, 'id'>): void {
    if (!nonEmptyText(thread.id)) return
    this.workspaceMutationRoots.delete(thread.id)
  }

  private assertThreadHasNoTurn(threadId: string): void {
    const workspace = this.threadWorkspaces.get(threadId)
    if (workspace) this.assertWorkspacesHaveNoTurn(new Set([workspace]))
  }

  private assertWorkspacesHaveNoTurn(workspaces: ReadonlySet<string>): void {
    if (
      [...this.activeTurnThreads.values()].some(id => {
        const workspace = this.threadWorkspaces.get(id)
        return workspace !== undefined && workspaces.has(workspace)
      })
      || [...this.pendingTurnThreads].some(([id, count]) => {
        const workspace = this.threadWorkspaces.get(id)
        return count > 0 && workspace !== undefined && workspaces.has(workspace)
      })
    ) throw new Error('CODEX_NATIVE_WORKSPACE_RELOCATION_REQUIRES_IDLE_THREAD')
  }

  private assertThreadWorkspaceAvailable(threadId: string): void {
    const workspace = this.threadWorkspaces.get(threadId)
    if (workspace && [...this.workspaceMutationRoots.values()].some(roots => roots.has(workspace))) {
      throw new Error('CODEX_NATIVE_WORKSPACE_MUTATION_IN_PROGRESS')
    }
  }

  private markPendingTurnStart(threadId: string): void {
    this.pendingTurnStarts += 1
    this.pendingTurnThreads.set(threadId, (this.pendingTurnThreads.get(threadId) ?? 0) + 1)
  }

  private unmarkPendingTurnStart(threadId: string): void {
    this.pendingTurnStarts = Math.max(0, this.pendingTurnStarts - 1)
    const remaining = (this.pendingTurnThreads.get(threadId) ?? 1) - 1
    if (remaining <= 0) this.pendingTurnThreads.delete(threadId)
    else this.pendingTurnThreads.set(threadId, remaining)
  }

  /**
   * Move an idle Thread between a local checkout and a desktop-managed
   * worktree. The next native Turn carries the new cwd to Core; no history,
   * context, approval or Agent state is copied by Electron.
   */
  async relocateThreadWorkspace(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<string> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    this.assertThreadHasNoTurn(thread.id)
    const workspace = await this.workspace(cwd)
    const reservation = this.workspaceMutationRoots.get(thread.id)
    if (reservation) {
      if ([...this.workspaceMutationRoots].some(([id, roots]) => id !== thread.id && roots.has(workspace))) {
        throw new Error('CODEX_NATIVE_WORKSPACE_MUTATION_IN_PROGRESS')
      }
      this.assertWorkspacesHaveNoTurn(new Set([workspace]))
      reservation.add(workspace)
    }
    this.threadWorkspaces.set(thread.id, workspace)
    return workspace
  }

  /** Read durable history from the Rust Thread Store; Electron never caches it as authority. */
  async readThread(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
  }

  /** Source-native paginated Turn history; no Electron history cache is created. */
  async listThreadTurns(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexThreadTurnsPageInput = {},
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/turns/list', {
      threadId: thread.id,
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
      ...(nativeSortDirection(input.sortDirection) ? { sortDirection: nativeSortDirection(input.sortDirection) } : {}),
      ...(nativeTurnItemsView(input.itemsView) ? { itemsView: nativeTurnItemsView(input.itemsView) } : {}),
    })
  }

  /** Source-native paginated Item history across one Thread or a selected Turn. */
  async listThreadItems(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexThreadItemsPageInput = {},
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if (input.turnId !== undefined && !nonEmptyText(input.turnId)) throw new Error('CODEX_NATIVE_TURN_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/items/list', {
      threadId: thread.id,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
      ...(nativeSortDirection(input.sortDirection) ? { sortDirection: nativeSortDirection(input.sortDirection) } : {}),
    })
  }

  /** Search visible messages through the Rust Thread Store without an Electron index. */
  async searchThreadOccurrences(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexThreadOccurrenceSearchInput,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const searchTerm = nativeThreadSearchTerm(input.searchTerm)
    if (!searchTerm) throw new Error('CODEX_NATIVE_THREAD_SEARCH_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/searchOccurrences', {
      threadId: thread.id,
      searchTerm,
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
    })
  }

  /** Read the Rust model catalog for the provider route that owns this Thread. */
  async listModels(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexModelListInput = {},
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if (input.includeHidden !== undefined && typeof input.includeHidden !== 'boolean') {
      throw new Error('CODEX_NATIVE_MODEL_LIST_INVALID')
    }
    return await this.requireClient().request<CodexNativeJsonObject>('model/list', {
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
      ...(input.includeHidden === undefined ? {} : { includeHidden: input.includeHidden }),
    })
  }

  /** Read source-declared tool modalities for the active model provider. */
  async readModelProviderCapabilities(
    thread: Pick<NativeCodexThread, 'id'>,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('modelProvider/capabilities/read', {})
  }

  /** Read source-native permission profiles after project requirements are applied. */
  async listPermissionProfiles(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexPermissionProfileListInput,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('permissionProfile/list', {
      cwd,
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
    })
  }

  /** Read only managed requirements; unlike `config/read`, this cannot expose model credentials. */
  async readConfigRequirements(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('configRequirements/read', {})
  }

  /** Read an allowlisted projection of effective Core settings for this Thread workspace. */
  async readClientSettings(
    thread: Pick<NativeCodexThread, 'id'>,
  ): Promise<NativeCodexClientSettingsProjection> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = this.threadWorkspaces.get(thread.id)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const response = await this.requireClient().request<CodexNativeJsonObject>('config/read', {
      cwd,
      includeLayers: true,
    })
    return projectNativeCodexClientSettings(response)
  }

  /**
   * Configure the source-native memory feature and its two user settings in
   * one Core-owned config transaction. A fresh App Server process is required
   * because the stable `memories` feature is session-static.
   */
  async configureMemory(
    thread: Pick<NativeCodexThread, 'id'>,
    configuration: NativeCodexMemoryConfiguration,
  ): Promise<CodexNativeJsonObject> {
    if (
      !nonEmptyText(thread.id)
      || !configuration
      || typeof configuration !== 'object'
      || typeof configuration.enabled !== 'boolean'
      || typeof configuration.useMemories !== 'boolean'
      || typeof configuration.generateMemories !== 'boolean'
    ) throw new Error('CODEX_NATIVE_MEMORY_CONFIGURATION_INVALID')
    this.assertModelRouteMayChange()
    const response = await this.requireClient().request<CodexNativeJsonObject>('config/batchWrite', {
      edits: [
        { keyPath: 'features.memories', value: configuration.enabled, mergeStrategy: 'replace' },
        { keyPath: 'memories.use_memories', value: configuration.useMemories, mergeStrategy: 'replace' },
        { keyPath: 'memories.generate_memories', value: configuration.generateMemories, mergeStrategy: 'replace' },
      ],
      reloadUserConfig: true,
    })
    await this.invalidateModelRoute()
    return response
  }

  /** Enable or disable the Rust Core's own memory behavior for one Thread. */
  async setThreadMemoryMode(
    thread: Pick<NativeCodexThread, 'id'>,
    mode: 'enabled' | 'disabled',
  ): Promise<void> {
    if (!nonEmptyText(thread.id) || (mode !== 'enabled' && mode !== 'disabled')) {
      throw new Error('CODEX_NATIVE_THREAD_MEMORY_MODE_INVALID')
    }
    await this.requireClient().request('thread/memoryMode/set', { threadId: thread.id, mode })
  }

  /** Delete source-owned local memories. Electron keeps no shadow memory store. */
  async resetMemory(thread: Pick<NativeCodexThread, 'id'>): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('memory/reset', {})
  }

  /** List source-owned Thread sections without duplicating their state. */
  async listThreadSections(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexThreadSectionListInput = {},
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('threadSection/list', {
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
    })
  }

  /** Create a source-owned Thread section. */
  async createThreadSection(
    thread: Pick<NativeCodexThread, 'id'>,
    name: string,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('threadSection/create', {
      name: nativePluginText(name, 512, 'CODEX_NATIVE_THREAD_SECTION_NAME_INVALID'),
    })
  }

  /** Rename a source-owned Thread section. */
  async updateThreadSection(
    thread: Pick<NativeCodexThread, 'id'>,
    sectionId: string,
    name: string,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('threadSection/update', {
      sectionId: nativePluginText(sectionId, 200, 'CODEX_NATIVE_THREAD_SECTION_ID_INVALID'),
      name: nativePluginText(name, 512, 'CODEX_NATIVE_THREAD_SECTION_NAME_INVALID'),
    })
  }

  /** Delete a source-owned Thread section. */
  async deleteThreadSection(thread: Pick<NativeCodexThread, 'id'>, sectionId: string): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('threadSection/delete', {
      sectionId: nativePluginText(sectionId, 200, 'CODEX_NATIVE_THREAD_SECTION_ID_INVALID'),
    })
  }

  /** Move a Thread using the Rust Store's section ordering. */
  async moveThreadToSection(
    thread: Pick<NativeCodexThread, 'id'>,
    sectionId: string | null,
    beforeThreadId?: string,
  ): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if (sectionId !== null && !nonEmptyText(sectionId, 200)) throw new Error('CODEX_NATIVE_THREAD_SECTION_ID_INVALID')
    if (beforeThreadId !== undefined && !nonEmptyText(beforeThreadId, 200)) {
      throw new Error('CODEX_NATIVE_THREAD_SECTION_BEFORE_ID_INVALID')
    }
    await this.requireClient().request('thread/section/move', {
      threadId: thread.id,
      sectionId,
      ...(beforeThreadId === undefined ? {} : { beforeThreadId }),
    })
  }

  /** Read the durable Goal stored by the Rust Thread Store, if this Thread has one. */
  async getThreadGoal(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/goal/get', { threadId: thread.id })
  }

  /** Patch one source-native Goal without mirroring it into Electron or the renderer. */
  async setThreadGoal(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexThreadGoalSetInput,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const patch = nativeThreadGoalSetInput(input)
    return await this.requireClient().request<CodexNativeJsonObject>('thread/goal/set', {
      threadId: thread.id,
      ...(patch.objective === undefined ? {} : { objective: patch.objective }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.tokenBudget === undefined ? {} : { tokenBudget: patch.tokenBudget }),
    })
  }

  /** Remove the source-owned Goal. Rust emits `thread/goal/cleared` on success. */
  async clearThreadGoal(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/goal/clear', { threadId: thread.id })
  }

  /** List only background terminals that this native Thread owns. */
  async listBackgroundTerminals(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexBackgroundTerminalsPageInput = {},
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/backgroundTerminals/list', {
      threadId: thread.id,
      ...(nativeCursor(input.cursor) ? { cursor: nativeCursor(input.cursor) } : {}),
      ...(nativePageLimit(input.limit) ? { limit: nativePageLimit(input.limit) } : {}),
    })
  }

  /** Stop exactly one process id returned by `thread/backgroundTerminals/list`. */
  async terminateBackgroundTerminal(
    thread: Pick<NativeCodexThread, 'id'>,
    processId: string,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/backgroundTerminals/terminate', {
      threadId: thread.id,
      processId: nativeBackgroundTerminalProcessId(processId),
    })
  }

  /** Stop all source-native background terminals attached to this Thread. */
  async cleanBackgroundTerminals(thread: Pick<NativeCodexThread, 'id'>): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('thread/backgroundTerminals/clean', { threadId: thread.id })
  }

  /**
   * Start the client terminal through App Server's own sandboxed PTY. Main
   * chooses the shell, process id and Thread workspace; Renderer cannot turn
   * this into an unsandboxed process-spawn API.
   */
  async startIntegratedTerminal(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexIntegratedTerminalInput,
  ): Promise<NativeCodexCommandExecResponse> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    this.assertThreadWorkspaceAvailable(thread.id)
    const cwd = this.threadWorkspaces.get(thread.id)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const processId = nativeOperationId(input.processId, 'CODEX_NATIVE_TERMINAL_ID_INVALID')
    const response = await this.requireClient().request<CodexNativeJsonObject>('command/exec', {
      command: nativeTerminalCommand(input.command),
      processId,
      tty: true,
      streamStdin: true,
      streamStdoutStderr: true,
      outputBytesCap: 16 * 1024 * 1024,
      disableTimeout: true,
      cwd,
      size: nativeTerminalSize(input.size),
    })
    return projectCommandExecResponse(response)
  }

  async writeIntegratedTerminal(processId: string, text: string, closeStdin = false): Promise<void> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024 || text.includes('\u0000')) {
      throw new Error('CODEX_NATIVE_TERMINAL_INPUT_INVALID')
    }
    if (!text && !closeStdin) throw new Error('CODEX_NATIVE_TERMINAL_INPUT_INVALID')
    await this.requireClient().request('command/exec/write', {
      processId: nativeOperationId(processId, 'CODEX_NATIVE_TERMINAL_ID_INVALID'),
      ...(text ? { deltaBase64: Buffer.from(text).toString('base64') } : {}),
      closeStdin,
    })
  }

  async resizeIntegratedTerminal(processId: string, size: NativeCodexTerminalSize): Promise<void> {
    await this.requireClient().request('command/exec/resize', {
      processId: nativeOperationId(processId, 'CODEX_NATIVE_TERMINAL_ID_INVALID'),
      size: nativeTerminalSize(size),
    })
  }

  async terminateIntegratedTerminal(processId: string): Promise<void> {
    await this.requireClient().request('command/exec/terminate', {
      processId: nativeOperationId(processId, 'CODEX_NATIVE_TERMINAL_ID_INVALID'),
    })
  }

  /** One-off source-native fuzzy search restricted to the Thread workspace. */
  async searchWorkspaceFiles(
    thread: Pick<NativeCodexThread, 'id'>,
    query: string,
  ): Promise<{ files: NativeCodexFuzzyFileSearchResult[] }> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const root = this.threadWorkspaces.get(thread.id)
    if (!root) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    return projectFuzzyFileSearchResponse(await this.requireClient().request<CodexNativeJsonObject>('fuzzyFileSearch', {
      query: nativeFuzzyQuery(query),
      roots: [root],
    }))
  }

  async startWorkspaceFileSearchSession(
    thread: Pick<NativeCodexThread, 'id'>,
    sessionId: string,
  ): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const root = this.threadWorkspaces.get(thread.id)
    if (!root) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    await this.requireClient().request('fuzzyFileSearch/sessionStart', {
      sessionId: nativeOperationId(sessionId, 'CODEX_NATIVE_FUZZY_SESSION_ID_INVALID'),
      roots: [root],
    })
  }

  async updateWorkspaceFileSearchSession(sessionId: string, query: string): Promise<void> {
    await this.requireClient().request('fuzzyFileSearch/sessionUpdate', {
      sessionId: nativeOperationId(sessionId, 'CODEX_NATIVE_FUZZY_SESSION_ID_INVALID'),
      query: nativeFuzzyQuery(query),
    })
  }

  async stopWorkspaceFileSearchSession(sessionId: string): Promise<void> {
    await this.requireClient().request('fuzzyFileSearch/sessionStop', {
      sessionId: nativeOperationId(sessionId, 'CODEX_NATIVE_FUZZY_SESSION_ID_INVALID'),
    })
  }

  /** Ask Rust Core to compact a Thread's context; Core owns the resulting history. */
  async compactThread(thread: Pick<NativeCodexThread, 'id'>): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('thread/compact/start', { threadId: thread.id })
  }

  /**
   * The pinned source still provides Thread rollback. It is source-deprecated,
   * so future UI should prefer fork for a non-destructive branch, but this
   * method keeps current native history recovery available without a mirror.
   */
  async rollbackThread(thread: Pick<NativeCodexThread, 'id'>, numTurns: number): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > 10_000) {
      throw new Error('CODEX_NATIVE_THREAD_ROLLBACK_INVALID')
    }
    return await this.requireClient().request<CodexNativeJsonObject>('thread/rollback', {
      threadId: thread.id,
      numTurns,
    })
  }

  /** Persist a source Thread title in the Rust Thread Store. */
  async setThreadName(thread: Pick<NativeCodexThread, 'id'>, name: string): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    if (!nonEmptyText(name, 512) || /[\u0000\r\n]/.test(name)) throw new Error('CODEX_NATIVE_THREAD_NAME_INVALID')
    await this.requireClient().request('thread/name/set', { threadId: thread.id, name: name.trim() })
  }

  async forkThread(input: NativeCodexResumeThreadInput & { lastTurnId?: string, permissionMode: NativeCodexPermissionMode }): Promise<NativeCodexThread> {
    this.assertWindowsSandboxSetupNotInProgress()
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const permissions = nativePermissionSettings(input.permissionMode)
    const response = await client.request<CodexNativeJsonObject>('thread/fork', {
      threadId: input.threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      // Apply the selected source-native permissions explicitly, so a fork
      // never inherits an old privilege level after the user changed it.
      model: this.provider!.model,
      modelProvider: NATIVE_PROVIDER_ID,
      ...permissions,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
    })
    const thread = projectNativeCodexThreadResponse(response)
    const id = thread.id
    this.threadWorkspaces.set(id, cwd)
    this.loadedThreads.add(id)
    return thread
  }

  /**
   * Changes the active Rust Thread settings for subsequent turns. The Thread
   * Store records the applied settings and emits `thread/settings/updated`;
   * no Electron or renderer permission record is written.
   */
  async updatePermissionMode(thread: Pick<NativeCodexThread, 'id'>, mode: NativeCodexPermissionMode): Promise<NativeCodexPermissionMode> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const settings = nativePermissionSettings(mode)
    await this.requireClient().request('thread/settings/update', {
      threadId: thread.id,
      sandboxPolicy: nativeSandboxPolicy(mode),
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
    })
    return mode
  }

  /** Update only source-native, non-secret per-Thread settings. */
  async updateThreadSettings(
    thread: Pick<NativeCodexThread, 'id'>,
    patch: NativeCodexThreadSettingsPatch,
  ): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('thread/settings/update', {
      threadId: thread.id,
      ...nativeThreadSettingsPatch(patch),
    })
  }

  /**
   * Writes only one source-native MCP server configuration under this private
   * Codex Home, then asks the App Server to apply it to loaded Threads.
   */
  async configureMcpServer(
    thread: Pick<NativeCodexThread, 'id'>,
    name: string,
    config: NativeCodexMcpServerConfig,
  ): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const serverName = nativeMcpServerName(name)
    const value = nativeMcpConfig(config)
    const client = this.requireClient()
    await client.request('config/value/write', {
      keyPath: `mcp_servers.${serverName}`,
      value,
      mergeStrategy: 'replace',
    })
    await client.request('config/mcpServer/reload')
  }

  /** Remove one source-native MCP server and refresh the active Rust sessions. */
  async removeMcpServer(thread: Pick<NativeCodexThread, 'id'>, name: string): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const serverName = nativeMcpServerName(name)
    const client = this.requireClient()
    await client.request('config/value/write', {
      keyPath: `mcp_servers.${serverName}`,
      value: null,
      mergeStrategy: 'replace',
    })
    await client.request('config/mcpServer/reload')
  }

  /** Query the authoritative App Server MCP startup/auth/tool snapshot. */
  async listMcpServerStatuses(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('mcpServerStatus/list', {
      threadId: thread.id,
      detail: 'toolsAndAuthOnly',
    })
  }

  /** Starts Codex's own OAuth flow; credentials stay in its configured store. */
  async startMcpOAuth(thread: Pick<NativeCodexThread, 'id'>, name: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('mcpServer/oauth/login', {
      name: nativeMcpServerName(name),
      threadId: thread.id,
    })
  }

  /** Read the source-owned skill catalog for one verified workspace. */
  async listSkills(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('skills/list', {
      cwds: [workspace],
      forceReload: true,
    })
  }

  /** Detect external Agent configuration through the locked Rust importer. */
  async detectExternalAgentConfig(
    thread: Pick<NativeCodexThread, 'id'>,
    input: { cwd: string, includeHome: boolean, migrationSource?: string },
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id) || typeof input.includeHome !== 'boolean') throw new Error('CODEX_NATIVE_EXTERNAL_AGENT_DETECT_INVALID')
    const workspace = await this.workspace(input.cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('externalAgentConfig/detect', {
      cwds: [workspace],
      includeHome: input.includeHome,
      ...(input.migrationSource === undefined ? {} : { migrationSource: nativePluginText(input.migrationSource, 128, 'CODEX_NATIVE_EXTERNAL_AGENT_SOURCE_INVALID') }),
    })
  }

  /** Import only the exact source-native items selected from a cached detection. */
  async importExternalAgentConfig(
    thread: Pick<NativeCodexThread, 'id'>,
    migrationItems: readonly NativeExternalAgentMigrationItem[],
    migrationSource?: string,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id) || migrationItems.length === 0 || migrationItems.length > 128) {
      throw new Error('CODEX_NATIVE_EXTERNAL_AGENT_IMPORT_INVALID')
    }
    return await this.requireClient().request<CodexNativeJsonObject>('externalAgentConfig/import', {
      migrationItems: [...migrationItems],
      source: 'billiardbuddy',
      ...(migrationSource === undefined ? {} : { migrationSource: nativePluginText(migrationSource, 128, 'CODEX_NATIVE_EXTERNAL_AGENT_SOURCE_INVALID') }),
    })
  }

  /** Read import outcomes from the source-owned state DB. */
  async readExternalAgentImportHistories(
    thread: Pick<NativeCodexThread, 'id'>,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('externalAgentConfig/import/readHistories', {})
  }

  /**
   * Sets Codex's own extra Skill roots. The Rust configuration remains the
   * only registry; Electron merely canonicalizes directories before forwarding.
   */
  async setExtraSkillRoots(thread: Pick<NativeCodexThread, 'id'>, roots: readonly string[]): Promise<void> {
    if (!nonEmptyText(thread.id) || roots.length > 64) throw new Error('CODEX_NATIVE_SKILL_ROOTS_INVALID')
    const extraRoots = [...new Set(await Promise.all(roots.map(root => this.workspace(root))))]
    await this.requireClient().request('skills/extraRoots/set', { extraRoots })
  }

  /** Enable or disable a source-native skill without maintaining a second registry. */
  async setSkillEnabled(
    thread: Pick<NativeCodexThread, 'id'>,
    selector: NativeCodexSkillSelector,
    enabled: boolean,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id) || typeof enabled !== 'boolean') throw new Error('CODEX_NATIVE_SKILL_CONFIGURATION_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('skills/config/write', {
      ...nativeSkillSelector(selector),
      enabled,
    })
  }

  /** Read resolved source-native Hook metadata; execution remains in Rust Core. */
  async listHooks(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })
  }

  /**
   * Trust only the exact source-returned Hook revision after privileged Main
   * consent. This intentionally exposes no general `config/batchWrite` API.
   */
  async trustHook(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexHookTrustInput,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const hookKey = nativeHookTrustText(input?.hookKey, 4_096, 'CODEX_NATIVE_HOOK_KEY_INVALID')
    const currentHash = nativeHookTrustText(input?.currentHash, 1_024, 'CODEX_NATIVE_HOOK_HASH_INVALID')
    const workspace = await this.workspace(input?.cwd)
    const client = this.requireClient()
    const listed = await client.request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })
    const hook = listedNativeHook(listed, hookKey, currentHash)
    if (hook.trustStatus === 'managed') throw new Error('CODEX_NATIVE_HOOK_TRUST_MANAGED')
    if (hook.trustStatus === 'trusted') return listed
    if (hook.trustStatus !== 'untrusted' && hook.trustStatus !== 'modified') {
      throw new Error('CODEX_NATIVE_HOOK_TRUST_STATUS_INVALID')
    }
    await client.request<CodexNativeJsonObject>('config/batchWrite', {
      edits: [{
        keyPath: 'hooks.state',
        value: { [hookKey]: { trusted_hash: currentHash } },
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    })
    const verified = await client.request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })
    if (listedNativeHook(verified, hookKey, currentHash).trustStatus !== 'trusted') {
      throw new Error('CODEX_NATIVE_HOOK_TRUST_VERIFICATION_FAILED')
    }
    return verified
  }

  /**
   * Query only local and workspace Codex marketplaces. OpenAI account-backed
   * remote marketplaces are intentionally outside BilliardBuddy's provider
   * model and are never selected by this product boundary.
   */
  async listPlugins(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('plugin/list', {
      cwds: [workspace],
      marketplaceKinds: ['local', 'workspace-directory'],
      forceRefetch: false,
    })
  }

  /** Read the native catalog's installed plugin projection for one workspace. */
  async listInstalledPlugins(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('plugin/installed', { cwds: [workspace] })
  }

  /** Read a local plugin directly through the Rust App Server. */
  async readPlugin(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexPluginReference,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const reference = nativePluginReference(input)
    const marketplacePath = await this.workspace(reference.marketplacePath)
    return await this.requireClient().request<CodexNativeJsonObject>('plugin/read', {
      marketplacePath,
      pluginName: reference.pluginName,
    })
  }

  /** Add a local or Git marketplace through the source-native installer. */
  async addMarketplace(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexMarketplaceAddInput,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('marketplace/add', nativeMarketplaceAddInput(input))
  }

  /** Remove one marketplace through the Rust-owned configuration and cache. */
  async removeMarketplace(thread: Pick<NativeCodexThread, 'id'>, marketplaceName: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('marketplace/remove', {
      marketplaceName: nativePluginText(marketplaceName, 512, 'CODEX_NATIVE_MARKETPLACE_NAME_INVALID'),
    })
  }

  /** Upgrade one or all Rust-managed marketplaces; source owns atomic replacement. */
  async upgradeMarketplace(
    thread: Pick<NativeCodexThread, 'id'>,
    marketplaceName?: string,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('marketplace/upgrade', {
      ...(marketplaceName === undefined
        ? {}
        : { marketplaceName: nativePluginText(marketplaceName, 512, 'CODEX_NATIVE_MARKETPLACE_NAME_INVALID') }),
    })
  }

  /** Install a local marketplace plugin; any bundled MCP auth remains a Rust server request. */
  async installPlugin(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexPluginReference,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const reference = nativePluginReference(input)
    const marketplacePath = await this.workspace(reference.marketplacePath)
    return await this.requireClient().request<CodexNativeJsonObject>('plugin/install', {
      marketplacePath,
      pluginName: reference.pluginName,
    })
  }

  /** Uninstall one native plugin without maintaining a BilliardBuddy copy of plugin state. */
  async uninstallPlugin(thread: Pick<NativeCodexThread, 'id'>, pluginId: string): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('plugin/uninstall', {
      pluginId: nativePluginText(pluginId, 512, 'CODEX_NATIVE_PLUGIN_ID_INVALID'),
    })
  }

  /** Read available Codex collaboration presets; Rust owns spawned Agent state. */
  async listCollaborationModes(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('collaborationMode/list', {})
  }

  /**
   * Starts the upstream Rust reviewer. Detached delivery forks a native Rust
   * Thread; this method records only its ephemeral workspace reconnect hint.
   */
  async startReview(
    thread: Pick<NativeCodexThread, 'id'>,
    input: NativeCodexStartReviewInput,
  ): Promise<NativeCodexReview> {
    this.assertWindowsSandboxSetupNotInProgress()
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const target = nativeReviewTarget(input.target)
    const delivery = nativeReviewDelivery(input.delivery)
    this.assertThreadWorkspaceAvailable(thread.id)
    const workspace = this.threadWorkspace(thread)
    this.markPendingTurnStart(thread.id)
    try {
      const response = await this.requireClient().request<CodexNativeJsonObject>('review/start', {
        threadId: thread.id,
        target,
        ...(delivery === undefined ? {} : { delivery }),
      })
      const id = turnId(response)
      const reviewThreadId = response.reviewThreadId
      if (!nonEmptyText(reviewThreadId)) throw new Error('CODEX_NATIVE_REVIEW_RESPONSE_INVALID')
      this.threadWorkspaces.set(reviewThreadId, workspace)
      this.loadedThreads.add(reviewThreadId)
      this.activeTurns.add(id)
      this.activeTurnThreads.set(id, reviewThreadId)
      return { turn: { id }, reviewThreadId }
    } finally {
      this.unmarkPendingTurnStart(thread.id)
    }
  }

  async startTurn(
    thread: Pick<NativeCodexThread, 'id'>,
    input: readonly NativeCodexTurnInput[],
    clientUserMessageId?: string,
    collaborationMode?: NativeCodexCollaborationMode,
    additionalContext?: NativeCodexAdditionalContext,
  ): Promise<NativeCodexTurn> {
    this.assertWindowsSandboxSetupNotInProgress()
    if (!nonEmptyText(thread.id) || input.length === 0 || input.length > 64 || !input.every(validateTurnInput)) {
      throw new Error('CODEX_NATIVE_TURN_INPUT_INVALID')
    }
    if (clientUserMessageId !== undefined && !nonEmptyText(clientUserMessageId, 512)) {
      throw new Error('CODEX_NATIVE_CLIENT_MESSAGE_ID_INVALID')
    }
    const nativeMode = nativeCollaborationMode(collaborationMode)
    const sourceContext = nativeAdditionalContext(additionalContext)
    const client = this.requireClient()
    this.assertThreadWorkspaceAvailable(thread.id)
    const cwd = this.threadWorkspace(thread)
    this.markPendingTurnStart(thread.id)
    try {
      const nativeInput = await Promise.all(input.map(item => this.normalizeTurnInput(thread.id, item)))
      const response = await client.request<CodexNativeJsonObject>('turn/start', {
        threadId: thread.id,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        ...(nativeMode === undefined ? {} : { collaborationMode: nativeCollaborationSettings(nativeMode, this.provider!.model) }),
        ...(sourceContext === undefined ? {} : { additionalContext: sourceContext }),
        input: nativeInput,
      })
      const id = turnId(response)
      this.activeTurns.add(id)
      this.activeTurnThreads.set(id, thread.id)
      return { id }
    } finally {
      this.unmarkPendingTurnStart(thread.id)
    }
  }

  private async normalizeTurnInput(threadIdValue: string, input: NativeCodexTurnInput): Promise<CodexNativeJsonObject> {
    if (input.type === 'text') {
      return { type: 'text', text: input.text, textElements: nativeTextElements(input.text, input.textElements) }
    }
    if (input.type === 'image') {
      return { type: 'image', url: input.url, ...(input.detail === undefined ? {} : { detail: input.detail }) }
    }
    if (input.type === 'audio') return { type: 'audio', url: input.url }
    if (input.type === 'mention') return { type: 'mention', name: input.name, path: input.path }

    const workspace = this.threadWorkspaces.get(threadIdValue)
    if (!workspace) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const engineHome = path.join(absoluteDirectory(this.options.userDataPath), 'agent-runtime')
    const bundledMarketplace = path.join(absoluteDirectory(this.options.desktopRoot), 'runtime-assets', 'agent-marketplace')
    // The locked Core natively discovers user-installed skills from
    // $HOME/.agents/skills in addition to CODEX_HOME and repository roots.
    // Mirror only that source-defined read boundary for an explicit Skill
    // selector; Electron still verifies the real regular SKILL.md file.
    const userAgentSkills = path.join(homedir(), '.agents', 'skills')

    if (input.type === 'localImage') {
      const resolved = await this.secureRegularFile(input.path, [workspace], 32 * 1024 * 1024)
      const handle = await fs.open(resolved, 'r')
      try {
        const header = Buffer.alloc(12)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        if (!recognizedImageHeader(header.subarray(0, bytesRead))) throw new Error('CODEX_NATIVE_LOCAL_IMAGE_INVALID')
      } finally {
        await handle.close()
      }
      return { type: 'localImage', path: resolved, ...(input.detail === undefined ? {} : { detail: input.detail }) }
    }

    if (input.type === 'localAudio') {
      const resolved = await this.secureRegularFile(input.path, [workspace], 64 * 1024 * 1024)
      const handle = await fs.open(resolved, 'r')
      try {
        const header = Buffer.alloc(12)
        const { bytesRead } = await handle.read(header, 0, header.length, 0)
        if (!recognizedAudioHeader(resolved, header.subarray(0, bytesRead))) throw new Error('CODEX_NATIVE_LOCAL_AUDIO_INVALID')
      } finally {
        await handle.close()
      }
      return { type: 'localAudio', path: resolved }
    }

    const resolved = await this.secureRegularFile(
      input.path,
      [workspace, engineHome, bundledMarketplace, userAgentSkills],
      1024 * 1024,
    )
    if (path.basename(resolved) !== 'SKILL.md') throw new Error('CODEX_NATIVE_SKILL_PATH_INVALID')
    return { type: 'skill', name: input.name, path: resolved }
  }

  private async secureRegularFile(inputPath: string, roots: readonly string[], maxBytes: number): Promise<string> {
    if (!path.isAbsolute(inputPath) || /[\u0000\r\n]/.test(inputPath)) throw new Error('CODEX_NATIVE_INPUT_FILE_INVALID')
    const lexical = await fs.lstat(inputPath)
    if (lexical.isSymbolicLink()) throw new Error('CODEX_NATIVE_INPUT_FILE_SYMLINK_FORBIDDEN')
    const resolved = await fs.realpath(inputPath)
    const stat = await fs.stat(resolved)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error('CODEX_NATIVE_INPUT_FILE_INVALID')
    const realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.resolve(root))))
    if (!realRoots.some(root => pathInside(resolved, root))) throw new Error('CODEX_NATIVE_INPUT_FILE_OUTSIDE_ALLOWED_ROOT')
    return resolved
  }

  async steerTurn(
    thread: Pick<NativeCodexThread, 'id'>,
    turn: NativeCodexTurn,
    input: NativeCodexTurnInput[],
    clientUserMessageId?: string,
    additionalContext?: NativeCodexAdditionalContext,
  ): Promise<void> {
    if (!nonEmptyText(thread.id) || !nonEmptyText(turn.id) || input.length === 0 || input.length > 64 || !input.every(validateTurnInput)) {
      throw new Error('CODEX_NATIVE_STEER_INPUT_INVALID')
    }
    if (clientUserMessageId !== undefined && !nonEmptyText(clientUserMessageId, 512)) {
      throw new Error('CODEX_NATIVE_CLIENT_MESSAGE_ID_INVALID')
    }
    const sourceContext = nativeAdditionalContext(additionalContext)
    const nativeInput = await Promise.all(input.map(item => this.normalizeTurnInput(thread.id, item)))
    await this.requireClient().request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(sourceContext === undefined ? {} : { additionalContext: sourceContext }),
      input: nativeInput,
    })
  }

  async interruptTurn(thread: Pick<NativeCodexThread, 'id'>, turn: NativeCodexTurn): Promise<void> {
    if (!nonEmptyText(thread.id) || !nonEmptyText(turn.id)) throw new Error('CODEX_NATIVE_TURN_ID_INVALID')
    await this.requireClient().request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    this.activeTurns.delete(turn.id)
    this.activeTurnThreads.delete(turn.id)
  }

  async archiveThread(thread: Pick<NativeCodexThread, 'id'>): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('thread/archive', { threadId: thread.id })
    this.threadWorkspaces.delete(thread.id)
    this.loadedThreads.delete(thread.id)
  }

  /** Called by the UI projection after an authoritative `turn/completed` event. */
  markTurnCompleted(turnId: string): void {
    this.activeTurns.delete(turnId)
    this.activeTurnThreads.delete(turnId)
  }

  private observeSourceNotification(notification: CodexNativeNotification): void {
    const params = jsonObject(notification.params)
    if (notification.method === 'thread/started') {
      const thread = jsonObject(params?.thread)
      const id = thread?.id
      if (!thread || !nonEmptyText(id, 200)) return
      const parentThreadId = sourceThreadParentId(thread)
      const inheritedWorkspace = parentThreadId === undefined
        ? undefined
        : this.threadWorkspaces.get(parentThreadId)
      if (inheritedWorkspace) this.threadWorkspaces.set(id, inheritedWorkspace)
      this.loadedThreads.add(id)
      return
    }
    const threadIdValue = nonEmptyText(params?.threadId, 200) ? params.threadId : undefined
    const turn = jsonObject(params?.turn)
    const turnIdValue = nonEmptyText(turn?.id, 200)
      ? turn.id
      : nonEmptyText(params?.turnId, 200)
        ? params.turnId
        : undefined
    if (notification.method === 'turn/started' && threadIdValue && turnIdValue) {
      this.activeTurns.add(turnIdValue)
      this.activeTurnThreads.set(turnIdValue, threadIdValue)
      return
    }
    if (notification.method === 'turn/completed' && turnIdValue) {
      this.markTurnCompleted(turnIdValue)
      return
    }
    if ((notification.method === 'thread/archived' || notification.method === 'thread/deleted') && threadIdValue) {
      this.threadWorkspaces.delete(threadIdValue)
      this.loadedThreads.delete(threadIdValue)
    }
  }

  /** A provider mutation must not interrupt or split a source-native Turn. */
  assertModelRouteMayChange(): void {
    // Once the only App Server child is gone, no source-native Turn is still
    // running in this process. Its durable status must instead be reconciled
    // by a fresh `thread/resume`, so stale local ids cannot block recovery.
    if (this.client && !this.client.isAvailable()) return
    if (this.activeTurns.size > 0 || this.pendingTurnStarts > 0) {
      throw new Error('CODEX_NATIVE_ROUTE_CHANGE_REQUIRES_IDLE')
    }
  }

  private assertWindowsSandboxSetupNotInProgress(): void {
    if (this.windowsSandboxSetupInProgress) {
      throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_SETUP_IN_PROGRESS')
    }
  }

  /**
   * Revoke the current process-local provider capability after credential or
   * route settings change. The durable Rust Thread Store is intentionally
   * retained and idle Threads are source-resumed by `ensureThread`.
   */
  async invalidateModelRoute(): Promise<void> {
    this.assertModelRouteMayChange()
    this.routeGeneration += 1
    await this.closeCurrentProcess()
  }

  async close(): Promise<void> {
    this.routeGeneration += 1
    await this.closeCurrentProcess()
  }

  private async closeCurrentProcess(): Promise<void> {
    if (this.closePromise) return await this.closePromise
    this.closePromise = this.closeOnce()
    try { await this.closePromise } finally { this.closePromise = undefined }
  }

  /** Synchronous desktop-shutdown path; no persisted Agent state is deleted. */
  closeImmediately(): void {
    const client = this.client
    const provider = this.provider
    const startingClients = [...this.startingClients]
    const startingProviders = [...this.startingProviders]
    this.client = undefined
    this.provider = undefined
    this.configuredRouteKey = undefined
    this.activeTurns.clear()
    this.activeTurnThreads.clear()
    this.pendingTurnStarts = 0
    this.pendingTurnThreads.clear()
    this.workspaceMutationRoots.clear()
    this.loadedThreads.clear()
    this.threadWorkspaces.clear()
    this.startingClients.clear()
    this.startingProviders.clear()
    this.routeGeneration += 1
    client?.closeImmediately()
    for (const pendingClient of startingClients) pendingClient.closeImmediately()
    // A sudden Electron shutdown must revoke the per-process loopback
    // capability as well as killing Rust. `close()` synchronously aborts its
    // active requests and destroys sockets before awaiting the local server's
    // close callback, so it is safe to initiate from before-quit.
    void provider?.close().catch(() => undefined)
    for (const pendingProvider of startingProviders) void pendingProvider.close().catch(() => undefined)
  }

  private async closeOnce(): Promise<void> {
    const client = this.client
    const provider = this.provider
    const startingClients = [...this.startingClients]
    const startingProviders = [...this.startingProviders]
    this.client = undefined
    this.provider = undefined
    this.configuredRouteKey = undefined
    this.activeTurns.clear()
    this.activeTurnThreads.clear()
    this.pendingTurnStarts = 0
    this.pendingTurnThreads.clear()
    this.workspaceMutationRoots.clear()
    this.windowsSandboxSetupInProgress = false
    this.loadedThreads.clear()
    this.startingClients.clear()
    this.startingProviders.clear()
    await client?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await Promise.all(startingClients.map(pendingClient => pendingClient.close().catch(() => undefined)))
    await Promise.all(startingProviders.map(pendingProvider => pendingProvider.close().catch(() => undefined)))
  }

  private requireClient(): CodexNativeAppServerClient {
    if (!this.client || !this.provider) throw new Error('CODEX_NATIVE_RUNTIME_UNAVAILABLE')
    return this.client
  }

  private async ensureClient(route: CodexNativeModelRoute, cwd: string): Promise<CodexNativeAppServerClient> {
    const nextRouteKey = routeKey(route)
    if (this.client && this.configuredRouteKey === nextRouteKey && this.client.isAvailable()) return this.client
    if (this.startClientPromise) {
      if (this.startingRouteKey === nextRouteKey) return await this.startClientPromise
      await this.startClientPromise.catch(() => undefined)
      return await this.ensureClient(route, cwd)
    }
    const start = this.startClient(route, cwd, nextRouteKey)
    this.startingRouteKey = nextRouteKey
    this.startClientPromise = start
    try {
      return await start
    } finally {
      if (this.startClientPromise === start) {
        this.startClientPromise = undefined
        this.startingRouteKey = undefined
      }
    }
  }

  private async startClient(
    route: CodexNativeModelRoute,
    cwd: string,
    nextRouteKey: string,
  ): Promise<CodexNativeAppServerClient> {
    // An unexpected child exit invalidates only the process connection. It
    // must not be treated as a live Turn or prevent the Rust Thread Store from
    // reconciling the prior turn under a fresh App Server process.
    if (!this.client || this.client.isAvailable()) this.assertModelRouteMayChange()
    const generation = ++this.routeGeneration
    await this.closeCurrentProcess()
    const provider = await startCodexNativeProvider(route)
    this.startingProviders.add(provider)
    let client: CodexNativeAppServerClient | undefined
    try {
      const engineHome = path.join(absoluteDirectory(this.options.userDataPath), 'agent-runtime')
      client = new CodexNativeAppServerClient({
        command: await nativeAppServerCommand(this.options.desktopRoot),
        engineHome,
        cwd,
        configOverrides: provider.configOverrides,
        environment: provider.environment,
        onNotification: async notification => {
          this.observeSourceNotification(notification)
          try {
            await this.options.onNotification?.(notification)
          } catch {
            // A renderer projection may disappear during navigation. It must
            // not terminate the authoritative Rust session or strand a tool.
          }
          if (notification.method === 'windowsSandbox/setupCompleted') {
            const completed = jsonObject(notification.params)
            this.windowsSandboxSetupInProgress = false
            // Core writes the selected mode only after source setup succeeds.
            // Restart its process now so the next `readiness` and Thread load
            // use that source-owned persisted configuration.
            if (completed?.success === true) await this.invalidateModelRoute()
          }
        },
        onServerRequest: this.options.onServerRequest,
        onUnavailable: error => {
          this.windowsSandboxSetupInProgress = false
          this.options.onAppServerUnavailable?.(error)
        },
      })
      this.startingClients.add(client)
      await client.start()
      this.startingClients.delete(client)
      if (generation !== this.routeGeneration) {
        await client.close().catch(() => undefined)
        throw new Error('CODEX_NATIVE_ROUTE_CHANGED')
      }
      this.startingProviders.delete(provider)
      this.client = client
      this.provider = provider
      this.configuredRouteKey = nextRouteKey
      return client
    } catch (error) {
      if (client) {
        this.startingClients.delete(client)
        await client.close().catch(() => undefined)
      }
      this.startingProviders.delete(provider)
      await provider.close().catch(() => undefined)
      throw error
    }
  }

  private async resumeStoredThread(threadIdValue: string, route: CodexNativeModelRoute): Promise<NativeCodexThread> {
    const cwd = this.threadWorkspaces.get(threadIdValue)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const client = await this.ensureClient(route, cwd)
    const response = await client.request<CodexNativeJsonObject>('thread/resume', {
      threadId: threadIdValue,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      // The provider id stays fixed across managed and personal routes, so
      // Rust remains the only durable owner of Thread metadata. Sending the
      // selected model turns a changed credential route into a safe resume
      // mismatch instead of silently sending an old Thread to a new model.
      modelProvider: NATIVE_PROVIDER_ID,
      model: this.provider!.model,
    })
    const thread = projectNativeCodexThreadResponse(response)
    const id = thread.id
    if (id !== threadIdValue) throw new Error('CODEX_NATIVE_THREAD_RESPONSE_INVALID')
    for (const [activeTurnId, activeThreadId] of this.activeTurnThreads) {
      if (activeThreadId !== id) continue
      this.activeTurnThreads.delete(activeTurnId)
      this.activeTurns.delete(activeTurnId)
    }
    for (const activeTurnId of thread.activeTurnIds) {
      this.activeTurns.add(activeTurnId)
      this.activeTurnThreads.set(activeTurnId, id)
    }
    this.loadedThreads.add(id)
    return thread
  }

  private async workspace(value: string): Promise<string> {
    const resolved = absoluteDirectory(value)
    const stat = await fs.lstat(resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_NATIVE_WORKSPACE_INVALID')
    return await fs.realpath(resolved)
  }
}
