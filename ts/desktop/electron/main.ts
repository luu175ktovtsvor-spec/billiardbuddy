import { app, BrowserWindow, clipboard, ipcMain, Notification, safeStorage, screen, session, webContents, WebContentsView } from 'electron'
import { autoUpdater } from 'electron-updater'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_INTERNAL_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import { isElectronIpcChannel, validateElectronIpcPayload } from './ipc/capabilities'
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
import { ElectronPreviewService, type PreviewBounds } from './services/preview'
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
import { createCredentialStore } from './services/keychain'
import { ProviderCredentialService } from './services/providerCredentials'
import {
  ElectronCodexNativeRuntime,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
  type NativeCodexPermissionMode,
  type CodexNativeServerRequest,
  type NativeCodexSkillSelector,
} from './services/codexNativeAppServer'
import type { CodexNativeModelRoute } from './services/codexNativeProvider'
import { InstallationSessionManager } from './services/installationSession'
import { defaultProviderModel, textReasoningRegistryEntry } from '../../../gateway/providerRegistry'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import {
  installMainWindowNavigationGuards,
  installPreviewNavigationGuards,
  isTrustedMainWindowFrame,
  isTrustedMainWindowNavigationUrl,
} from './services/navigationGuards'
import { installPreviewCleanupOnRendererNavigation } from './services/previewLifecycle'
import { logNotificationSmokeRendererAck, scheduleNotificationSmoke } from './services/notificationSmoke'
import { normalizeZoomFactor } from './services/zoom'
import { resolveRendererEntry } from './services/rendererEntry'
import { nativeServerRequestSafeFallback } from './services/nativeServerRequestFallback'
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
let previewService: ElectronPreviewService | null = null
let imageActions: ElectronImageActions | null = null
let videoActions: ElectronVideoActions | null = null
let providerCredentialService: ProviderCredentialService | null = null
let nativeAgentRuntime: ElectronCodexNativeRuntime | null = null
let isQuitting = false
let trayController: TrayController | null = null
const trustedProductWindowEntries = new Map<BrowserWindow, string>()

type NativeAgentApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
type NativeAgentApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
type PendingNativeAgentApproval = {
  ownerId: number
  method: NativeAgentApprovalMethod
  availableDecisions: readonly NativeAgentApprovalDecision[]
  resolve(value: CodexNativeJsonObject): void
  reject(error: Error): void
  cleanup(): void
}

const nativeAgentThreadOwners = new Map<string, number>()
const nativeAgentTurnOwners = new Map<string, number>()
const nativeAgentApprovals = new Map<string, PendingNativeAgentApproval>()

function appRoot() {
  return app.isPackaged ? app.getAppPath() : process.cwd()
}

function unpackedRoot() {
  const root = appRoot()
  return app.isPackaged ? root.replace(/\.asar$/, '.asar.unpacked') : root
}

function preloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preload.cjs')
}

function previewPreloadPath() {
  return path.join(appRoot(), 'electron-dist', 'preview-preload.cjs')
}

