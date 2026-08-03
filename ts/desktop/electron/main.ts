import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage, screen, session, webContents } from 'electron'
import { autoUpdater } from 'electron-updater'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import { imageWorkbenchIpcResponse } from './ipc/imageResponse'
import {
  imageAdoptCandidateIpcPayloadSchema,
  imageSelectArtboardVersionIpcPayloadSchema,
  imageApplyCanvasCommandIpcPayloadSchema,
  imageCancelGenerationOperationIpcPayloadSchema,
  imageCreateCanvasIpcPayloadSchema,
  imageCreateCreativePlanIpcPayloadSchema,
  imageCreateDeliverySpecRevisionIpcPayloadSchema,
  imageCreateGenerationRoundIpcPayloadSchema,
  imageDecideCandidateIpcPayloadSchema,
  imageDeriveCandidateIpcPayloadSchema,
  imageEstimateDerivationIpcPayloadSchema,
  imageEstimateGenerationRoundIpcPayloadSchema,
  imageExportDeliveryIpcPayloadSchema,
  imagePreflightCanvasIpcPayloadSchema,
  imageRenderCanvasIpcPayloadSchema,
  imageSaveOutputIpcPayloadSchema,
  imageStartOperationIpcPayloadSchema,
  imageSubmitProjectIpcPayloadSchema,
  imageUpdateUnknownProjectIpcPayloadSchema,
  imageUpdateReferenceControlIpcPayloadSchema,
  isElectronIpcChannel,
  validateElectronIpcPayload,
} from './ipc/capabilities'
import { ElectronServerRuntime } from './services/serverRuntime'
import { openDialog, saveDialog } from './services/dialogs'
import { openExternalUrl, openSystemPath, openSystemSettingsUrl } from './services/shell'
import {
  notificationPermissionState,
  requestNotificationPermission,
  sendDesktopNotification,
} from './services/notifications'
import { installApplicationMenu } from './services/menu'
import { acquireSingleInstanceLock } from './services/singleInstance'
import { installTray, shouldInstallTray, type TrayController } from './services/tray'
import {
  requireProductGatewayConfig,
  resolveProductGatewayConfig,
} from './services/productConfig'
import { ensureInstallationId } from './services/installationId'
import { ElectronUpdaterService } from './services/updater'
import { createUpdateSmokeUpdaterFromEnv } from './services/updateSmoke'
import { ElectronImageActions } from './services/imageActions'
import { ElectronVideoActions } from './services/videoActions'
import {
  applyDefaultConfigDir,
  applyStartupPortableMode,
  detectPortableDir,
  getAppMode,
  setAppMode,
  type PortableDetection,
} from './services/appMode'
import { createCredentialStore, EphemeralCredentialStore, retireInstallationSessionArtifacts } from './services/keychain'
import { ProviderCredentialService } from './services/providerCredentials'
import {
  ElectronCodexNativeRuntime,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
  type NativeCodexCollaborationMode,
  type NativeCodexMarketplaceAddInput,
  type NativeExternalAgentMigrationItem,
  type NativeCodexPermissionMode,
  type NativeCodexPluginReference,
  type NativeCodexStartReviewInput,
  type CodexNativeServerRequest,
  type NativeCodexSkillSelector,
  type NativeCodexThreadGoalSetInput,
  type NativeCodexTurnInput,
} from './services/codexNativeAppServer'
import type { CodexNativeModelRoute } from './services/codexNativeProvider'
import { InstallationSessionManager } from './services/installationSession'
import { defaultProviderModel, textReasoningRegistryEntry } from '../../../gateway/providerRegistry'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import {
  installMainWindowNavigationGuards,
  isTrustedMainWindowFrame,
  isTrustedMainWindowNavigationUrl,
} from './services/navigationGuards'
import { logNotificationSmokeRendererAck, scheduleNotificationSmoke } from './services/notificationSmoke'
import { normalizeZoomFactor } from './services/zoom'
import { readComputerUseConfiguration, writeComputerUseConfiguration } from './services/computerUseConfiguration'
import {
  getChromeNativeMessagingHostStatus,
  installChromeNativeMessagingHost,
  uninstallChromeNativeMessagingHost,
} from './services/chromeNativeMessaging'
import {
  readBrowserPolicyConfiguration,
  writeBrowserPolicyConfiguration,
  type BrowserPolicyConfiguration,
} from './services/browserPolicyConfiguration'
import { InAppBrowserHost } from './services/inAppBrowserHost'
import { requestRecordReplayStop } from './services/recordReplayLifecycle'
import { ScheduledAgentTaskService, type ScheduledAgentTask, type ScheduledAgentTaskInput } from './services/scheduledAgentTasks'
import { resolveRendererEntry } from './services/rendererEntry'
import {
  nativeInteractiveServerRequest,
  nativeServerRequestKey,
  unsupportedNativeServerRequestFallback,
  validateNativeServerRequestResponse,
  type NativeInteractiveServerRequestMethod,
} from './services/nativeServerRequest'
import { writeWindowSmokeSnapshot } from './services/windowSmoke'
import {
  installWindowLifecycle,
  readWindowState,
  refreshWindowsDragHitTest,
  restoreWindowMaximized,
  saveWindowState,
  showMainWindow,
  windowChromeOptionsForPlatform,
  windowOptionsFromState,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
} from './services/windows'

// Own the product identity before anything resolves app.getPath('userData').
// This keeps BilliardBuddy state isolated from every other installed application.
app.setName('BilliardBuddy')

const mediaUiCapability = randomBytes(32).toString('base64url')
const gatewayAccessTokenCapability = randomBytes(32).toString('base64url')

let mainWindow: BrowserWindow | null = null
let serverRuntime: ElectronServerRuntime | null = null
let installationSessionManager: InstallationSessionManager | null = null
let updaterService: ElectronUpdaterService | null = null
let imageActions: ElectronImageActions | null = null
let videoActions: ElectronVideoActions | null = null
let providerCredentialService: ProviderCredentialService | null = null
let nativeAgentRuntime: ElectronCodexNativeRuntime | null = null
let inAppBrowserHost: InAppBrowserHost | null = null
let scheduledAgentTasks: ScheduledAgentTaskService | null = null
let isQuitting = false
let trayController: TrayController | null = null
const trustedProductWindowEntries = new Map<BrowserWindow, string>()

type PendingNativeAgentServerRequest = {
  ownerId: number
  sourceRequestKey: string
  method: NativeInteractiveServerRequestMethod
  params: CodexNativeJsonObject
  resolve(value: CodexNativeJsonObject): void
  reject(error: Error): void
  cleanup(): void
}

const nativeAgentThreadOwners = new Map<string, number>()
const nativeAgentTurnOwners = new Map<string, number>()
const nativeAgentServerRequests = new Map<string, PendingNativeAgentServerRequest>()
/** Windows Sandbox setup is source-global, so it has one explicit UI owner. */
let nativeWindowsSandboxSetupOwnerId: number | undefined

type PendingExternalAgentDetection = {
  ownerId: number
  threadId: string
  migrationSource?: string
  items: readonly NativeExternalAgentMigrationItem[]
}

const pendingExternalAgentDetections = new Map<string, PendingExternalAgentDetection>()
const permittedExternalAgentMigrationTypes = new Set(['AGENTS_MD', 'SKILLS', 'SUBAGENTS', 'COMMANDS'])

function externalAgentMigrationItemType(item: NativeExternalAgentMigrationItem): string | undefined {
  const itemType = item.itemType
  return typeof itemType === 'string' ? itemType : undefined
}

function safeExternalAgentMigrationItems(response: CodexNativeJsonObject): readonly NativeExternalAgentMigrationItem[] {
  const items = response.items
  if (!Array.isArray(items)) return []
  return items.filter((item): item is NativeExternalAgentMigrationItem => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    return permittedExternalAgentMigrationTypes.has(externalAgentMigrationItemType(item as NativeExternalAgentMigrationItem) ?? '')
  })
}

function externalAgentMigrationSummary(item: NativeExternalAgentMigrationItem): string {
  const type = externalAgentMigrationItemType(item) ?? 'UNKNOWN'
  const description = typeof item.description === 'string' ? item.description.replace(/[\r\n]+/g, ' ').slice(0, 240) : ''
  return description ? `${type}: ${description}` : type
}

function appRoot() {
  return app.isPackaged ? app.getAppPath() : process.cwd()
}

function unpackedRoot() {
  const root = appRoot()
  return app.isPackaged ? root.replace(/\.asar$/, '.asar.unpacked') : root
}

