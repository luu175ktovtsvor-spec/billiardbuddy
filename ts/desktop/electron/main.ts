import { app, BrowserWindow, clipboard, ipcMain, Notification, safeStorage, screen, session, WebContentsView } from 'electron'
import { autoUpdater } from 'electron-updater'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  parseProductTaskLink,
  PRODUCT_TASK_LINK_SCHEME,
  PRODUCT_TASK_WINDOW_QUERY_KEY,
} from '../../shared/product/taskLinks'
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
import { ElectronTerminalService, type TerminalSpawnInput } from './services/terminal'
import { ElectronPreviewService, type PreviewBounds } from './services/preview'
import { ElectronMediaActions } from './services/mediaActions'
import {
  applyDefaultConfigDir,
  applyStartupPortableMode,
  detectPortableDir,
  getAppMode,
  setAppMode,
  type PortableDetection,
} from './services/appMode'
import { createCredentialStore } from './services/keychain'
import { InstallationSessionManager } from './services/installationSession'
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
import { ElectronBrowserCapability } from './services/browserCapability'
import { resolveRendererEntry } from './services/rendererEntry'
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
const browserUiCapability = randomBytes(32).toString('base64url')

let mainWindow: BrowserWindow | null = null
let serverRuntime: ElectronServerRuntime | null = null
let installationSessionManager: InstallationSessionManager | null = null
let updaterService: ElectronUpdaterService | null = null
let terminalService: ElectronTerminalService | null = null
let previewService: ElectronPreviewService | null = null
let mediaActions: ElectronMediaActions | null = null
let browserCapability: ElectronBrowserCapability | null = null
let mcpOAuthCredentialKey: string | null = null
let isQuitting = false
let trayController: TrayController | null = null
const trustedProductWindowEntries = new Map<BrowserWindow, string>()
const productTaskWindows = new Map<string, BrowserWindow>()
let pendingProductTaskId: string | null = null

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
  const terminalOwnerId = window.webContents.id
  trustedProductWindowEntries.set(window, entry)
  window.webContents.once('render-process-gone', () => {
    terminalService?.killOwner(terminalOwnerId)
  })
  window.once('closed', () => {
    terminalService?.killOwner(terminalOwnerId)
    trustedProductWindowEntries.delete(window)
  })
}

function existingProductTaskWindow(taskId: string): BrowserWindow | null {
  const window = productTaskWindows.get(taskId)
  if (!window || window.isDestroyed()) {
    productTaskWindows.delete(taskId)
    return null
  }
  return window
}

async function openProductTaskWindow(taskId: string): Promise<void> {
  const existing = existingProductTaskWindow(taskId)
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }

  const entry = rendererEntry()
  const taskWindow = new BrowserWindow({
    width: 1080,
    height: 820,
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
  productTaskWindows.set(taskId, taskWindow)
  registerTrustedProductWindow(taskWindow, entry)

  taskWindow.once('closed', () => {
    if (productTaskWindows.get(taskId) === taskWindow) {
      productTaskWindows.delete(taskId)
    }
    previewService?.closeForParent(taskWindow)
  })
  taskWindow.on('resize', () => {
    taskWindow.webContents.send(ELECTRON_EVENT_CHANNELS.windowResized)
  })
  installMainWindowNavigationGuards(taskWindow.webContents, {
    openExternal: openExternalUrl,
    rendererEntry: entry,
  })
  installPreviewCleanupOnRendererNavigation(taskWindow.webContents, () => {
    previewService?.close()
  })

  try {
    await loadRendererEntry(taskWindow, entry, { [PRODUCT_TASK_WINDOW_QUERY_KEY]: taskId })
    taskWindow.show()
    taskWindow.focus()
    refreshWindowsDragHitTest(taskWindow, process.platform)
  } catch (error) {
    taskWindow.destroy()
    throw error
  }
}

function queueOrOpenProductTaskLink(value: string) {
  const taskId = parseProductTaskLink(value)
  if (!taskId) return

  if (!app.isReady()) {
    pendingProductTaskId = taskId
    return
  }

  void openProductTaskWindow(taskId).catch(error => {
    console.error('[desktop] failed to open product task link:', error)
  })
}

function registerProductTaskProtocol() {
  const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
  if (defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(
      PRODUCT_TASK_LINK_SCHEME,
      process.execPath,
      [path.resolve(process.argv[1])],
    )
    return
  }
  app.setAsDefaultProtocolClient(PRODUCT_TASK_LINK_SCHEME)
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
      bootstrapCredential: config.token,
      licenseKey: config.licenseKey,
      installationId: ensureInstallationId(process.env.BILLIARDBUDDY_CONFIG_DIR || app.getPath('userData')),
      onTokenChanged: () => serverRuntime?.reconfigureServer(),
      onSessionFailure: () => serverRuntime?.stopServer(),
    }, createCredentialStore(process.platform, app.getPath('userData'), 'installation-session', safeStorage))
  })()
  return installationSessionManager
}