function previewAgentPath() {
  return path.join(appRoot(), 'runtime-assets', 'resources', 'preview-agent.js')
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
    const config = requireProductGatewayConfig(resolveProductGatewayConfig({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      devBuildDir: path.join(unpackedRoot(), 'build'),
      env: process.env,
    }))
    return new InstallationSessionManager({
      gatewayUrl: config.url,
      installationId: ensureInstallationId(process.env.BILLIARDBUDDY_CONFIG_DIR || app.getPath('userData')),
      onTokenChanged: token => serverRuntime?.setInstallationAccessToken(token),
      onSessionFailure: error => console.error('[desktop] installation session update failed', error),
    }, createCredentialStore(process.platform, app.getPath('userData'), 'installation-session', safeStorage))
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

function nativeApprovalMethod(value: string): NativeAgentApprovalMethod | undefined {
  return value === 'item/commandExecution/requestApproval' || value === 'item/fileChange/requestApproval'
    ? value
    : undefined
}

function nativeAgentPermissionMode(value: unknown): NativeCodexPermissionMode {
  if (value === undefined) return 'ask'
  if (value === 'ask' || value === 'approve-for-me' || value === 'full-access') return value
  throw new Error('CODEX_NATIVE_PERMISSION_MODE_INVALID')
}

/**
 * `danger-full-access` means the source Rust sandbox stops mediating disk and
 * network operations. Keep its confirmation in privileged Main, rather than
 * trusting a renderer-only modal or a legacy ProductTask permission envelope.
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

function nativeApprovalDecisions(
  method: NativeAgentApprovalMethod,
  params: unknown,
): NativeAgentApprovalDecision[] {
  const values = nativeProtocolObject(params)?.availableDecisions
  const available = Array.isArray(values) ? values.filter((value): value is NativeAgentApprovalDecision =>
    value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel')
    : []
  if (available.length > 0) return available

  // File-change approvals intentionally use the stable legacy enum and do not
  // expose availableDecisions. Mirror Codex's complete legacy choices. A
  // command request without the experimental field gets the conservative
  // subset: allow once or stop the turn, never a guessed policy amendment.
  return method === 'item/fileChange/requestApproval'
    ? ['accept', 'acceptForSession', 'decline', 'cancel']
    : ['accept', 'cancel']
}

function sendNativeAgentEvent(ownerId: number, payload: unknown): boolean {
  const owner = webContents.fromId(ownerId)
  if (!owner || owner.isDestroyed()) return false
  owner.send(ELECTRON_EVENT_CHANNELS.nativeAgentEvent, payload)
  return true
}

function releaseNativeAgentApproval(requestId: string): PendingNativeAgentApproval | undefined {
  const pending = nativeAgentApprovals.get(requestId)
  if (!pending) return undefined
  nativeAgentApprovals.delete(requestId)
  pending.cleanup()
  return pending
}

function rejectNativeAgentApprovals(error: Error): void {
  for (const requestId of [...nativeAgentApprovals.keys()]) {
    releaseNativeAgentApproval(requestId)?.reject(error)
  }
}

function forwardNativeAgentNotification(notification: CodexNativeNotification): void {
  const threadId = nativeThreadId(notification.params)
  const turnId = nativeTurnId(notification.params)
  const ownerId = threadId ? nativeAgentThreadOwners.get(threadId) : turnId ? nativeAgentTurnOwners.get(turnId) : undefined
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
}

async function requestNativeAgentApproval(request: CodexNativeServerRequest): Promise<CodexNativeJsonObject> {
  const safeFallback = nativeServerRequestSafeFallback(request)
  if (safeFallback) return safeFallback
  const method = nativeApprovalMethod(request.method)
  const threadId = nativeThreadId(request.params)
  if (!method || !threadId) throw new Error('CODEX_NATIVE_APPROVAL_REQUEST_UNSUPPORTED')
  const ownerId = nativeAgentThreadOwners.get(threadId)
  const owner = ownerId === undefined ? undefined : webContents.fromId(ownerId)
  if (ownerId === undefined || !owner || owner.isDestroyed()) {
    throw new Error('CODEX_NATIVE_APPROVAL_OWNER_UNAVAILABLE')
  }
  const requestId = randomBytes(18).toString('base64url')
  const availableDecisions = nativeApprovalDecisions(method, request.params)
  return await new Promise<CodexNativeJsonObject>((resolve, reject) => {
    const cleanup = () => owner.removeListener('destroyed', onOwnerDestroyed)
    const onOwnerDestroyed = () => {
      releaseNativeAgentApproval(requestId)?.reject(new Error('CODEX_NATIVE_APPROVAL_OWNER_UNAVAILABLE'))
    }
    nativeAgentApprovals.set(requestId, {
      ownerId,
      method,
      availableDecisions,
      resolve,
      reject,
      cleanup,
    })
    owner.once('destroyed', onOwnerDestroyed)
    if (!sendNativeAgentEvent(ownerId, {
      type: 'approval',
      requestId,
      method,
      params: request.params ?? {},
      availableDecisions,
    })) {
      releaseNativeAgentApproval(requestId)?.reject(new Error('CODEX_NATIVE_APPROVAL_OWNER_UNAVAILABLE'))
    }
  })
}

function managedNativeAgentModel(): string {
  const model = process.env.BB_GATEWAY_MODEL?.trim() || defaultProviderModel()
  if (!textReasoningRegistryEntry(model)) throw new Error('CODEX_NATIVE_MANAGED_MODEL_INVALID')
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
  return {
    kind: 'managed',
    gatewayUrl: config.url,
    resolveAccessToken: () => getInstallationSessionManager().accessToken(),
    model: managedNativeAgentModel(),
  }
}

function getNativeAgentRuntime(): ElectronCodexNativeRuntime {
  nativeAgentRuntime ??= new ElectronCodexNativeRuntime({
    desktopRoot: unpackedRoot(),
    userDataPath: app.getPath('userData'),
    onNotification: forwardNativeAgentNotification,
    onServerRequest: requestNativeAgentApproval,
  })
  return nativeAgentRuntime
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

function getPreviewService() {
  previewService ??= new ElectronPreviewService({
    previewScriptPath: previewAgentPath(),
    createView: () => {
      const view = new WebContentsView({
        webPreferences: {
          preload: previewPreloadPath(),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      installPreviewNavigationGuards(view.webContents, { openExternal: openExternalUrl })
      return view
    },
  })
  return previewService
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

function legacyAgentBackendRetired(): never {
  throw new Error('LEGACY_AGENT_BACKEND_RETIRED')
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
  ipcMain.on(ELECTRON_INTERNAL_CHANNELS.previewMessageFromView, (event, raw) => {
    void getPreviewService().sendMessageToRenderer(event.sender, raw)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.appGetVersion, () => app.getVersion())
  registerHandler(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl, () => getServerRuntime().getServerUrl())
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSummary, () => getProviderCredentialService().summary())
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSave, (_event, payload) =>
    mutateProviderCredentials(service => service.save(payload as Parameters<ProviderCredentialService['save']>[0])))
  registerHandler(ELECTRON_IPC_CHANNELS.modelConfigurationSetRoute, (_event, payload) => {
    const input = payload as { capability: Parameters<ProviderCredentialService['setRoute']>[0], profileId: string | null }
    return mutateProviderCredentials(service => service.setRoute(input.capability, input.profileId))
  })
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
    }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    const turn = await (await getReadyNativeAgentThreadRuntime(input.threadId)).startTurn(
      { id: input.threadId },
      input.input,
      input.clientUserMessageId,
    )
    nativeAgentTurnOwners.set(turn.id, event.sender.id)
    return turn
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn, async (event, payload) => {
    const input = payload as { threadId: string, turnId: string, text: string, clientUserMessageId?: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    assertNativeAgentTurnOwner(event.sender.id, input.turnId)
    await getNativeAgentRuntime().steerTurn(
      { id: input.threadId },
      { id: input.turnId },
      input.text,
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
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentResolveApproval, (event, payload) => {
    const input = payload as { requestId: string, decision: NativeAgentApprovalDecision }
    const pending = nativeAgentApprovals.get(input.requestId)
    if (!pending || pending.ownerId !== event.sender.id) throw new Error('CODEX_NATIVE_APPROVAL_OWNER_REQUIRED')
    if (!pending.availableDecisions.includes(input.decision)) {
      throw new Error('CODEX_NATIVE_APPROVAL_DECISION_UNAVAILABLE')
    }
    releaseNativeAgentApproval(input.requestId)?.resolve({ decision: input.decision })
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
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListHooks, async (event, payload) => {
    const input = payload as { threadId: string, cwd: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listHooks({ id: input.threadId }, input.cwd)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes, async (event, payload) => {
    const input = payload as { threadId: string }
    assertNativeAgentThreadOwner(event.sender.id, input.threadId)
    return await (await getReadyNativeAgentThreadRuntime(input.threadId)).listCollaborationModes({ id: input.threadId })
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
  registerHandler(ELECTRON_IPC_CHANNELS.imageSubmitProject, (_event, payload) => {
    const input = payload as { projectId: string, confirmUnknownRetry: boolean }
    return getImageActions().submitProject(input.projectId, input.confirmUnknownRetry)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.imageStartOperation, (_event, payload) => {
    const request = payload as {
      projectId: string
      input: Parameters<ElectronImageActions['startOperation']>[1]
    }
    return getImageActions().startOperation(request.projectId, request.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject, (_event, payload) => {
    const update = payload as {
      projectId: string
      input: Parameters<ElectronImageActions['updateUnknownProject']>[1]
    }
    return getImageActions().updateUnknownProject(update.projectId, update.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.imageSaveOutput, (_event, payload) => {
    const request = payload as {
      projectId: string
      input: Parameters<ElectronImageActions['saveOutput']>[1]
    }
    return getImageActions().saveOutput(request.projectId, request.input)
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
  registerHandler(ELECTRON_IPC_CHANNELS.windowOpenProductTask, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSpawn, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalWrite, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalResize, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalKill, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalGetBashPath, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSetBashPath, legacyAgentBackendRetired)
  registerHandler(ELECTRON_IPC_CHANNELS.previewOpen, (event, payload) => {
    const { url, bounds } = payload as { url: string, bounds?: PreviewBounds }
    return getPreviewService().open(
      currentWindow(event),
      url,
      bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      event.sender,
    )
  })
  registerHandler(ELECTRON_IPC_CHANNELS.previewNavigate, (_event, payload) => getPreviewService().navigate(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetBounds, (_event, payload) => getPreviewService().setBounds(payload as PreviewBounds))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetVisible, (_event, payload) => getPreviewService().setVisible(Boolean(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.previewSetZoom, (_event, payload) => getPreviewService().setZoomFactor(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.previewClose, () => getPreviewService().close())
  registerHandler(ELECTRON_IPC_CHANNELS.previewMessage, (event, payload) => getPreviewService().message(payload, event.sender))
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
  installPreviewCleanupOnRendererNavigation(mainWindow.webContents, () => {
    previewService?.close()
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
  // The window is the recovery surface for activation, proxy, credential-store,
  // and sidecar failures, so establish it before constructing the backend.
  await createMainWindow()
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
  previewService?.close()
  installationSessionManager?.dispose()
  rejectNativeAgentApprovals(new Error('CODEX_NATIVE_APP_QUITTING'))
  nativeAgentRuntime?.closeImmediately()
  nativeAgentRuntime = null
  nativeAgentThreadOwners.clear()
  nativeAgentTurnOwners.clear()
  // Synchronous on quit so the Windows taskkill completes before the process
  // exits, otherwise the fire-and-forget kill can leave orphaned sidecars.
  getServerRuntime().stopAll(true)
})