/** The only built-in marketplace source; Rust remains its installer and registry. */
function bundledAgentMarketplaceRoot() {
  return path.join(unpackedRoot(), 'runtime-assets', 'agent-marketplace')
}

function preloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preload.cjs')
}

function rendererEntry() {
  return resolveRendererEntry({
    isPackaged: app.isPackaged,
    appRoot: appRoot(),
    env: process.env,
  })
}

async function loadRendererEntry(
  window: BrowserWindow,
  entry: string,
  query: Record<string, string> = {},
) {
  if (/^https?:\/\//.test(entry)) {
    const url = new URL(entry)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
    await window.loadURL(url.toString())
  } else {
    await window.loadFile(entry, { query })
  }
}

function registerTrustedProductWindow(window: BrowserWindow, entry: string) {
  trustedProductWindowEntries.set(window, entry)
  window.once('closed', () => {
    trustedProductWindowEntries.delete(window)
  })
}

function getInstallationSessionManager() {
  installationSessionManager ??= (() => {
    const userDataPath = app.getPath('userData')
    // Installation authentication is automatic and is not a user-owned API
    // key. Keeping its refresh proof in macOS Keychain caused a credential
    // prompt on ordinary app startup. Retire only this old persisted session;
    // provider-credentials stay in the OS vault and are read only when the
    // user explicitly chooses a personal model connection.
    try {
      retireInstallationSessionArtifacts(process.platform, userDataPath)
    } catch (error) {
      console.warn('[desktop] could not clear retired installation session', error)
    }
    const config = requireProductGatewayConfig(resolveProductGatewayConfig({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      devBuildDir: path.join(unpackedRoot(), 'build'),
      env: process.env,
    }))
    return new InstallationSessionManager({
      gatewayUrl: config.url,
      installationId: ensureInstallationId(process.env.BILLIARDBUDDY_CONFIG_DIR || userDataPath),
      onTokenChanged: token => serverRuntime?.setInstallationAccessToken(token),
      onSessionFailure: error => console.error('[desktop] installation session update failed', error),
    }, new EphemeralCredentialStore())
  })()
  return installationSessionManager
}

/** Main is the only desktop process allowed to read user-owned provider keys. */
function getProviderCredentialService(): ProviderCredentialService {
  providerCredentialService ??= new ProviderCredentialService(
    createCredentialStore(process.platform, app.getPath('userData'), 'provider-credentials', safeStorage),
  )
  return providerCredentialService
}

function nativeProtocolObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function nativeProtocolText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined
}

function nativeThreadId(params: unknown): string | undefined {
  const value = nativeProtocolObject(params)
  return nativeProtocolText(value?.threadId) ?? nativeProtocolText(nativeProtocolObject(value?.thread)?.id)
}

function nativeTurnId(params: unknown): string | undefined {
  const value = nativeProtocolObject(params)
  return nativeProtocolText(value?.turnId) ?? nativeProtocolText(nativeProtocolObject(value?.turn)?.id)
}

function nativeAgentPermissionMode(value: unknown): NativeCodexPermissionMode {
  if (value === undefined) return 'ask'
  if (value === 'ask' || value === 'approve-for-me' || value === 'full-access') return value
  throw new Error('CODEX_NATIVE_PERMISSION_MODE_INVALID')
}

function nativeAgentCollaborationMode(value: unknown): NativeCodexCollaborationMode | undefined {
  if (value === undefined || value === 'default' || value === 'plan') return value
  throw new Error('CODEX_NATIVE_COLLABORATION_MODE_INVALID')
}

/**
 * Collaboration mode changes subsequent native Agent behavior. Until the new
 * renderer owns this selection, keep the acknowledgement in privileged Main
 * instead of letting an IPC caller silently enable the planning preset.
 */
