import { contextBridge, ipcRenderer } from 'electron'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'

function invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>
}

function nativeAgentEventListener(handler: (event: unknown) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => handler(payload)
  ipcRenderer.on(ELECTRON_EVENT_CHANNELS.nativeAgentEvent, listener)
  return () => ipcRenderer.removeListener(ELECTRON_EVENT_CHANNELS.nativeAgentEvent, listener)
}

/**
 * Keep only the narrow native Codex boundary that the replacement UI will
 * project; Main validates every call.
 */
const nativeAgent = {
  startThread: (cwd: string, permissionMode?: unknown) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartThread,
    { cwd, ...(permissionMode === undefined ? {} : { permissionMode }) },
  ),
  listThreads: (cwd: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListThreads,
    { ...options, cwd },
  ),
  searchThreads: (cwd: string, searchTerm: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSearchThreads,
    { ...options, cwd, searchTerm },
  ),
  resumeThread: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentResumeThread,
    { threadId, cwd },
  ),
  unarchiveThread: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUnarchiveThread,
    { threadId, cwd },
  ),
  deleteThread: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentDeleteThread,
    { threadId, cwd },
  ),
  readThread: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentReadThread, { threadId }),
  forkThread: (threadId: string, cwd: string, permissionMode?: unknown, lastTurnId?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentForkThread,
    {
      threadId,
      cwd,
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(lastTurnId === undefined ? {} : { lastTurnId }),
    },
  ),
  setThreadName: (threadId: string, name: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetThreadName,
    { threadId, name },
  ),
  compactThread: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentCompactThread, { threadId }),
  rollbackThread: (threadId: string, numTurns: number) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentRollbackThread,
    { threadId, numTurns },
  ),
  listThreadTurns: (threadId: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListThreadTurns,
    { ...options, threadId },
  ),
  listThreadItems: (threadId: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListThreadItems,
    { ...options, threadId },
  ),
  getThreadGoal: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentGetThreadGoal,
    { threadId },
  ),
  setThreadGoal: (threadId: string, goal: Record<string, unknown>) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetThreadGoal,
    { threadId, ...goal },
  ),
  clearThreadGoal: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentClearThreadGoal,
    { threadId },
  ),
  listBackgroundTerminals: (threadId: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListBackgroundTerminals,
    { ...options, threadId },
  ),
  terminateBackgroundTerminal: (threadId: string, processId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentTerminateBackgroundTerminal,
    { threadId, processId },
  ),
  cleanBackgroundTerminals: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentCleanBackgroundTerminals,
    { threadId },
  ),
  updatePermissionMode: (threadId: string, permissionMode: unknown) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdatePermissionMode,
    { threadId, permissionMode },
  ),
  getWindowsSandboxReadiness: (cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxReadiness,
    { cwd },
  ),
  startWindowsSandboxSetup: (cwd: string, mode: 'elevated' | 'unelevated') => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxSetupStart,
    { cwd, mode },
  ),
  startTurn: (
    threadId: string,
    input: unknown[],
    clientUserMessageId?: string,
    collaborationMode?: 'default' | 'plan',
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartTurn,
    {
      threadId,
      input,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    },
  ),
  startReview: (threadId: string, target: Record<string, unknown>, delivery?: 'inline' | 'detached') => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartReview,
    { threadId, target, ...(delivery === undefined ? {} : { delivery }) },
  ),
  steerTurn: (threadId: string, turnId: string, text: string, clientUserMessageId?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn,
    { threadId, turnId, text, ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }) },
  ),
  interruptTurn: (threadId: string, turnId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentInterruptTurn,
    { threadId, turnId },
  ),
  archiveThread: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentArchiveThread, { threadId }),
  resolveServerRequest: (requestId: string, response: unknown) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentResolveServerRequest,
    { requestId, response },
  ),
  configureMcpServer: (threadId: string, name: string, config: unknown) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentConfigureMcpServer,
    { threadId, name, config },
  ),
  removeMcpServer: (threadId: string, name: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentRemoveMcpServer,
    { threadId, name },
  ),
  listMcpServerStatuses: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListMcpServerStatuses,
    { threadId },
  ),
  startMcpOAuth: (threadId: string, name: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartMcpOAuth,
    { threadId, name },
  ),
  listSkills: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListSkills,
    { threadId, cwd },
  ),
  setSkillEnabled: (threadId: string, selector: Record<string, unknown>, enabled: boolean) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetSkillEnabled,
    { threadId, ...selector, enabled },
  ),
  setExtraSkillRoots: (threadId: string, roots: string[]) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetExtraSkillRoots,
    { threadId, roots },
  ),
  detectExternalConfig: (
    threadId: string,
    cwd: string,
    includeHome: boolean,
    migrationSource?: string,
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentDetectExternalConfig,
    { threadId, cwd, includeHome, ...(migrationSource === undefined ? {} : { migrationSource }) },
  ),
  importExternalConfig: (threadId: string, detectionId: string, itemIndexes: number[]) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentImportExternalConfig,
    { threadId, detectionId, itemIndexes },
  ),
  listScheduledTasks: (threadId?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListScheduledTasks,
    threadId === undefined ? {} : { threadId },
  ),
  createScheduledTask: (threadId: string, input: Record<string, unknown>) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentCreateScheduledTask,
    { threadId, ...input },
  ),
  setScheduledTaskEnabled: (threadId: string, taskId: string, enabled: boolean) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetScheduledTaskEnabled,
    { threadId, taskId, enabled },
  ),
  removeScheduledTask: (threadId: string, taskId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentRemoveScheduledTask,
    { threadId, taskId },
  ),
  getRemoteHostStatus: () => invoke(ELECTRON_IPC_CHANNELS.remoteHostGetStatus),
  setRemoteHostEnabled: (enabled: boolean) => invoke(
    ELECTRON_IPC_CHANNELS.remoteHostSetEnabled,
    { enabled },
  ),
  createRemoteHostPairing: (ttlSeconds?: number) => invoke(
    ELECTRON_IPC_CHANNELS.remoteHostCreatePairing,
    ttlSeconds === undefined ? {} : { ttlSeconds },
  ),
  listRemoteHostControllers: () => invoke(ELECTRON_IPC_CHANNELS.remoteHostListControllers),
  revokeRemoteHostController: (installationId: string) => invoke(
    ELECTRON_IPC_CHANNELS.remoteHostRevokeController,
    { installationId },
  ),
  claimRemoteHostPairing: (pairingCode: string) => invoke(
    ELECTRON_IPC_CHANNELS.remoteControllerClaim,
    { pairingCode },
  ),
  startRemoteHostTurn: (hostInstallationId: string, threadId: string, cwd: string, text: string) => invoke(
    ELECTRON_IPC_CHANNELS.remoteControllerStartTurn,
    { hostInstallationId, threadId, cwd, text },
  ),
  steerRemoteHostTurn: (hostInstallationId: string, threadId: string, turnId: string, text: string) => invoke(
    ELECTRON_IPC_CHANNELS.remoteControllerSteerTurn,
    { hostInstallationId, threadId, turnId, text },
  ),
  listHooks: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListHooks,
    { threadId, cwd },
  ),
  listPlugins: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListPlugins,
    { threadId, cwd },
  ),
  listInstalledPlugins: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListInstalledPlugins,
    { threadId, cwd },
  ),
  readPlugin: (threadId: string, marketplacePath: string, pluginName: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentReadPlugin,
    { threadId, marketplacePath, pluginName },
  ),
  addMarketplace: (threadId: string, input: Record<string, unknown>) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentAddMarketplace,
    { threadId, ...input },
  ),
  addBundledMarketplace: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentAddBundledMarketplace,
    { threadId },
  ),
  removeMarketplace: (threadId: string, marketplaceName: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentRemoveMarketplace,
    { threadId, marketplaceName },
  ),
  upgradeMarketplace: (threadId: string, marketplaceName?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpgradeMarketplace,
    { threadId, ...(marketplaceName === undefined ? {} : { marketplaceName }) },
  ),
  installPlugin: (threadId: string, marketplacePath: string, pluginName: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentInstallPlugin,
    { threadId, marketplacePath, pluginName },
  ),
  uninstallPlugin: (threadId: string, pluginId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUninstallPlugin,
    { threadId, pluginId },
  ),
  listCollaborationModes: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes,
    { threadId },
  ),
  getComputerUseConfiguration: () => invoke(ELECTRON_IPC_CHANNELS.computerUseConfigurationGet),
  setComputerUseConfiguration: (allowedAppIds: string[]) => invoke(
    ELECTRON_IPC_CHANNELS.computerUseConfigurationSet,
    { allowedAppIds },
  ),
  onEvent: nativeAgentEventListener,
}

