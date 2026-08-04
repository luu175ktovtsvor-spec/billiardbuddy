import { contextBridge, ipcRenderer } from 'electron'
import type { ImageWorkbenchPreloadBridge } from '../../shared/contracts/imageWorkbenchPreload.js'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'

function invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload)
}

type ImageBridgeResult<Method extends keyof ImageWorkbenchPreloadBridge> =
  Awaited<ReturnType<ImageWorkbenchPreloadBridge[Method]>>

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
  listLoadedThreads: (cwd: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListLoadedThreads,
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
  unsubscribeThread: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUnsubscribeThread,
    { threadId },
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
  updateThreadMetadata: (threadId: string, gitInfo: Record<string, unknown>) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadMetadata,
    { threadId, ...gitInfo },
  ),
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
  searchThreadOccurrences: (threadId: string, searchTerm: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSearchThreadOccurrences,
    { ...options, threadId, searchTerm },
  ),
  listModels: (threadId: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListModels,
    { ...options, threadId },
  ),
  readModelProviderCapabilities: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentReadModelProviderCapabilities,
    { threadId },
  ),
  listPermissionProfiles: (threadId: string, cwd: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListPermissionProfiles,
    { ...options, threadId, cwd },
  ),
  readConfigRequirements: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentReadConfigRequirements,
    { threadId },
  ),
  readClientSettings: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentReadClientSettings,
    { threadId },
  ),
  setThreadMemoryMode: (threadId: string, mode: 'enabled' | 'disabled') => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSetThreadMemoryMode,
    { threadId, mode },
  ),
  resetMemory: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentResetMemory,
    { threadId },
  ),
  listThreadSections: (threadId: string, options: Record<string, unknown> = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListThreadSections,
    { ...options, threadId },
  ),
  createThreadSection: (threadId: string, name: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentCreateThreadSection,
    { threadId, name },
  ),
  updateThreadSection: (threadId: string, sectionId: string, name: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSection,
    { threadId, sectionId, name },
  ),
  deleteThreadSection: (threadId: string, sectionId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentDeleteThreadSection,
    { threadId, sectionId },
  ),
  moveThreadToSection: (threadId: string, sectionId: string | null, beforeThreadId?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentMoveThreadToSection,
    { threadId, sectionId, ...(beforeThreadId === undefined ? {} : { beforeThreadId }) },
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
  updateThreadSettings: (threadId: string, settings: Record<string, unknown>) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSettings,
    { threadId, ...settings },
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
  steerTurn: (threadId: string, turnId: string, input: unknown[], clientUserMessageId?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn,
    { threadId, turnId, input, ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }) },
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
  getChromeNativeMessagingStatus: () => invoke(ELECTRON_IPC_CHANNELS.chromeNativeMessagingGetStatus),
  installChromeNativeMessaging: () => invoke(ELECTRON_IPC_CHANNELS.chromeNativeMessagingInstall),
  uninstallChromeNativeMessaging: () => invoke(ELECTRON_IPC_CHANNELS.chromeNativeMessagingUninstall),
  getBrowserUsePolicy: () => invoke(ELECTRON_IPC_CHANNELS.browserUsePolicyGet),
  setBrowserUsePolicy: (allowedHosts: string[], blockedHosts: string[]) => invoke(
    ELECTRON_IPC_CHANNELS.browserUsePolicySet,
    { allowedHosts, blockedHosts },
  ),
  getChromeControlPolicy: () => invoke(ELECTRON_IPC_CHANNELS.chromeControlPolicyGet),
  setChromeControlPolicy: (allowedHosts: string[], blockedHosts: string[]) => invoke(
    ELECTRON_IPC_CHANNELS.chromeControlPolicySet,
    { allowedHosts, blockedHosts },
  ),
  onEvent: nativeAgentEventListener,
}