function getMcpOAuthCredentialKey(): string {
  if (mcpOAuthCredentialKey) return mcpOAuthCredentialKey
  const store = createCredentialStore(process.platform, app.getPath('userData'), 'mcp-oauth-master-key', safeStorage)
  const existing = store.load()
  if (existing) {
    let decoded: Buffer
    try { decoded = Buffer.from(existing, 'base64url') } catch { throw new Error('MCP OAuth credential storage is corrupt') }
    if (decoded.length !== 32) throw new Error('MCP OAuth credential storage is corrupt')
    mcpOAuthCredentialKey = existing
    return existing
  }
  const created = randomBytes(32).toString('base64url')
  store.save(created)
  mcpOAuthCredentialKey = created
  return created
}

function getServerRuntime() {
  serverRuntime ??= new ElectronServerRuntime({
    desktopRoot: unpackedRoot(),
    appRoot: appRoot(),
    resolveSystemProxy: (url) => session.defaultSession.resolveProxy(url),
    // Public packaged routing config; its bootstrap credential remains Main-only.
    resolveGatewayConfig: () => requireProductGatewayConfig(
      resolveProductGatewayConfig({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        devBuildDir: path.join(unpackedRoot(), 'build'),
        env: process.env,
      }),
    ),
    // Only a short-lived access bearer reaches the server sidecar. Bootstrap,
    // license, refresh proof and installation identity remain in Main.
    resolveInstallationAccessToken: () => getInstallationSessionManager().accessToken(),
    mediaUiCapability,
    browserUiCapability,
    mcpOAuthCredentialKey: getMcpOAuthCredentialKey(),
  })
  return serverRuntime
}

function getBrowserCapability() {
  browserCapability ??= new ElectronBrowserCapability({
    desktopRoot: unpackedRoot(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    configDir: process.env.BILLIARDBUDDY_CONFIG_DIR || app.getPath('userData'),
    getServerUrl: () => getServerRuntime().getServerUrl(),
    uiCapability: browserUiCapability,
  })
  return browserCapability
}

function getMediaActions() {
  mediaActions ??= new ElectronMediaActions({
    getServerUrl: () => getServerRuntime().getServerUrl(),
    capability: mediaUiCapability,
  })
  return mediaActions
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
    enabled: process.platform !== 'darwin' || smokeUpdater !== null,
    updateConfigPath: !smokeUpdater && app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : undefined,
  })
  return updaterService
}

function nodePtyRuntimeCacheDir() {
  if (!app.isPackaged || process.platform !== 'darwin') return undefined
  return path.join(app.getPath('userData'), 'native', `node-pty-${process.platform}-${process.arch}-${app.getVersion()}`)
}