// These are product-owned capabilities, not Agent tools. The future renderer
// uses this narrow bridge to reach the existing image and video backends.
const media = {
  images: {
    submitProject: (projectId: string, confirmUnknownRetry = false) => invoke(
      ELECTRON_IPC_CHANNELS.imageSubmitProject,
      { projectId, confirmUnknownRetry },
    ),
    startOperation: (projectId: string, input: unknown) => invoke(
      ELECTRON_IPC_CHANNELS.imageStartOperation,
      { projectId, input },
    ),
    updateUnknownProject: (projectId: string, input: unknown) => invoke(
      ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
      { projectId, input },
    ),
    saveOutput: (projectId: string, input: unknown) => invoke(
      ELECTRON_IPC_CHANNELS.imageSaveOutput,
      { projectId, input },
    ),
  },
  videos: {
    addSource: (projectId: string, path: string) => invoke(
      ELECTRON_IPC_CHANNELS.videoAddSource,
      { projectId, path },
    ),
    render: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.videoRender, input),
    analyze: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.videoAnalyze, input),
  },
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('billiardBuddyNative', {
    nativeAgent,
    media,
    models: {
      summary: () => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSummary),
      providerPresets: () => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationProviderPresets),
      openProviderPortal: (providerPresetId: string) => invoke(
        ELECTRON_IPC_CHANNELS.modelConfigurationOpenProviderPortal,
        providerPresetId,
      ),
      discover: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationDiscover, input),
      discoverPreset: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationDiscoverPreset, input),
      savePreset: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSavePreset, input),
      save: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSave, input),
      remove: (profileId: string) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationRemove, profileId),
    },
  })
}