// These are product-owned capabilities, not Agent tools. The future renderer
// uses this narrow bridge to reach the existing image and video backends.
const images: ImageWorkbenchPreloadBridge = {
  submitProject: (projectId, confirmUnknownRetry = false) => invoke<ImageBridgeResult<'submitProject'>>(
    ELECTRON_IPC_CHANNELS.imageSubmitProject,
    { projectId, confirmUnknownRetry },
  ),
  startOperation: (projectId, input) => invoke<ImageBridgeResult<'startOperation'>>(
    ELECTRON_IPC_CHANNELS.imageStartOperation,
    { projectId, input },
  ),
  updateUnknownProject: (projectId, input) => invoke<ImageBridgeResult<'updateUnknownProject'>>(
    ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
    { projectId, input },
  ),
  saveOutput: (projectId, input) => invoke<ImageBridgeResult<'saveOutput'>>(
    ELECTRON_IPC_CHANNELS.imageSaveOutput,
    { projectId, input },
  ),
  requestDestination: input => invoke<ImageBridgeResult<'requestDestination'>>(
    ELECTRON_IPC_CHANNELS.imageRequestDestination,
    input,
  ),
  createCreativePlan: (projectId, input) => invoke<ImageBridgeResult<'createCreativePlan'>>(
    ELECTRON_IPC_CHANNELS.imageCreateCreativePlan,
    { projectId, input },
  ),
  estimateGenerationRound: (projectId, input) => invoke<ImageBridgeResult<'estimateGenerationRound'>>(
    ELECTRON_IPC_CHANNELS.imageEstimateGenerationRound,
    { projectId, input },
  ),
  estimateDerivation: (projectId, candidateId, input) => invoke<ImageBridgeResult<'estimateDerivation'>>(
    ELECTRON_IPC_CHANNELS.imageEstimateDerivation,
    { projectId, candidateId, input },
  ),
  createGenerationRound: (projectId, input) => invoke<ImageBridgeResult<'createGenerationRound'>>(
    ELECTRON_IPC_CHANNELS.imageCreateGenerationRound,
    { projectId, input },
  ),
  decideCandidate: (projectId, candidateId, input) => invoke<ImageBridgeResult<'decideCandidate'>>(
    ELECTRON_IPC_CHANNELS.imageDecideCandidate,
    { projectId, candidateId, input },
  ),
  adoptCandidate: (projectId, candidateId, input) => invoke<ImageBridgeResult<'adoptCandidate'>>(
    ELECTRON_IPC_CHANNELS.imageAdoptCandidate,
    { projectId, candidateId, input },
  ),
  deriveCandidate: (projectId, candidateId, input) => invoke<ImageBridgeResult<'deriveCandidate'>>(
    ELECTRON_IPC_CHANNELS.imageDeriveCandidate,
    { projectId, candidateId, input },
  ),
  cancelGenerationOperation: operationId => invoke<ImageBridgeResult<'cancelGenerationOperation'>>(
    ELECTRON_IPC_CHANNELS.imageCancelGenerationOperation,
    { operationId },
  ),
  updateReferenceControl: (projectId, referenceId, input) => invoke<ImageBridgeResult<'updateReferenceControl'>>(
    ELECTRON_IPC_CHANNELS.imageUpdateReferenceControl,
    { projectId, referenceId, input },
  ),
  createDeliverySpecRevision: (projectId, input) => invoke<ImageBridgeResult<'createDeliverySpecRevision'>>(
    ELECTRON_IPC_CHANNELS.imageCreateDeliverySpecRevision,
    { projectId, input },
  ),
  createCanvas: (projectId, input) => invoke<ImageBridgeResult<'createCanvas'>>(
    ELECTRON_IPC_CHANNELS.imageCreateCanvas,
    { projectId, input },
  ),
  applyCanvasCommand: (projectId, canvasId, input) => invoke<ImageBridgeResult<'applyCanvasCommand'>>(
    ELECTRON_IPC_CHANNELS.imageApplyCanvasCommand,
    { projectId, canvasId, input },
  ),
  preflightCanvas: (projectId, canvasId, input) => invoke<ImageBridgeResult<'preflightCanvas'>>(
    ELECTRON_IPC_CHANNELS.imagePreflightCanvas,
    { projectId, canvasId, input },
  ),
  renderCanvas: (projectId, canvasId, input) => invoke<ImageBridgeResult<'renderCanvas'>>(
    ELECTRON_IPC_CHANNELS.imageRenderCanvas,
    { projectId, canvasId, input },
  ),
  exportDelivery: (projectId, input) => invoke<ImageBridgeResult<'exportDelivery'>>(
    ELECTRON_IPC_CHANNELS.imageExportDelivery,
    { projectId, input },
  ),
  selectArtboardVersion: (projectId, artboardId, input) => invoke<ImageBridgeResult<'selectArtboardVersion'>>(
    ELECTRON_IPC_CHANNELS.imageSelectArtboardVersion,
    { projectId, artboardId, input },
  ),
}

const media = {
  images,
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