async function confirmNativeAgentCollaborationMode(
  owner: BrowserWindow,
  mode: NativeCodexCollaborationMode | undefined,
): Promise<void> {
  if (mode === undefined || mode === 'default') return
  const { dialog } = await import('electron')
  const result = await dialog.showMessageBox(owner, {
    type: 'question',
    title: '切换到 Agent 规划模式？',
    message: '本次及后续任务将使用 BilliardBuddy 的内置规划模式。',
    detail: '不会安装第三方插件或加载额外技能目录；现有工具、文件、网络和确认设置保持不变。',
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('CODEX_NATIVE_COLLABORATION_MODE_DECLINED')
}

/**
 * `danger-full-access` means the source Rust sandbox stops mediating disk and
 * network operations. Keep its confirmation in privileged Main, rather than
 * trusting a renderer-only modal or a legacy renderer-side permission prompt.
 */
async function confirmNativeAgentFullAccess(owner: BrowserWindow): Promise<void> {
  const { dialog } = await import('electron')
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '启用 Agent 完全访问？',
    message: 'Agent 将可读取和修改这台电脑上的任意文件，并执行带网络的命令。',
    detail: '此模式不再逐项请求批准。你可以随时在 Agent 权限中切回受限模式。',
    buttons: ['取消', '启用完全访问'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('CODEX_NATIVE_FULL_ACCESS_DECLINED')
}

/**
 * The source Rust Core performs the actual setup, persistence and UAC flow.
 * Main only makes this machine-level action explicit before forwarding it.
 */
async function confirmNativeAgentWindowsSandboxSetup(
  owner: BrowserWindow,
  mode: 'elevated' | 'unelevated',
): Promise<void> {
  const { dialog } = await import('electron')
  const elevated = mode === 'elevated'
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '初始化 Windows Agent 沙箱？',
    message: elevated
      ? 'BilliardBuddy 将配置 Windows Agent 沙箱，Windows 会要求管理员确认。'
      : 'BilliardBuddy 将配置 Windows Agent 沙箱。',
    detail: '这不是“完全访问”。沙箱配置只用于 BilliardBuddy，并保存在本应用的私有数据目录中。',
    buttons: ['取消', '继续初始化'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_SETUP_DECLINED')
}

/**
 * Marketplace and Skill-root mutations change future Rust Agent behavior and
 * can fetch or activate third-party instructions/tools. Keep the consent in
 * privileged Main until the replacement renderer provides this interaction.
 */
async function confirmNativeAgentExtensionChange(
  owner: BrowserWindow,
  title: string,
  message: string,
  detail: string,
): Promise<void> {
  const { dialog } = await import('electron')
  const preview = detail.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 1_000)
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title,
    message,
    detail: preview,
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('CODEX_NATIVE_EXTENSION_CHANGE_DECLINED')
}

function scheduledTaskDescription(task: Pick<ScheduledAgentTask, 'schedule'>): string {
  const schedule = task.schedule
  if (schedule.kind === 'once') return `一次：${new Date(schedule.at).toLocaleString()}`
  if (schedule.kind === 'interval') return `每 ${Math.round(schedule.everyMs / 60_000)} 分钟`
  const clock = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  if (schedule.kind === 'daily') return `每天 ${clock}`
  return `每周 ${schedule.days.join(', ')} ${clock}`
}

/** A schedule starts an unattended native Turn, so enabling it is privileged. */
async function confirmNativeAgentScheduledTask(
  owner: BrowserWindow,
  task: Pick<ScheduledAgentTaskInput | ScheduledAgentTask, 'prompt' | 'schedule'>,
): Promise<void> {
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: '启用 Agent 计划任务？',
    message: '到期时，BilliardBuddy 会在应用仍运行的前提下恢复这个任务并继续执行。',
    detail: `频率：${scheduledTaskDescription(task)}\n任务：${task.prompt.replace(/[\r\n]+/g, ' ').slice(0, 600)}\n\n任务仍遵循当前的文件、网络、插件和确认设置；没有可用窗口或应用已退出时不会启动。`,
    buttons: ['取消', '启用计划任务'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_DECLINED')
}

/**
 * A background terminal is a process Rust Core started for this Thread. It is
 * never an arbitrary operating-system pid, but stopping one still ends a
 * user-visible command, so consent stays in privileged Main.
 */
async function confirmNativeAgentBackgroundTerminalChange(
  owner: BrowserWindow,
  title: string,
  message: string,
  detail: string,
): Promise<void> {
  const { dialog } = await import('electron')
  const preview = detail.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 1_000)
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title,
    message,
    detail: preview,
    buttons: ['取消', '停止终端'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (result.response !== 1) throw new Error('CODEX_NATIVE_BACKGROUND_TERMINAL_CHANGE_DECLINED')
}

function sendNativeAgentEvent(ownerId: number, payload: unknown): boolean {
  const owner = webContents.fromId(ownerId)
  if (!owner || owner.isDestroyed()) return false
  owner.send(ELECTRON_EVENT_CHANNELS.nativeAgentEvent, payload)
  return true
}

function releaseNativeAgentServerRequest(requestId: string): PendingNativeAgentServerRequest | undefined {
  const pending = nativeAgentServerRequests.get(requestId)
  if (!pending) return undefined
  nativeAgentServerRequests.delete(requestId)
  pending.cleanup()
  return pending
}

function rejectNativeAgentServerRequests(error: Error): void {
  for (const requestId of [...nativeAgentServerRequests.keys()]) {
    releaseNativeAgentServerRequest(requestId)?.reject(error)
  }
}

function sourceRequestKeyFromResolvedNotification(params: unknown): string | undefined {
  const requestId = nativeProtocolObject(params)?.requestId
  return typeof requestId === 'string' || typeof requestId === 'number'
    ? nativeServerRequestKey(requestId)
    : undefined
}

function forwardNativeAgentNotification(notification: CodexNativeNotification): void {
  const threadId = nativeThreadId(notification.params)
  const turnId = nativeTurnId(notification.params)
  const ownerId = threadId
    ? nativeAgentThreadOwners.get(threadId)
    : turnId
      ? nativeAgentTurnOwners.get(turnId)
      : notification.method === 'windowsSandbox/setupCompleted'
        ? nativeWindowsSandboxSetupOwnerId
        : undefined
  if (notification.method === 'serverRequest/resolved') {
    const sourceRequestKey = sourceRequestKeyFromResolvedNotification(notification.params)
    if (sourceRequestKey) {
      for (const [requestId, pending] of nativeAgentServerRequests) {
        if (pending.sourceRequestKey !== sourceRequestKey) continue
        releaseNativeAgentServerRequest(requestId)?.reject(new Error('CODEX_NATIVE_SERVER_REQUEST_RESOLVED'))
        sendNativeAgentEvent(pending.ownerId, {
          type: 'server-request-resolved',
          requestId,
          method: pending.method,
        })
      }
    }
  }
  if (ownerId !== undefined) {
    sendNativeAgentEvent(ownerId, {
      type: 'notification',
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    })
  }
  if (notification.method === 'turn/completed' && turnId) nativeAgentTurnOwners.delete(turnId)
  if ((notification.method === 'thread/archived' || notification.method === 'thread/deleted') && threadId) {
    nativeAgentThreadOwners.delete(threadId)
  }
  if (notification.method === 'windowsSandbox/setupCompleted') {
    nativeWindowsSandboxSetupOwnerId = undefined
  }
}

async function requestNativeAgentServerRequest(request: CodexNativeServerRequest): Promise<CodexNativeJsonObject> {
  const safeFallback = unsupportedNativeServerRequestFallback(request)
  if (safeFallback) return safeFallback
  const method = nativeInteractiveServerRequest(request.method)
  const params = nativeProtocolObject(request.params)
  const threadId = nativeThreadId(request.params)
  if (!method || !params || !threadId) throw new Error('CODEX_NATIVE_SERVER_REQUEST_UNSUPPORTED')
  const ownerId = nativeAgentThreadOwners.get(threadId)
  const owner = ownerId === undefined ? undefined : webContents.fromId(ownerId)
  if (ownerId === undefined || !owner || owner.isDestroyed()) {
    throw new Error('CODEX_NATIVE_SERVER_REQUEST_OWNER_UNAVAILABLE')
  }
  const requestId = randomBytes(18).toString('base64url')
  const sourceRequestKey = nativeServerRequestKey(request.id)
  return await new Promise<CodexNativeJsonObject>((resolve, reject) => {
    const cleanup = () => owner.removeListener('destroyed', onOwnerDestroyed)
    const onOwnerDestroyed = () => {
      releaseNativeAgentServerRequest(requestId)?.reject(new Error('CODEX_NATIVE_SERVER_REQUEST_OWNER_UNAVAILABLE'))
    }
    nativeAgentServerRequests.set(requestId, {
      ownerId,
      sourceRequestKey,
      method,
      params: params as CodexNativeJsonObject,
      resolve,
      reject,
      cleanup,
    })
    owner.once('destroyed', onOwnerDestroyed)
    if (!sendNativeAgentEvent(ownerId, {
      type: 'server-request',
      requestId,
      method,
      params,
    })) {
      releaseNativeAgentServerRequest(requestId)?.reject(new Error('CODEX_NATIVE_SERVER_REQUEST_OWNER_UNAVAILABLE'))
    }
  })
}

function managedNativeAgentModel(): string {
  const model = process.env.BB_GATEWAY_MODEL?.trim() || defaultProviderModel()
  const entry = textReasoningRegistryEntry(model)
  // The built-in Agent route is deliberately pinned to the managed DeepSeek
  // Responses provider. MiMo remains a visual/media capability and cannot be
  // turned into a second Agent model by an environment override.
  if (!entry || entry.provider !== 'deepseek' || entry.text_reasoning_transport !== 'responses') {
    throw new Error('CODEX_NATIVE_MANAGED_MODEL_INVALID')
  }
  return model
}

async function resolveNativeAgentRoute(): Promise<CodexNativeModelRoute> {
  const profile = getProviderCredentialService().agentTextReasoningProfile()
  if (profile) {
    return { kind: 'personal', profile }
  }
  const config = requireProductGatewayConfig(resolveProductGatewayConfig({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devBuildDir: path.join(unpackedRoot(), 'build'),
    env: process.env,
  }))
  const model = managedNativeAgentModel()
  return {
    kind: 'managed',
    gatewayUrl: config.url,
    resolveAccessToken: () => getInstallationSessionManager().accessToken(),
    model,
  }
}

function getNativeAgentRuntime(): ElectronCodexNativeRuntime {
  nativeAgentRuntime ??= new ElectronCodexNativeRuntime({
    desktopRoot: unpackedRoot(),
    userDataPath: app.getPath('userData'),
    onNotification: forwardNativeAgentNotification,
    onServerRequest: requestNativeAgentServerRequest,
    onAppServerUnavailable: error => {
      nativeWindowsSandboxSetupOwnerId = undefined
      rejectNativeAgentServerRequests(error)
    },
  })
  return nativeAgentRuntime
}

/** Start the dedicated Browser bridge before Core can launch its Browser MCP. */
function getInAppBrowserHost(): InAppBrowserHost {
  inAppBrowserHost ??= new InAppBrowserHost({
    userDataPath: app.getPath('userData'),
    mainWindow: () => mainWindow,
  })
  return inAppBrowserHost
}

/**
 * Scheduled work deliberately re-enters a durable Rust Thread.  There is no
 * second Agent loop in Electron: the host only persists cadence and starts a
 * normal native Turn when the desktop app is still running.
 */
function getScheduledAgentTasks(): ScheduledAgentTaskService {
  scheduledAgentTasks ??= new ScheduledAgentTaskService({
    userDataPath: app.getPath('userData'),
    run: async task => {
      const owner = mainWindow?.webContents
      if (!owner || owner.isDestroyed()) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_HOST_UNAVAILABLE')
      claimNativeAgentThread(owner.id, task.threadId)
      const runtime = getNativeAgentRuntime()
      await runtime.resumeThread({
        threadId: task.threadId,
        cwd: task.cwd,
        route: await resolveNativeAgentRoute(),
      })
      const turn = await runtime.startTurn(
        { id: task.threadId },
        [{ type: 'text', text: task.prompt }],
        `scheduled-${task.id}-${task.lastRunAt ?? task.nextRunAt}`,
      )
      nativeAgentTurnOwners.set(turn.id, owner.id)
      return { turnId: turn.id }
    },
    onEvent: event => {
      const owner = mainWindow?.webContents
      if (owner && !owner.isDestroyed()) sendNativeAgentEvent(owner.id, event)
    },
  })
  return scheduledAgentTasks
}

/**
 * A credential change revokes the local App Server process, not the durable
 * Rust Thread. Re-open that owned Thread through the current route before a
 * subsequent thread-scoped operation reaches Core.
 */
async function getReadyNativeAgentThreadRuntime(threadId: string): Promise<ElectronCodexNativeRuntime> {
  const runtime = getNativeAgentRuntime()
  await runtime.ensureThread({ id: threadId }, await resolveNativeAgentRoute())
  return runtime
}

function claimNativeAgentThread(ownerId: number, threadId: string): void {
  const existingOwnerId = nativeAgentThreadOwners.get(threadId)
  if (existingOwnerId !== undefined && existingOwnerId !== ownerId) {
    throw new Error('CODEX_NATIVE_THREAD_OWNED_BY_ANOTHER_WINDOW')
  }
  nativeAgentThreadOwners.set(threadId, ownerId)
}

function assertNativeAgentThreadOwner(ownerId: number, threadId: string): void {
  const existingOwnerId = nativeAgentThreadOwners.get(threadId)
  if (existingOwnerId !== ownerId) throw new Error('CODEX_NATIVE_THREAD_OWNER_REQUIRED')
}

function assertNativeAgentTurnOwner(ownerId: number, turnId: string): void {
  const existingOwnerId = nativeAgentTurnOwners.get(turnId)
  if (existingOwnerId !== ownerId) throw new Error('CODEX_NATIVE_TURN_OWNER_REQUIRED')
}

/** The renderer receives only summaries; user keys never leave Electron Main. */
async function mutateProviderCredentials<T>(mutation: (service: ProviderCredentialService) => T): Promise<T> {
  // A personal profile's raw key reaches only a single short-lived child.
  // Do not allow a settings write to silently leave that old child usable.
  // An active or starting Turn is intentionally rejected by the runtime: it
  // must finish or be interrupted before its model capability can change.
  nativeAgentRuntime?.assertModelRouteMayChange()
  const result = mutation(getProviderCredentialService())
  await nativeAgentRuntime?.invalidateModelRoute()
  return result
}

function getServerRuntime() {
  serverRuntime ??= new ElectronServerRuntime({
    desktopRoot: unpackedRoot(),
    appRoot: appRoot(),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
    // Packaged config contains only the public Gateway route.
    resolveGatewayConfig: () => requireProductGatewayConfig(
      resolveProductGatewayConfig({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        devBuildDir: path.join(unpackedRoot(), 'build'),
        env: process.env,
      }),
    ),
    // Only a short-lived access bearer reaches the local Server. Refresh proof
    // and stable installation identity remain in Electron Main.
    resolveInstallationAccessToken: () => getInstallationSessionManager().accessToken(),
    resolveCachedInstallationAccessToken: () => getInstallationSessionManager().cachedAccessToken(),
    mediaUiCapability,
    gatewayAccessTokenCapability,
  })
  return serverRuntime
}

function getImageActions() {
  imageActions ??= new ElectronImageActions({
    getServerUrl: () => getServerRuntime().getServerUrl(),
    capability: mediaUiCapability,
  })
  return imageActions
}

function getVideoActions() {
  videoActions ??= new ElectronVideoActions({
    getServerUrl: () => getServerRuntime().getServerUrl(),
    capability: mediaUiCapability,
  })
  return videoActions
}

function getUpdaterService() {
  const smokeUpdater = createUpdateSmokeUpdaterFromEnv(process.env)
  updaterService ??= new ElectronUpdaterService(smokeUpdater ?? autoUpdater, {
    async apply(proxy) {
      const config = proxy
        ? { proxyRules: proxy, proxyBypassRules: '<local>' }
        : {}
      await Promise.all([
        app.setProxy(config),
        session.defaultSession.setProxy(config),
      ])
      await session.defaultSession.forceReloadProxyConfig()
    },
  }, {
    updateConfigPath: !smokeUpdater && app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : undefined,
  })
  return updaterService
}

function currentWindow(event: Electron.IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) throw new Error('No BrowserWindow for Electron IPC event')
  return window
}

function isTrustedMainWindowIpcSender(event: Electron.IpcMainInvokeEvent): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  const entry = window ? trustedProductWindowEntries.get(window) : undefined
  return entry !== undefined
    && isTrustedMainWindowNavigationUrl(event.sender.getURL(), entry)
    && isTrustedMainWindowFrame(event.senderFrame, entry)
}

function registerHandler<T>(
  channel: ElectronIpcChannel,
  handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => T | Promise<T>,
) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedMainWindowIpcSender(event)) {
      throw new Error('Rejected Electron IPC from an untrusted renderer')
    }
    if (!isElectronIpcChannel(channel) || !validateElectronIpcPayload(channel, payload)) {
      throw new Error(`Invalid Electron IPC payload for ${channel}`)
    }
    return handler(event, payload)
  })
}

