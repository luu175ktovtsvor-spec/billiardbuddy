import type {
  DesktopHost,
  DesktopHostUnlisten,
  DesktopUpdate,
  DesktopUpdateDownloadEvent,
} from './types'
import {
  ELECTRON_EVENT_CHANNELS,
  ELECTRON_IPC_CHANNELS,
  type ElectronEventChannel,
  type ElectronIpcChannel,
} from '../../../electron/ipc/channels'
import { validateElectronIpcPayload } from '../../../electron/ipc/capabilities'

export type ElectronHostBridge = {
  invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T>
  subscribe<T>(
    channel: ElectronEventChannel,
    handler: (payload: T) => void,
  ): Promise<DesktopHostUnlisten>
}

type ElectronUpdateMetadata = {
  version: string
  body?: string | null
}

function safeInvoke<T>(
  bridge: ElectronHostBridge,
  channel: ElectronIpcChannel,
  payload?: unknown,
): Promise<T> {
  if (!validateElectronIpcPayload(channel, payload)) {
    return Promise.reject(new Error(`Invalid Electron IPC payload for ${channel}`))
  }
  return bridge.invoke<T>(channel, payload)
}

export function createElectronHost(bridge: ElectronHostBridge): DesktopHost {
  const invoke = <T>(channel: ElectronIpcChannel, payload?: unknown) =>
    safeInvoke<T>(bridge, channel, payload)
  const subscribe = <T>(channel: ElectronEventChannel, handler: (payload: T) => void) =>
    bridge.subscribe(channel, handler)
  const createUpdate = (metadata: ElectronUpdateMetadata): DesktopUpdate => ({
    version: metadata.version,
    body: metadata.body ?? null,
    async download(onEvent) {
      const unlisten = onEvent
        ? await subscribe<DesktopUpdateDownloadEvent>(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, onEvent)
        : null
      try {
        await invoke(ELECTRON_IPC_CHANNELS.updateDownload)
      } finally {
        unlisten?.()
      }
    },
    install: () => invoke(ELECTRON_IPC_CHANNELS.updateInstall),
    close: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
  })

  return {
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      appMode: true,
      clipboard: true,
      dialogs: true,
      videoActions: true,
      modelConfiguration: true,
      notifications: true,
      previewWebview: true,
      recruitingBrowser: true,
      shell: true,
      terminal: true,
      taskWindows: true,
      updates: true,
      windowControls: true,
      zoom: true,
    },
    runtime: {
      getServerUrl: () => invoke(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
    },
    app: {
      getVersion: () => invoke(ELECTRON_IPC_CHANNELS.appGetVersion),
    },
    commands: {
      invoke: (command, args) => invoke(ELECTRON_IPC_CHANNELS.commandInvoke, { command, args }),
    },
    clipboard: {
      readText: () => invoke(ELECTRON_IPC_CHANNELS.clipboardReadText),
      writeText: text => invoke(ELECTRON_IPC_CHANNELS.clipboardWriteText, text),
    },
    events: {
      listen: (_eventName, handler) => subscribe(ELECTRON_EVENT_CHANNELS.event, handler),
    },
    webview: {
      onDragDropEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.webviewDragDrop, handler),
    },
    shell: {
      open: target => invoke(ELECTRON_IPC_CHANNELS.shellOpen, target),
      openPath: path => invoke(ELECTRON_IPC_CHANNELS.shellOpenPath, path),
    },
    dialogs: {
      open: options => invoke(ELECTRON_IPC_CHANNELS.dialogOpen, options),
      save: options => invoke(ELECTRON_IPC_CHANNELS.dialogSave, options),
    },
    images: {
      submitProject: (projectId, confirmUnknownRetry = false) => invoke(
        ELECTRON_IPC_CHANNELS.imageSubmitProject,
        { projectId, confirmUnknownRetry },
      ),
      startOperation: (projectId, input) => invoke(
        ELECTRON_IPC_CHANNELS.imageStartOperation,
        { projectId, input },
      ),
      updateUnknownProject: (projectId, input) => invoke(
        ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
        { projectId, input },
      ),
      saveOutput: (projectId, input) => invoke(
        ELECTRON_IPC_CHANNELS.imageSaveOutput,
        { projectId, input },
      ),
    },
    videos: {
      addSource: (projectId, path) => invoke(
        ELECTRON_IPC_CHANNELS.videoAddSource,
        { projectId, path },
      ),
      render: request => invoke(ELECTRON_IPC_CHANNELS.videoRender, request),
      analyze: request => invoke(ELECTRON_IPC_CHANNELS.videoAnalyze, request),
    },
    models: {
      summary: () => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSummary),
      save: input => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSave, input),
      setRoute: (capability, profileId) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSetRoute, { capability, profileId }),
      remove: profileId => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationRemove, profileId),
    },
    recruitingBrowser: {
      status: () => invoke(ELECTRON_IPC_CHANNELS.browserStatus),
      install: () => invoke(ELECTRON_IPC_CHANNELS.browserInstall),
      listActions: taskId => invoke(ELECTRON_IPC_CHANNELS.browserListActions, taskId),
      resolveAction: (taskId, actionId, expectedRevision, approved) => invoke(
        ELECTRON_IPC_CHANNELS.browserResolveAction,
        { taskId, actionId, expectedRevision, approved },
      ),
    },
    updates: {
      check: async (options) => {
        const update = await invoke<ElectronUpdateMetadata | null>(ELECTRON_IPC_CHANNELS.updateCheck, options)
        return update ? createUpdate(update) : null
      },
      prepareInstall: () => invoke(ELECTRON_IPC_CHANNELS.updatePrepareInstall),
      cancelInstall: () => invoke(ELECTRON_IPC_CHANNELS.updateCancelInstall),
      relaunch: () => invoke(ELECTRON_IPC_CHANNELS.updateRelaunch),
    },
    notifications: {
      permissionState: () => invoke(ELECTRON_IPC_CHANNELS.notificationPermissionState),
      requestPermission: () => invoke(ELECTRON_IPC_CHANNELS.notificationRequestPermission),
      send: options => invoke(ELECTRON_IPC_CHANNELS.notificationSend, options),
      onAction: handler => subscribe(ELECTRON_EVENT_CHANNELS.notificationAction, handler),
      ackAction: payload => invoke(ELECTRON_IPC_CHANNELS.notificationActionAck, payload),
    },
    window: {
      minimize: () => invoke(ELECTRON_IPC_CHANNELS.windowMinimize),
      toggleMaximize: () => invoke(ELECTRON_IPC_CHANNELS.windowToggleMaximize),
      close: () => invoke(ELECTRON_IPC_CHANNELS.windowClose),
      startDragging: () => invoke(ELECTRON_IPC_CHANNELS.windowStartDragging),
      requestAttention: () => invoke(ELECTRON_IPC_CHANNELS.windowRequestAttention),
      focus: () => invoke(ELECTRON_IPC_CHANNELS.windowFocus),
      isMaximized: () => invoke(ELECTRON_IPC_CHANNELS.windowIsMaximized),
      openProductTask: taskId => invoke(ELECTRON_IPC_CHANNELS.windowOpenProductTask, taskId),
      onResized: handler => subscribe(ELECTRON_EVENT_CHANNELS.windowResized, handler),
      onNativeMenuNavigate: handler => subscribe(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler),
    },
    terminal: {
      spawn: options => invoke(ELECTRON_IPC_CHANNELS.terminalSpawn, options),
      write: (taskId, sessionId, data) => invoke(ELECTRON_IPC_CHANNELS.terminalWrite, { taskId, sessionId, data }),
      resize: (taskId, sessionId, cols, rows) => invoke(ELECTRON_IPC_CHANNELS.terminalResize, { taskId, sessionId, cols, rows }),
      kill: (taskId, sessionId) => invoke(ELECTRON_IPC_CHANNELS.terminalKill, { taskId, sessionId }),
      onOutput: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalOutput, handler),
      onExit: handler => subscribe(ELECTRON_EVENT_CHANNELS.terminalExit, handler),
      getBashPath: () => invoke(ELECTRON_IPC_CHANNELS.terminalGetBashPath),
      setBashPath: path => invoke(ELECTRON_IPC_CHANNELS.terminalSetBashPath, path),
    },
    preview: {
      open: (url, bounds) => invoke(ELECTRON_IPC_CHANNELS.previewOpen, { url, bounds }),
      navigate: url => invoke(ELECTRON_IPC_CHANNELS.previewNavigate, url),
      setBounds: bounds => invoke(ELECTRON_IPC_CHANNELS.previewSetBounds, bounds),
      setVisible: visible => invoke(ELECTRON_IPC_CHANNELS.previewSetVisible, visible),
      setZoom: level => invoke(ELECTRON_IPC_CHANNELS.previewSetZoom, level),
      close: () => invoke(ELECTRON_IPC_CHANNELS.previewClose),
      message: payload => invoke(ELECTRON_IPC_CHANNELS.previewMessage, payload),
      onEvent: handler => subscribe(ELECTRON_EVENT_CHANNELS.previewEvent, handler),
    },
    appMode: {
      get: () => invoke(ELECTRON_IPC_CHANNELS.appModeGet),
      set: config => invoke(ELECTRON_IPC_CHANNELS.appModeSet, config),
      detectPortableDir: () => invoke(ELECTRON_IPC_CHANNELS.appModeDetectPortableDir),
      prepareRestart: () => invoke(ELECTRON_IPC_CHANNELS.appModePrepareRestart),
      restart: () => invoke(ELECTRON_IPC_CHANNELS.appModeRestart),
    },
    zoom: {
      set: level => invoke(ELECTRON_IPC_CHANNELS.zoomSet, level),
    },
  }
}