function getTerminalService() {
  terminalService ??= new ElectronTerminalService({
    app,
    nodePtySourceDir: app.isPackaged ? path.join(unpackedRoot(), 'node_modules', 'node-pty') : undefined,
    nodePtyCacheDir: nodePtyRuntimeCacheDir(),
  })
  return terminalService
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

function assertTerminalTaskAccess(event: Electron.IpcMainInvokeEvent, taskId: string): void {
  const window = currentWindow(event)
  for (const [ownedTaskId, taskWindow] of productTaskWindows) {
    if (taskWindow === window && ownedTaskId !== taskId) {
      throw new Error('terminal task does not match the owning task window')
    }
  }
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
  registerHandler(ELECTRON_IPC_CHANNELS.commandInvoke, (_event, payload) => handleCommandInvoke(payload))
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardReadText, () => clipboard.readText())
  registerHandler(ELECTRON_IPC_CHANNELS.clipboardWriteText, (_event, payload) => clipboard.writeText(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpen, (_event, payload) => openExternalUrl(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.shellOpenPath, (_event, payload) => openSystemPath(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogOpen, (event, payload) =>
    openDialog(currentWindow(event), payload as Parameters<typeof openDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.dialogSave, (event, payload) =>
    saveDialog(currentWindow(event), payload as Parameters<typeof saveDialog>[1]))
  registerHandler(ELECTRON_IPC_CHANNELS.mediaSubmitImage, (_event, payload) => {
    const input = payload as { projectId: string, confirmUnknownRetry: boolean }
    return getMediaActions().submitImageProject(input.projectId, input.confirmUnknownRetry)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaStartImageOperation, (_event, payload) => {
    const request = payload as {
      projectId: string
      input: Parameters<ElectronMediaActions['startImageOperation']>[1]
    }
    return getMediaActions().startImageOperation(request.projectId, request.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaUpdateUnknownImage, (_event, payload) => {
    const update = payload as {
      projectId: string
      input: Parameters<ElectronMediaActions['updateUnknownImageProject']>[1]
    }
    return getMediaActions().updateUnknownImageProject(update.projectId, update.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaSaveImageOutput, (_event, payload) => {
    const request = payload as {
      projectId: string
      input: Parameters<ElectronMediaActions['saveImageOutput']>[1]
    }
    return getMediaActions().saveImageOutput(request.projectId, request.input)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaAddVideoSource, (_event, payload) => {
    const input = payload as { projectId: string; path: string }
    return getMediaActions().addVideoSource(input.projectId, input.path)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaRenderVideo, (_event, payload) => {
    const input = payload as { projectId: string, baseRevision: number, timelineVersionId: string, outputPath: string }
    return getMediaActions().renderVideo(input.projectId, {
      base_revision: input.baseRevision,
      timeline_version_id: input.timelineVersionId,
      output_path: input.outputPath,
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.mediaAnalyzeVideo, (_event, payload) => {
    const input = payload as { projectId: string, baseRevision: number, userGoal: string }
    return getMediaActions().analyzeVideo(input.projectId, {
      base_revision: input.baseRevision,
      user_goal: input.userGoal,
    })
  })
  registerHandler(ELECTRON_IPC_CHANNELS.browserStatus, () => getBrowserCapability().status())
  registerHandler(ELECTRON_IPC_CHANNELS.browserInstall, () => getBrowserCapability().install())
  registerHandler(ELECTRON_IPC_CHANNELS.browserListActions, (_event, payload) => getBrowserCapability().listActions(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.browserResolveAction, (_event, payload) => {
    const input = payload as { taskId: string; actionId: string; expectedRevision: number; approved: boolean }
    return getBrowserCapability().resolveAction(input.taskId, input.actionId, input.expectedRevision, input.approved)
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
  registerHandler(ELECTRON_IPC_CHANNELS.windowOpenProductTask, (_event, payload) =>
    openProductTaskWindow(String(payload)))
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSpawn, (event, payload) => {
    const input = payload as TerminalSpawnInput
    assertTerminalTaskAccess(event, input.taskId)
    return getTerminalService().spawn(input, event.sender)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalWrite, (event, payload) => {
    const { taskId, sessionId, data } = payload as { taskId: string, sessionId: number, data: string }
    assertTerminalTaskAccess(event, taskId)
    return getTerminalService().write(event.sender.id, taskId, sessionId, data)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalResize, (event, payload) => {
    const { taskId, sessionId, cols, rows } = payload as { taskId: string, sessionId: number, cols: number, rows: number }
    assertTerminalTaskAccess(event, taskId)
    return getTerminalService().resize(event.sender.id, taskId, sessionId, cols, rows)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalKill, (event, payload) => {
    const { taskId, sessionId } = payload as { taskId: string, sessionId: number }
    assertTerminalTaskAccess(event, taskId)
    return getTerminalService().kill(event.sender.id, taskId, sessionId)
  })
  registerHandler(ELECTRON_IPC_CHANNELS.terminalGetBashPath, () => getTerminalService().getBashPath())
  registerHandler(ELECTRON_IPC_CHANNELS.terminalSetBashPath, (_event, payload) => getTerminalService().setBashPath(payload as string | null))
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

registerProductTaskProtocol()

app.on('open-url', (event, url) => {
  event.preventDefault()
  queueOrOpenProductTaskLink(url)
})

const launchProductTaskLink = process.argv.find(value => parseProductTaskLink(value) !== null)
if (launchProductTaskLink) queueOrOpenProductTaskLink(launchProductTaskLink)

if (!acquireSingleInstanceLock(app, () => mainWindow, process.env, commandLine => {
  const taskLink = commandLine.find(value => parseProductTaskLink(value) !== null)
  if (taskLink) queueOrOpenProductTaskLink(taskLink)
})) {
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
  if (pendingProductTaskId) {
    const taskId = pendingProductTaskId
    pendingProductTaskId = null
    await openProductTaskWindow(taskId).catch(error => {
      console.error('[desktop] failed to open initial product task link:', error)
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
  terminalService?.killAll()
  previewService?.close()
  installationSessionManager?.dispose()
  // Synchronous on quit so the Windows taskkill completes before the process
  // exits, otherwise the fire-and-forget kill can leave orphaned sidecars.
  getServerRuntime().stopAll(true)
})