function registerImageHandler<T>(
  channel: ElectronIpcChannel,
  handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => T | Promise<T>,
) {
  registerHandler(channel, async (event, payload) => await imageWorkbenchIpcResponse(async () => await handler(event, payload)))
}

function emitNotificationAction(payload: unknown) {
  showMainWindow(mainWindow, app)
  mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.notificationAction, payload)
}

async function handleCommandInvoke(payload: unknown): Promise<unknown> {
  const { command, args } = payload as { command: string, args?: Record<string, unknown> }

  switch (command) {
    case 'plugin:notification|is_permission_granted':
      return notificationPermissionState(Notification) === 'granted'
    case 'plugin:notification|request_permission':
    case 'macos_request_notification_permission':
      return requestNotificationPermission(Notification)
    case 'macos_notification_permission_state':
      return notificationPermissionState(Notification)
    case 'macos_send_notification':
      return sendDesktopNotification({
        NotificationClass: Notification,
        options: args,
        onAction: emitNotificationAction,
      })
    case 'macos_open_notification_settings':
      return openSystemSettingsUrl('x-apple.systempreferences:com.apple.preference.notifications')
    case 'open_windows_notification_settings':
      return openSystemSettingsUrl('ms-settings:notifications')
    default:
      throw new Error(`Unsupported Electron command: ${command}`)
  }
}

function registerIpcHandlers() {
  registerHandler(ELECTRON_IPC_CHANNELS.appGetVersion, () => app.getVersion())
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => getServerRuntime().getServerUrl())
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSummary, () => getProviderCredentialService().summary())
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationProviderPresets, () =>
    getProviderCredentialService().providerPresets())
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationOpenProviderPortal, async (_event, payload) => {
    const preset = getProviderCredentialService().providerPreset(String(payload))
    await openExternalUrl(preset.api_key_url)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationDiscover, async (_event, payload) =>
    await getProviderCredentialService().discover(payload as Parameters<ProviderCredentialService['discover']>[0]))
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationDiscoverPreset, async (_event, payload) =>
    await getProviderCredentialService().discoverPreset(payload as Parameters<ProviderCredentialService['discoverPreset']>[0]))
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSavePreset, (_event, payload) =>
    mutateProviderCredentials(service => service.savePreset(payload as Parameters<ProviderCredentialService['savePreset']>[0])))
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSave, (_event, payload) =>
    mutateProviderCredentials(service => service.save(payload as Parameters<ProviderCredentialService['save']>[0])))
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationRemove, (_event, payload) =>
    mutateProviderCredentials(service => service.remove(String(payload))))
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentStartThread, async (event, payload) => {
    const input = payload as { cwd: string, permissionMode: unknown }
    const permissionMode = nativeAgentPermissionMode(input.permissionMode)
    if (permissionMode === 'full-access') await confirmNativeAgentFullAccess(currentWindow(event))
    const thread = await getNativeAgentRuntime().startThread({
      cwd: input.cwd,
      route: await resolveNativeAgentRoute(),
      permissionMode,
    })
    claimNativeAgentThread(event.sender.id, thread.id)
    return thread
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxReadiness, async (_event, payload) => {
    const input = payload as { cwd: string }
    return await getNativeAgentRuntime().getWindowsSandboxReadiness({
      cwd: input.cwd,
      route: await resolveNativeAgentRoute(),
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxSetupStart, async (event, payload) => {
    const input = payload as { cwd: string, mode: 'elevated' | 'unelevated' }
    if (process.platform !== 'win32') throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_UNAVAILABLE')
    if (nativeWindowsSandboxSetupOwnerId !== undefined) {
      throw new Error('CODEX_NATIVE_WINDOWS_SANDBOX_SETUP_IN_PROGRESS')
    }
    await confirmNativeAgentWindowsSandboxSetup(currentWindow(event), input.mode)
    nativeWindowsSandboxSetupOwnerId = event.sender.id
    try {
      return await getNativeAgentRuntime().startWindowsSandboxSetup({
        cwd: input.cwd,
        mode: input.mode,
        route: await resolveNativeAgentRoute(),
      })
    } catch (error) {
      if (nativeWindowsSandboxSetupOwnerId === event.sender.id) nativeWindowsSandboxSetupOwnerId = undefined
      throw error
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListThreads, async (_event, payload) => {
    const input = payload as {
      cwd: string
      cursor?: string
      limit?: number
      archived?: boolean
      searchTerm?: string
      sortKey?: 'created_at' | 'updated_at' | 'recency_at'
      sortDirection?: 'asc' | 'desc'
    }
    return await getNativeAgentRuntime().listThreads({
      ...input,
      route: await resolveNativeAgentRoute(),
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSearchThreads, async (_event, payload) => {
    const input = payload as {
      cwd: string
      searchTerm: string
      cursor?: string
      limit?: number
      archived?: boolean
      sortKey?: 'created_at' | 'updated_at' | 'recency_at'
      sortDirection?: 'asc' | 'desc'
    }
    return await getNativeAgentRuntime().searchThreads({
      ...input,
      route: await resolveNativeAgentRoute(),
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentResumeThread, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    const previousOwnerId = nativeAgentThreadOwners.get(input.threadId)
    claimNativeAgentThread(event.sender.id, input.threadId)
    try {
      return await getNativeAgentRuntime().resumeThread({
        threadId: input.threadId,
        cwd: input.cwd,
        route: await resolveNativeAgentRoute(),
      })
    } catch (error) {
      if (previousOwnerId === undefined) nativeAgentThreadOwners.delete(input.threadId)
      else nativeAgentThreadOwners.set(input.threadId, previousOwnerId)
      throw error
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentUnarchiveThread, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    const previousOwnerId = nativeAgentThreadOwners.get(input.threadId)
    claimNativeAgentThread(event.sender.id, input.threadId)
    try {
      return await getNativeAgentRuntime().unarchiveThread({
        ...input,
        route: await resolveNativeAgentRoute(),
      })
    } catch (error) {
      if (previousOwnerId === undefined) nativeAgentThreadOwners.delete(input.threadId)
      else nativeAgentThreadOwners.set(input.threadId, previousOwnerId)
      throw error
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentDeleteThread, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    const previousOwnerId = nativeAgentThreadOwners.get(input.threadId)
    claimNativeAgentThread(event.sender.id, input.threadId)
    try {
      await getNativeAgentRuntime().deleteThread({
        ...input,
        route: await resolveNativeAgentRoute(),
      })
      nativeAgentThreadOwners.delete(input.threadId)
    } catch (error) {
      if (previousOwnerId === undefined) nativeAgentThreadOwners.delete(input.threadId)
      else nativeAgentThreadOwners.set(input.threadId, previousOwnerId)
      throw error
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentReadThread, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).readThread({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentForkThread, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string, permissionMode: unknown, lastTurnId?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const permissionMode = nativeAgentPermissionMode(input.permissionMode)
    if (permissionMode === 'full-access') await confirmNativeAgentFullAccess(currentWindow(event))
    const thread = await getNativeAgentRuntime().forkThread({
      threadId: input.threadId,
      cwd: input.cwd,
      ...(input.lastTurnId === undefined ? {} : { lastTurnId: input.lastTurnId }),
      route: await resolveNativeAgentRoute(),
      permissionMode,
    })
    claimNativeAgentThread(event.sender.id, thread.id)
    return thread
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetThreadName, async (event, payload) => {
    const input = payload as { threadId: string, name: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).setThreadName({ id: input.threadId }, input.name)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentCompactThread, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).compactThread({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentRollbackThread, async (event, payload) => {
    const input = payload as { threadId: string, numTurns: number }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).rollbackThread(
      { id: input.threadId },
      input.numTurns,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListThreadTurns, async (event, payload) => {
    const input = payload as {
      threadId: string
      cursor?: string
      limit?: number
      sortDirection?: 'asc' | 'desc'
      itemsView?: 'notLoaded' | 'summary' | 'full'
    }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listThreadTurns({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListThreadItems, async (event, payload) => {
    const input = payload as {
      threadId: string
      turnId?: string
      cursor?: string
      limit?: number
      sortDirection?: 'asc' | 'desc'
    }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listThreadItems({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSearchThreadOccurrences, async (event, payload) => {
    const input = payload as { threadId: string, searchTerm: string, cursor?: string, limit?: number }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...search } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).searchThreadOccurrences({ id: threadId }, search)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListModels, async (event, payload) => {
    const input = payload as { threadId: string, cursor?: string, limit?: number, includeHidden?: boolean }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listModels({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentReadModelProviderCapabilities, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).readModelProviderCapabilities({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListPermissionProfiles, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string, cursor?: string, limit?: number }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listPermissionProfiles({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentReadConfigRequirements, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).readConfigRequirements({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetThreadMemoryMode, async (event, payload) => {
    const input = payload as { threadId: string, mode: 'enabled' | 'disabled' }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).setThreadMemoryMode({ id: input.threadId }, input.mode)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentResetMemory, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '清除 Agent 记忆？',
      'BilliardBuddy 将删除 Agent 保存的本地记忆。',
      '会话历史不会删除；本地记忆清除后无法恢复。',
    )
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).resetMemory({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListThreadSections, async (event, payload) => {
    const input = payload as { threadId: string, cursor?: string, limit?: number }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listThreadSections({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentCreateThreadSection, async (event, payload) => {
    const input = payload as { threadId: string, name: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).createThreadSection({ id: input.threadId }, input.name)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSection, async (event, payload) => {
    const input = payload as { threadId: string, sectionId: string, name: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).updateThreadSection(
      { id: input.threadId },
      input.sectionId,
      input.name,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentDeleteThreadSection, async (event, payload) => {
    const input = payload as { threadId: string, sectionId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '删除 Agent 会话分组？',
      'BilliardBuddy 将删除这个会话分组。',
      `分组 ID：${input.sectionId}\n分组中的会话不会被删除。`,
    )
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).deleteThreadSection(
      { id: input.threadId },
      input.sectionId,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentMoveThreadToSection, async (event, payload) => {
    const input = payload as { threadId: string, sectionId: string | null, beforeThreadId?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).moveThreadToSection(
      { id: input.threadId },
      input.sectionId,
      input.beforeThreadId,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentGetThreadGoal, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).getThreadGoal({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetThreadGoal, async (event, payload) => {
    const input = payload as { threadId: string } & NativeCodexThreadGoalSetInput
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...goal } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).setThreadGoal({ id: threadId }, goal)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentClearThreadGoal, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).clearThreadGoal({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListBackgroundTerminals, async (event, payload) => {
    const input = payload as { threadId: string, cursor?: string, limit?: number }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const { threadId, ...page } = input
    return await (await getReadyNativeAgentThreadRuntime(threadId)).listBackgroundTerminals({ id: threadId }, page)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentTerminateBackgroundTerminal, async (event, payload) => {
    const input = payload as { threadId: string, processId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentBackgroundTerminalChange(
      currentWindow(event),
      '停止 Agent 后台终端？',
      'BilliardBuddy 将停止这个会话启动的后台终端。',
      `后台终端 ID：${input.processId}\n只会停止这个会话记录的进程，不会终止任意系统进程。`,
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).terminateBackgroundTerminal(
      { id: input.threadId },
      input.processId,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentCleanBackgroundTerminals, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentBackgroundTerminalChange(
      currentWindow(event),
      '停止全部 Agent 后台终端？',
      'BilliardBuddy 将停止这个会话的全部后台终端。',
      '仍在运行的后台命令会结束；不会影响不属于这个会话的系统进程。',
    )
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).cleanBackgroundTerminals({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentUpdatePermissionMode, async (event, payload) => {
    const input = payload as { threadId: string, permissionMode: unknown }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const permissionMode = nativeAgentPermissionMode(input.permissionMode)
    if (permissionMode === 'full-access') await confirmNativeAgentFullAccess(currentWindow(event))
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).updatePermissionMode(
      { id: input.threadId },
      permissionMode,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentStartTurn, async (event, payload) => {
    const input = payload as {
      threadId: string
      input: Parameters<ElectronCodexNativeRuntime['startTurn']>[1]
      clientUserMessageId?: string
      collaborationMode?: NativeCodexCollaborationMode
    }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const collaborationMode = nativeAgentCollaborationMode(input.collaborationMode)
    await confirmNativeAgentCollaborationMode(currentWindow(event), collaborationMode)
    const turn = await (await getReadyNativeAgentThreadRuntime(input.threadId)).startTurn(
      { id: input.threadId },
      input.input,
      input.clientUserMessageId,
      collaborationMode,
    )
    nativeAgentTurnOwners.set(turn.id, event.sender.id)
    return turn
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentStartReview, async (event, payload) => {
    const input = payload as { threadId: string } & NativeCodexStartReviewInput
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const review = await (await getReadyNativeAgentThreadRuntime(input.threadId)).startReview(
      { id: input.threadId },
      input,
    )
    claimNativeAgentThread(event.sender.id, review.reviewThreadId)
    nativeAgentTurnOwners.set(review.turn.id, event.sender.id)
    return review
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn, async (event, payload) => {
    const input = payload as { threadId: string, turnId: string, input: NativeCodexTurnInput[], clientUserMessageId?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    assertNativeAgentTurnOwner(event.sender.id, input.turnId)
    await getNativeAgentRuntime().steerTurn(
      { id: input.threadId },
      { id: input.turnId },
      input.input,
      input.clientUserMessageId,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentInterruptTurn, async (event, payload) => {
    const input = payload as { threadId: string, turnId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    assertNativeAgentTurnOwner(event.sender.id, input.turnId)
    await getNativeAgentRuntime().interruptTurn({ id: input.threadId }, { id: input.turnId })
    nativeAgentTurnOwners.delete(input.turnId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentArchiveThread, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).archiveThread({ id: input.threadId })
    nativeAgentThreadOwners.delete(input.threadId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentResolveServerRequest, (event, payload) => {
    const input = payload as { requestId: string, response: unknown }
    const pending = nativeAgentServerRequests.get(input.requestId)
    if (!pending || pending.ownerId !== event.sender.id) throw new Error('CODEX_NATIVE_SERVER_REQUEST_OWNER_REQUIRED')
    const response = validateNativeServerRequestResponse(pending.method, pending.params, input.response)
    releaseNativeAgentServerRequest(input.requestId)?.resolve(response)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentConfigureMcpServer, async (event, payload) => {
    const input = payload as { threadId: string, name: string, config: CodexNativeJsonObject }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).configureMcpServer({ id: input.threadId }, input.name, input.config)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentRemoveMcpServer, async (event, payload) => {
    const input = payload as { threadId: string, name: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).removeMcpServer({ id: input.threadId }, input.name)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListMcpServerStatuses, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listMcpServerStatuses({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentStartMcpOAuth, async (event, payload) => {
    const input = payload as { threadId: string, name: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).startMcpOAuth({ id: input.threadId }, input.name)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListSkills, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listSkills({ id: input.threadId }, input.cwd)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetSkillEnabled, async (event, payload) => {
    const input = payload as { threadId: string, enabled: boolean } & NativeCodexSkillSelector
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).setSkillEnabled({ id: input.threadId }, input, input.enabled)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetExtraSkillRoots, async (event, payload) => {
    const input = payload as { threadId: string, roots: string[] }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const clearing = input.roots.length === 0
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      clearing ? '清除额外 Agent Skills？' : '加载额外 Agent Skills？',
      clearing
        ? '之后的 Agent Turn 将不再从此前额外目录加载技能。'
        : '这些目录中的 Skill 指令会影响之后的 Agent Turn；请只加载你信任的目录。',
      clearing ? '将清除额外 Skill 目录配置。' : input.roots.join('\n'),
    )
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).setExtraSkillRoots({ id: input.threadId }, input.roots)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentDetectExternalConfig, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string, includeHome: boolean, migrationSource?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const runtime = await getReadyNativeAgentThreadRuntime(input.threadId)
    const result = await runtime.detectExternalAgentConfig({ id: input.threadId }, input)
    const items = safeExternalAgentMigrationItems(result)
    const detectionId = randomBytes(18).toString('base64url')
    pendingExternalAgentDetections.set(detectionId, {
      ownerId: event.sender.id,
      threadId: input.threadId,
      ...(input.migrationSource === undefined ? {} : { migrationSource: input.migrationSource }),
      items,
    })
    while (pendingExternalAgentDetections.size > 32) {
      const oldest = pendingExternalAgentDetections.keys().next().value
      if (oldest === undefined) break
      pendingExternalAgentDetections.delete(oldest)
    }
    return {
      detectionId,
      items: items.map((item, index) => ({
        index,
        itemType: externalAgentMigrationItemType(item),
        description: typeof item.description === 'string' ? item.description : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      })),
    }
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentImportExternalConfig, async (event, payload) => {
    const input = payload as { threadId: string, detectionId: string, itemIndexes: number[] }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const detected = pendingExternalAgentDetections.get(input.detectionId)
    if (!detected || detected.ownerId !== event.sender.id || detected.threadId !== input.threadId) {
      throw new Error('CODEX_NATIVE_EXTERNAL_AGENT_DETECTION_REQUIRED')
    }
    const selected = input.itemIndexes
      .map(index => detected.items[index])
      .filter((item): item is NativeExternalAgentMigrationItem => item !== undefined)
    if (selected.length !== input.itemIndexes.length || selected.some(item => !permittedExternalAgentMigrationTypes.has(externalAgentMigrationItemType(item) ?? ''))) {
      throw new Error('CODEX_NATIVE_EXTERNAL_AGENT_IMPORT_SELECTION_INVALID')
    }
    const response = await dialog.showMessageBox(currentWindow(event), {
      type: 'warning',
      buttons: ['取消', '导入已选项目'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '导入其他智能体配置',
      message: '只会导入你已选择的指令、Skill、子智能体或命令。',
      detail: `${selected.map(externalAgentMigrationSummary).join('\n')}\n\n不会导入 API Key、完整配置、MCP、Hook、插件、记忆或历史会话。`,
    })
    if (response.response !== 1) return { cancelled: true }
    pendingExternalAgentDetections.delete(input.detectionId)
    const runtime = await getReadyNativeAgentThreadRuntime(input.threadId)
    return await runtime.importExternalAgentConfig(
      { id: input.threadId },
      selected,
      detected.migrationSource,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListScheduledTasks, async (event, payload) => {
    const input = payload as { threadId?: string }
    if (input.threadId !== undefined) assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return getScheduledAgentTasks().list(input.threadId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentCreateScheduledTask, async (event, payload) => {
    const input = payload as ScheduledAgentTaskInput
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentScheduledTask(currentWindow(event), input)
    return await getScheduledAgentTasks().create(input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSetScheduledTaskEnabled, async (event, payload) => {
    const input = payload as { threadId: string, taskId: string, enabled: boolean }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const task = getScheduledAgentTasks().list(input.threadId).find(candidate => candidate.id === input.taskId)
    if (!task) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_NOT_FOUND')
    if (input.enabled) await confirmNativeAgentScheduledTask(currentWindow(event), task)
    return await getScheduledAgentTasks().setEnabled(input.taskId, input.enabled)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentRemoveScheduledTask, async (event, payload) => {
    const input = payload as { threadId: string, taskId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const task = getScheduledAgentTasks().list(input.threadId).find(candidate => candidate.id === input.taskId)
    if (!task) throw new Error('BILLIARDBUDDY_SCHEDULED_TASK_NOT_FOUND')
    await getScheduledAgentTasks().remove(input.taskId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListHooks, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listHooks({ id: input.threadId }, input.cwd)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListPlugins, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listPlugins({ id: input.threadId }, input.cwd)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListInstalledPlugins, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listInstalledPlugins({ id: input.threadId }, input.cwd)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentReadPlugin, async (event, payload) => {
    const input = payload as { threadId: string } & NativeCodexPluginReference
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).readPlugin({ id: input.threadId }, input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentAddMarketplace, async (event, payload) => {
    const input = payload as { threadId: string } & NativeCodexMarketplaceAddInput
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '添加 Agent 插件市场？',
      'BilliardBuddy 将添加这个本地或 Git 插件来源。只添加你信任的来源。',
      `来源：${input.source}${input.refName === undefined ? '' : `\n版本：${input.refName}`}`,
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).addMarketplace({ id: input.threadId }, input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentAddBundledMarketplace, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '启用 BilliardBuddy 本地扩展？',
      'BilliardBuddy 将添加随应用安装的本地扩展来源。每个扩展仍须单独安装和启用。',
      '来源：BilliardBuddy 本地扩展',
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).addMarketplace(
      { id: input.threadId },
      { source: bundledAgentMarketplaceRoot() },
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentRemoveMarketplace, async (event, payload) => {
    const input = payload as { threadId: string, marketplaceName: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '移除 Agent 插件市场？',
      'BilliardBuddy 将移除此扩展来源的配置和本地缓存；已安装的扩展不会因此自动卸载。',
      `市场：${input.marketplaceName}`,
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).removeMarketplace({ id: input.threadId }, input.marketplaceName)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentUpgradeMarketplace, async (event, payload) => {
    const input = payload as { threadId: string, marketplaceName?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '更新 Agent 插件市场？',
      'BilliardBuddy 将从已配置来源检查更新并替换本地缓存。',
      input.marketplaceName === undefined ? '市场：全部已配置市场' : `市场：${input.marketplaceName}`,
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).upgradeMarketplace(
      { id: input.threadId },
      input.marketplaceName,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentInstallPlugin, async (event, payload) => {
    const input = payload as { threadId: string } & NativeCodexPluginReference
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '安装 Agent 插件？',
      '插件可以提供 Skills 和新工具。安装后仍需按实际用途启用并确认所需权限。',
      `插件：${input.pluginName}\n市场：${input.marketplacePath}`,
    )
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).installPlugin({ id: input.threadId }, input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentUninstallPlugin, async (event, payload) => {
    const input = payload as { threadId: string, pluginId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '卸载 Agent 插件？',
      'BilliardBuddy 将删除该插件的本地安装和启用配置。',
      `插件：${input.pluginId}`,
    )
    await (await getReadyNativeAgentThreadRuntime(input.threadId)).uninstallPlugin({ id: input.threadId }, input.pluginId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listCollaborationModes({ id: input.threadId })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.computerUseConfigurationGet, async () =>
    await readComputerUseConfiguration(process.platform, app.getPath('userData')),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.computerUseConfigurationSet, async (event, payload) => {
    const input = payload as { allowedAppIds: string[] }
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '更新 Computer Use 允许的应用？',
      '只有列表中的应用可被 Computer Use 观察或操作。系统屏幕录制、辅助功能和操作确认仍会单独生效。',
      input.allowedAppIds.length === 0 ? '将移除全部允许的应用。' : input.allowedAppIds.join('\n'),
    )
    return await writeComputerUseConfiguration(process.platform, app.getPath('userData'), input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.chromeNativeMessagingGetStatus, async () =>
    await getChromeNativeMessagingHostStatus({ platform: process.platform, desktopRoot: unpackedRoot() }),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.chromeNativeMessagingInstall, async (event) => {
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '连接 BilliardBuddy Chrome 扩展？',
      '这会为固定的 BilliardBuddy 扩展注册本机消息通道。不会读取 Cookie、密码或 Chrome Profile 文件。',
      'Chrome 会把扩展发起的受限请求交给随应用签名的本机 Host。',
    )
    const registration = { platform: process.platform, desktopRoot: unpackedRoot() }
    await installChromeNativeMessagingHost(registration)
    return await getChromeNativeMessagingHostStatus(registration)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.chromeNativeMessagingUninstall, async (event) => {
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '断开 BilliardBuddy Chrome 扩展？',
      '这会删除 BilliardBuddy 与 Chrome 的本机连接配置，不会改动浏览器资料。',
      '断开后，Agent 无法通过该扩展控制 Chrome。',
    )
    const registration = { platform: process.platform, desktopRoot: unpackedRoot() }
    await uninstallChromeNativeMessagingHost(registration)
    return await getChromeNativeMessagingHostStatus(registration)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.browserUsePolicyGet, async () =>
    await readBrowserPolicyConfiguration(app.getPath('userData'), 'browser-use'),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.browserUsePolicySet, async (event, payload) => {
    const input = payload as BrowserPolicyConfiguration
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '更新 BilliardBuddy Browser 网站范围？',
      '允许列表控制无需逐站确认即可访问的网站，阻止列表始终优先。更新会清除当前会话的临时网站授权。',
      `允许：${input.allowedHosts.join(', ') || '无'}\n阻止：${input.blockedHosts.join(', ') || '无'}`,
    )
    await writeBrowserPolicyConfiguration(app.getPath('userData'), 'browser-use', input)
    return await getInAppBrowserHost().reloadPolicy()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.chromeControlPolicyGet, async () =>
    await readBrowserPolicyConfiguration(app.getPath('userData'), 'chrome-control'),
  )
  registerHandler(ELECTRON_IPC_CHANNELS.chromeControlPolicySet, async (event, payload) => {
    const input = payload as BrowserPolicyConfiguration
    await confirmNativeAgentExtensionChange(
      currentWindow(event),
      '更新 BilliardBuddy Chrome 网站范围？',
      '只有允许列表内且由用户主动连接的标签页可被扩展使用；阻止列表始终优先。更新会在下一次工具操作前生效，并断开已不再允许的标签页。',
      `允许：${input.allowedHosts.join(', ') || '无'}\n阻止：${input.blockedHosts.join(', ') || '无'}`,
    )
    return await writeBrowserPolicyConfiguration(app.getPath('userData'), 'chrome-control', input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.commandInvoke, (_event, payload) => handleCommandInvoke(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardReadText, () => clipboard.readText())
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWriteText, (_event, payload) => clipboard.writeText(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpen, (_event, payload) => openExternalUrl(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenPath, (_event, payload) => openSystemPath(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogOpen, (event, payload) =>
    openDialog(currentWindow(event), payload as Parameters<typeof openDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogSave, (event, payload) =>
    saveDialog(currentWindow(event), payload as Parameters<typeof saveDialog>[1]))
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageSubmitProject, (_event, payload) => {
    const request = imageSubmitProjectIpcPayloadSchema.parse(payload)
    return getImageActions().submitProject(request.projectId, request.confirmUnknownRetry)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageStartOperation, (_event, payload) => {
    const request = imageStartOperationIpcPayloadSchema.parse(payload)
    return getImageActions().startOperation(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject, (_event, payload) => {
    const request = imageUpdateUnknownProjectIpcPayloadSchema.parse(payload)
    return getImageActions().updateUnknownProject(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageSaveOutput, (_event, payload) => {
    const request = imageSaveOutputIpcPayloadSchema.parse(payload)
    return getImageActions().saveOutput(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageCreateCreativePlan, (_event, payload) => {
    const request = imageCreateCreativePlanIpcPayloadSchema.parse(payload)
    return getImageActions().createCreativePlan(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageEstimateGenerationRound, (_event, payload) => {
    const request = imageEstimateGenerationRoundIpcPayloadSchema.parse(payload)
    return getImageActions().estimateGenerationRound(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageEstimateDerivation, (_event, payload) => {
    const request = imageEstimateDerivationIpcPayloadSchema.parse(payload)
    return getImageActions().estimateDerivation(request.projectId, request.candidateId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageCreateGenerationRound, (_event, payload) => {
    const request = imageCreateGenerationRoundIpcPayloadSchema.parse(payload)
    return getImageActions().createGenerationRound(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageDecideCandidate, (_event, payload) => {
    const request = imageDecideCandidateIpcPayloadSchema.parse(payload)
    return getImageActions().decideCandidate(request.projectId, request.candidateId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageAdoptCandidate, (_event, payload) => {
    const request = imageAdoptCandidateIpcPayloadSchema.parse(payload)
    return getImageActions().adoptCandidate(request.projectId, request.candidateId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageDeriveCandidate, (_event, payload) => {
    const request = imageDeriveCandidateIpcPayloadSchema.parse(payload)
    return getImageActions().deriveCandidate(request.projectId, request.candidateId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageCancelGenerationOperation, (_event, payload) => {
    const request = imageCancelGenerationOperationIpcPayloadSchema.parse(payload)
    return getImageActions().cancelGenerationOperation(request.operationId)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageUpdateReferenceControl, (_event, payload) => {
    const request = imageUpdateReferenceControlIpcPayloadSchema.parse(payload)
    return getImageActions().updateReferenceControl(request.projectId, request.referenceId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageCreateDeliverySpecRevision, (_event, payload) => {
    const request = imageCreateDeliverySpecRevisionIpcPayloadSchema.parse(payload)
    return getImageActions().createDeliverySpecRevision(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageCreateCanvas, (_event, payload) => {
    const request = imageCreateCanvasIpcPayloadSchema.parse(payload)
    return getImageActions().createCanvas(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageApplyCanvasCommand, (_event, payload) => {
    const request = imageApplyCanvasCommandIpcPayloadSchema.parse(payload)
    return getImageActions().applyCanvasCommand(request.projectId, request.canvasId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imagePreflightCanvas, (_event, payload) => {
    const request = imagePreflightCanvasIpcPayloadSchema.parse(payload)
    return getImageActions().preflightCanvas(request.projectId, request.canvasId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageRenderCanvas, (_event, payload) => {
    const request = imageRenderCanvasIpcPayloadSchema.parse(payload)
    return getImageActions().renderCanvas(request.projectId, request.canvasId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageExportDelivery, (_event, payload) => {
    const request = imageExportDeliveryIpcPayloadSchema.parse(payload)
    return getImageActions().exportDelivery(request.projectId, request.input)
  })
  registerImageHandler(ELECTRON_IPC_CHANNELS.imageSelectArtboardVersion, (_event, payload) => {
    const request = imageSelectArtboardVersionIpcPayloadSchema.parse(payload)
    return getImageActions().selectArtboardVersion(request.projectId, request.artboardId, request.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.videoAddSource, (_event, payload) => {
    const input = payload as { projectId: string; path: string }
    return getVideoActions().addVideoSource(input.projectId, input.path)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.videoRender, (_event, payload) => {
    const input = payload as { projectId: string, baseRevision: number, timelineVersionId: string, outputPath: string }
    return getVideoActions().renderVideo(input.projectId, {
      base_revision: input.baseRevision,
      timeline_version_id: input.timelineVersionId,
      output_path: input.outputPath,
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.videoAnalyze, (_event, payload) => {
    const input = payload as { projectId: string, baseRevision: number, userGoal: string }
    return getVideoActions().analyzeVideo(input.projectId, {
      base_revision: input.baseRevision,
      user_goal: input.userGoal,
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.updateCheck, (_event, payload) =>
    getUpdaterService().checkForUpdates(payload as Parameters<ElectronUpdaterService['checkForUpdates']>[0]))
  registerHandler(ELECTRON_IPC_CHANNELS.updateDownload, () => getUpdaterService().downloadUpdate(event => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, event)
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.updateInstall, () => getUpdaterService().stageDownloadedUpdate())
  registerHandler(ELECTRON_IPC_CHANNELS.updatePrepareInstall, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.updateCancelInstall, () => getUpdaterService().cancelInstall())
  registerHandler(ELECTRON_IPC_CHANNELS.updateRelaunch, () => {
    if (getUpdaterService().hasDownloadedUpdate()) {
      isQuitting = true
      getUpdaterService().quitAndInstallDownloadedUpdate()
      return
    }
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.notificationPermissionState, () => notificationPermissionState(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationRequestPermission, () => requestNotificationPermission(Notification))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationSend, (_event, payload) => sendDesktopNotification({
    NotificationClass: Notification,
    options: payload,
    onAction: emitNotificationAction,
  }))
  registerHandler(ELECTRON_IPC_CHANNELS.notificationActionAck, (_event, payload) =>
    logNotificationSmokeRendererAck(process.env, payload))
  registerHandler(ELECTRON_IPC_CHANNELS.windowMinimize, event => currentWindow(event).minimize())
  registerHandler(ELECTRON_IPC_CHANNELS.windowToggleMaximize, event => {
    const window = currentWindow(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.windowClose, event => currentWindow(event).close())
  registerHandler(ELECTRON_IPC_CHANNELS.windowStartDragging, () => undefined)
  registerHandler(ELECTRON_IPC_CHANNELS.windowRequestAttention, event => currentWindow(event).flashFrame(true))
  registerHandler(ELECTRON_IPC_CHANNELS.windowFocus, event => currentWindow(event).focus())
  registerHandler(ELECTRON_IPC_CHANNELS.windowIsMaximized, event => currentWindow(event).isMaximized())
  registerHandler(ELECTRON_IPC_CHANNELS.appModeGet, () => getAppMode(app))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeSet, (_event, payload) => setAppMode(app, payload as Parameters<typeof setAppMode>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.appModeDetectPortableDir, () => detectPortableDir(app) as PortableDetection)
  registerHandler(ELECTRON_IPC_CHANNELS.appModePrepareRestart, () => getServerRuntime().stopAll())
  registerHandler(ELECTRON_IPC_CHANNELS.appModeRestart, () => {
    isQuitting = true
    app.relaunch()
    app.quit()
  })
  registerHandler(ELECTRON_IPC_CHANNELS.zoomSet, (event, payload) => currentWindow(event).webContents.setZoomFactor(normalizeZoomFactor(payload)))
}

async function createMainWindow() {
  const restoredState = readWindowState(app, screen.getAllDisplays())
  const bounds = windowOptionsFromState(restoredState)
  const entry = rendererEntry()
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    ...windowChromeOptionsForPlatform(process.platform),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  registerTrustedProductWindow(mainWindow, entry)

  installMainWindowNavigationGuards(mainWindow.webContents, {
    openExternal: openExternalUrl,
    rendererEntry: entry,
  })
  installWindowLifecycle({
    app,
    window: mainWindow,
    shouldQuit: () => isQuitting,
  })

  mainWindow.on('resize', () => {
    mainWindow?.webContents.send(ELECTRON_EVENT_CHANNELS.windowResized)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    writeWindowSmokeSnapshot(mainWindow, 'did-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    writeWindowSmokeSnapshot(mainWindow, `did-fail-load:${errorCode}:${errorDescription}:${validatedURL}`)
  })

  writeWindowSmokeSnapshot(mainWindow, 'after-create')

  await loadRendererEntry(mainWindow, entry)

  restoreWindowMaximized(mainWindow, restoredState)
  showMainWindow(mainWindow, app)
  refreshWindowsDragHitTest(mainWindow, process.platform)
  writeWindowSmokeSnapshot(mainWindow, 'after-final-show')
}

if (!acquireSingleInstanceLock(app, () => mainWindow, process.env)) {
  process.exit(0)
}

registerIpcHandlers()

app.whenReady().then(async () => {
  applyWindowsAppUserModelId(app)
  applyStartupPortableMode(app)
  // After portable/ops override is resolved, default the kernel config dir to
  // BilliardBuddy's own data root keeps the sidecar isolated from other products.
  applyDefaultConfigDir(app)
  await getInAppBrowserHost().start()
  // The window is the recovery surface for activation, proxy, credential-store,
  // and sidecar failures, so establish it before constructing the backend.
  await createMainWindow()
  await getScheduledAgentTasks().start()
  writeWindowSmokeSnapshot(mainWindow, 'backend-starting')
  try {
    void getServerRuntime().startServer()
      .then(() => writeWindowSmokeSnapshot(mainWindow, 'backend-ready'))
      .catch(error => {
        writeWindowSmokeSnapshot(mainWindow, 'backend-failed', process.env, { error })
        console.error('[desktop] failed to start Electron server sidecar', error)
      })
  } catch (error) {
    writeWindowSmokeSnapshot(mainWindow, 'backend-initialization-failed', process.env, { error })
    console.error('[desktop] failed to initialize Electron server runtime', error)
  }
  await installApplicationMenu(app, () => mainWindow)
  if (shouldInstallTray(process.platform)) {
    trayController = await installTray({
      app,
      desktopRoot: appRoot(),
      show: () => showMainWindow(mainWindow, app),
      quit: () => {
        isQuitting = true
        app.quit()
      },
    }).catch(error => {
      console.error('[desktop] failed to create Electron tray', error)
      return null
    })
  }
  scheduleNotificationSmoke({
    env: process.env,
    NotificationClass: Notification,
    onAction: emitNotificationAction,
  })

  app.on('activate', () => {
    if (mainWindow) {
      showMainWindow(mainWindow, app)
      return
    }
    void createMainWindow()
  })
}).catch(error => {
  console.error('[desktop] failed during application startup', error)
})

app.on('window-all-closed', () => {
  if (isQuitting && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (mainWindow) saveWindowState(app, mainWindow)
  trayController?.dispose()
  trayController = null
  installationSessionManager?.dispose()
  void inAppBrowserHost?.stop()
  inAppBrowserHost = null
  requestRecordReplayStop(app.getPath('userData'))
  scheduledAgentTasks?.stop()
  scheduledAgentTasks = null
  rejectNativeAgentServerRequests(new Error('CODEX_NATIVE_APP_QUITTING'))
  nativeAgentRuntime?.closeImmediately()
  nativeAgentRuntime = null
  nativeAgentThreadOwners.clear()
  nativeAgentTurnOwners.clear()
  pendingExternalAgentDetections.clear()
  // Synchronous on quit so the Windows taskkill completes before the process
  // exits, otherwise the fire-and-forget kill can leave orphaned sidecars.
  getServerRuntime().stopAll(true)
})
