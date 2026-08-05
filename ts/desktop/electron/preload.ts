import { contextBridge, ipcRenderer } from 'electron'
import type {
  ImageWorkbenchIpcResponse,
  ImageWorkbenchPreloadBridge,
} from '../../shared/contracts/imageWorkbenchPreload.js'
import type {
  ImageWorkbenchIpcMethod,
  ImageWorkbenchIpcPayloadByMethod,
  ImageWorkbenchIpcValueByMethod,
} from '../../shared/contracts/imageWorkbenchIpc.js'
import type { VideoWorkbenchPreloadBridge } from '../../shared/contracts/videoWorkbenchPreload.js'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'

function invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload)
}

type ImageBridgeResult<Method extends keyof ImageWorkbenchPreloadBridge> =
  Awaited<ReturnType<ImageWorkbenchPreloadBridge[Method]>>
type VideoBridgeResult<Method extends keyof VideoWorkbenchPreloadBridge> =
  Awaited<ReturnType<VideoWorkbenchPreloadBridge[Method]>>

function invokeImageWorkbench<Method extends ImageWorkbenchIpcMethod>(
  method: Method,
  payload: ImageWorkbenchIpcPayloadByMethod[Method],
): Promise<ImageWorkbenchIpcResponse<ImageWorkbenchIpcValueByMethod[Method]>> {
  return invoke<ImageWorkbenchIpcResponse<ImageWorkbenchIpcValueByMethod[Method]>>(
    ELECTRON_IPC_CHANNELS.imageWorkbenchInvoke,
    { method, payload },
  )
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
  configureMemory: (
    threadId: string,
    configuration: { enabled: boolean, useMemories: boolean, generateMemories: boolean },
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentConfigureMemory,
    { threadId, ...configuration },
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
  startIntegratedTerminal: (threadId: string, size: { rows: number, cols: number }) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartIntegratedTerminal,
    { threadId, size },
  ),
  writeIntegratedTerminal: (processId: string, text: string, closeStdin = false) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentWriteIntegratedTerminal,
    { processId, text, closeStdin },
  ),
  resizeIntegratedTerminal: (processId: string, size: { rows: number, cols: number }) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentResizeIntegratedTerminal,
    { processId, size },
  ),
  terminateIntegratedTerminal: (processId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentTerminateIntegratedTerminal,
    { processId },
  ),
  searchWorkspaceFiles: (threadId: string, query: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSearchWorkspaceFiles,
    { threadId, query },
  ),
  startWorkspaceFileSearch: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartWorkspaceFileSearch,
    { threadId },
  ),
  updateWorkspaceFileSearch: (sessionId: string, query: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdateWorkspaceFileSearch,
    { sessionId, query },
  ),
  stopWorkspaceFileSearch: (sessionId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStopWorkspaceFileSearch,
    { sessionId },
  ),
  listWorktrees: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentListWorktrees, { threadId }),
  createWorktree: (threadId: string, revision?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentCreateWorktree,
    { threadId, ...(revision === undefined ? {} : { revision }) },
  ),
  snapshotWorktree: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentSnapshotWorktree, { threadId }),
  restoreWorktree: (threadId: string, snapshotId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentRestoreWorktree,
    { threadId, snapshotId },
  ),
  activateWorktree: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentActivateWorktree, { threadId }),
  cleanupWorktree: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentCleanupWorktree, { threadId }),
  handoffWorkspace: (threadId: string, destination: 'source' | 'worktree') => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentHandoffWorkspace,
    { threadId, destination },
  ),
  readLocalEnvironment: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentReadLocalEnvironment, { threadId }),
  runLocalEnvironmentSetup: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentRunLocalEnvironmentSetup, { threadId }),
  runLocalEnvironmentCleanup: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentRunLocalEnvironmentCleanup, { threadId }),
  startLocalEnvironmentAction: (threadId: string, name: string, size: { rows: number, cols: number }) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartLocalEnvironmentAction,
    { threadId, name, size },
  ),
  gitStatus: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitStatus, { threadId }),
  gitDiff: (threadId: string, options: { staged?: boolean, paths?: string[] } = {}) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentGitDiff,
    { threadId, ...options },
  ),
  gitStageFiles: (threadId: string, paths: string[]) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitStageFiles, { threadId, paths }),
  gitRevertFiles: (threadId: string, paths: string[]) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitRevertFiles, { threadId, paths }),
  gitStagePatch: (threadId: string, patch: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitStagePatch, { threadId, patch }),
  gitRevertPatch: (threadId: string, patch: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitRevertPatch, { threadId, patch }),
  gitCommit: (threadId: string, message: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitCommit, { threadId, message }),
  gitPush: (threadId: string, branch: string, remote?: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentGitPush,
    { threadId, branch, ...(remote === undefined ? {} : { remote }) },
  ),
  gitListBranches: (threadId: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitListBranches, { threadId }),
  gitCreateBranch: (threadId: string, name: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitCreateBranch, { threadId, name }),
  gitSwitchBranch: (threadId: string, name: string) => invoke(ELECTRON_IPC_CHANNELS.nativeAgentGitSwitchBranch, { threadId, name }),
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
    additionalContext?: Record<string, { value: string, kind: 'untrusted' }>,
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartTurn,
    {
      threadId,
      input,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
      ...(additionalContext === undefined ? {} : { additionalContext }),
    },
  ),
  startTurnWithAppshot: (
    threadId: string,
    text?: string,
    clientUserMessageId?: string,
    collaborationMode?: 'default' | 'plan',
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartTurnWithAppshot,
    {
      threadId,
      ...(text === undefined ? {} : { text }),
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    },
  ),
  startReview: (threadId: string, target: Record<string, unknown>, delivery?: 'inline' | 'detached') => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentStartReview,
    { threadId, target, ...(delivery === undefined ? {} : { delivery }) },
  ),
  steerTurn: (
    threadId: string,
    turnId: string,
    input: unknown[],
    clientUserMessageId?: string,
    additionalContext?: Record<string, { value: string, kind: 'untrusted' }>,
  ) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn,
    {
      threadId,
      turnId,
      input,
      ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
      ...(additionalContext === undefined ? {} : { additionalContext }),
    },
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
  readExternalImportHistories: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentReadExternalImportHistories,
    { threadId },
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
  trustHook: (threadId: string, cwd: string, hookKey: string, currentHash: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentTrustHook,
    { threadId, cwd, hookKey, currentHash },
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
  understandProject: (projectId, input) => invoke<ImageBridgeResult<'understandProject'>>(
    ELECTRON_IPC_CHANNELS.imageUnderstandProject,
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
  assessCandidateVisual: (projectId, candidateId, input) => invoke<ImageBridgeResult<'assessCandidateVisual'>>(
    ELECTRON_IPC_CHANNELS.imageAssessCandidateVisual,
    { projectId, candidateId, input },
  ),
  assessVersionVisual: (projectId, versionId, input) => invoke<ImageBridgeResult<'assessVersionVisual'>>(
    ELECTRON_IPC_CHANNELS.imageAssessVersionVisual,
    { projectId, versionId, input },
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
  listProjects: () => invokeImageWorkbench('listProjects', {}),
  getProject: projectId => invokeImageWorkbench('getProject', { projectId }),
  getProjectProjection: projectId => invokeImageWorkbench('getProjectProjection', { projectId }),
  listOperationEvents: input => invokeImageWorkbench('listOperationEvents', input),
  quickCreate: input => invokeImageWorkbench('quickCreate', { input }),
  compileBrief: projectId => invokeImageWorkbench('compileBrief', { projectId }),
  applyBriefOverrides: input => invokeImageWorkbench('applyBriefOverrides', input),
  getInspirationBoard: projectId => invokeImageWorkbench('getInspirationBoard', { projectId }),
  upsertInspirationItems: input => invokeImageWorkbench('upsertInspirationItems', input),
  promoteInspirationItem: input => invokeImageWorkbench('promoteInspirationItem', input),
  addReferences: input => invokeImageWorkbench('addReferences', input),
  removeReference: input => invokeImageWorkbench('removeReference', input),
  getCandidateGroup: input => invokeImageWorkbench('getCandidateGroup', input),
  getCandidatePreview: input => invokeImageWorkbench('getCandidatePreview', input),
  getVersionPreview: input => invokeImageWorkbench('getVersionPreview', input),
  estimateVersionDerivation: (projectId, versionId, input) => invokeImageWorkbench('estimateVersionDerivation', { projectId, versionId, input }),
  deriveVersion: (projectId, versionId, input) => invokeImageWorkbench('deriveVersion', { projectId, versionId, input }),
  listCanvases: projectId => invokeImageWorkbench('listCanvases', { projectId }),
  getCanvas: input => invokeImageWorkbench('getCanvas', input),
  getDeliverySet: input => invokeImageWorkbench('getDeliverySet', input),
  getExportReceipt: input => invokeImageWorkbench('getExportReceipt', input),
  getProjectLibrary: projectId => invokeImageWorkbench('getProjectLibrary', { projectId }),
  listBrandKits: () => invokeImageWorkbench('listBrandKits', {}),
  getBrandKit: brandKitId => invokeImageWorkbench('getBrandKit', { brandKitId }),
  createBrandKit: input => invokeImageWorkbench('createBrandKit', { input }),
  reviseBrandKit: input => invokeImageWorkbench('reviseBrandKit', input),
  deleteBrandKit: input => invokeImageWorkbench('deleteBrandKit', input),
  listTemplates: () => invokeImageWorkbench('listTemplates', {}),
  getTemplate: templateId => invokeImageWorkbench('getTemplate', { templateId }),
  createTemplate: input => invokeImageWorkbench('createTemplate', { input }),
  reviseTemplate: input => invokeImageWorkbench('reviseTemplate', input),
  deleteTemplate: input => invokeImageWorkbench('deleteTemplate', input),
  createAssetGrant: input => invokeImageWorkbench('createAssetGrant', { input }),
  revokeAssetGrant: input => invokeImageWorkbench('revokeAssetGrant', input),
  listAssetGrants: () => invokeImageWorkbench('listAssetGrants', {}),
  listCampaigns: input => invokeImageWorkbench('listCampaigns', { ...(input === undefined ? {} : { input }) }),
  getCampaign: campaignId => invokeImageWorkbench('getCampaign', { campaignId }),
  createCampaign: input => invokeImageWorkbench('createCampaign', { input }),
  replaceCampaignItems: input => invokeImageWorkbench('replaceCampaignItems', input),
  estimateCampaign: input => invokeImageWorkbench('estimateCampaign', input),
  confirmCampaign: input => invokeImageWorkbench('confirmCampaign', input),
  confirmCampaignRetry: input => invokeImageWorkbench('confirmCampaignRetry', input),
  startCampaign: input => invokeImageWorkbench('startCampaign', input),
  cancelCampaign: input => invokeImageWorkbench('cancelCampaign', input),
  retryCampaignItem: input => invokeImageWorkbench('retryCampaignItem', input),
}

// Video deliberately has a single discriminated IPC channel. Preload exposes
// typed methods, while Main still receives a strict, auditable command union.
const videos: VideoWorkbenchPreloadBridge = {
  listProjects: () => invoke<VideoBridgeResult<'listProjects'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'list_projects' },
  ),
  createProject: input => invoke<VideoBridgeResult<'createProject'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_project', input },
  ),
  loadWorkspace: (projectId, eventCursor) => invoke<VideoBridgeResult<'loadWorkspace'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'load_workspace', projectId, eventCursor },
  ),
  loadOperationEvents: (projectId, cursor) => invoke<VideoBridgeResult<'loadOperationEvents'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'load_operation_events', projectId, cursor },
  ),
  loadFacts: (projectId, kind, request) => invoke<VideoBridgeResult<'loadFacts'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'load_facts', projectId, kind, ...(request ? { request } : {}) },
  ),
  searchFacts: (projectId, query, request) => invoke<VideoBridgeResult<'searchFacts'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'search_facts', projectId, query, ...(request ? { request } : {}) },
  ),
  loadReviewNotes: (projectId, timelineVersionId) => invoke<VideoBridgeResult<'loadReviewNotes'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'load_review_notes', projectId, timelineVersionId },
  ),
  createReviewNote: (projectId, timelineVersionId, command) => invoke<VideoBridgeResult<'createReviewNote'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_review_note', projectId, timelineVersionId, command },
  ),
  resolveReviewNote: (projectId, timelineVersionId, reviewNoteId, command) => invoke<VideoBridgeResult<'resolveReviewNote'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'resolve_review_note', projectId, timelineVersionId, reviewNoteId, command },
  ),
  createApprovalDecision: (projectId, timelineVersionId, command) => invoke<VideoBridgeResult<'createApprovalDecision'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_approval_decision', projectId, timelineVersionId, command },
  ),
  chooseSources: projectId => invoke<VideoBridgeResult<'chooseSources'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'choose_sources', projectId },
  ),
  addSources: (projectId, selectionIds, idempotencyKey) => invoke<VideoBridgeResult<'addSources'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'add_sources', projectId, selectionIds, idempotencyKey },
  ),
  estimateRemoteAnalysis: (projectId, command) => invoke<VideoBridgeResult<'estimateRemoteAnalysis'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'estimate_remote_analysis', projectId, command },
  ),
  grantRemoteAnalysisConsent: (projectId, command) => invoke<VideoBridgeResult<'grantRemoteAnalysisConsent'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'grant_remote_analysis_consent', projectId, command },
  ),
  createQuickDraft: (projectId, command) => invoke<VideoBridgeResult<'createQuickDraft'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_quick_draft', projectId, command },
  ),
  applyEditorialCommandSet: (projectId, command) => invoke<VideoBridgeResult<'applyEditorialCommandSet'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'apply_editorial_command_set', projectId, command },
  ),
  createDeliveryVariant: (projectId, command) => invoke<VideoBridgeResult<'createDeliveryVariant'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_delivery_variant', projectId, command },
  ),
  applyDeliveryVariantCommandSet: (projectId, variantId, command) => invoke<VideoBridgeResult<'applyDeliveryVariantCommandSet'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'apply_delivery_variant_command_set', projectId, variantId, command },
  ),
  createCaptionDraft: (projectId, command) => invoke<VideoBridgeResult<'createCaptionDraft'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_caption_draft', projectId, command },
  ),
  createCaptionRevision: (projectId, captionDocumentId, command) => invoke<VideoBridgeResult<'createCaptionRevision'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_caption_revision', projectId, captionDocumentId, command },
  ),
  createCaptionTranslation: (projectId, captionDocumentId, command) => invoke<VideoBridgeResult<'createCaptionTranslation'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_caption_translation', projectId, captionDocumentId, command },
  ),
  createCompositionPlan: (projectId, command) => invoke<VideoBridgeResult<'createCompositionPlan'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_composition_plan', projectId, command },
  ),
  createAudioFinishingPlan: (projectId, command) => invoke<VideoBridgeResult<'createAudioFinishingPlan'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_audio_finishing_plan', projectId, command },
  ),
  analyzeBeat: (projectId, command) => invoke<VideoBridgeResult<'analyzeBeat'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'analyze_beat', projectId, command },
  ),
  createBeatSyncDraft: (projectId, command) => invoke<VideoBridgeResult<'createBeatSyncDraft'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'create_beat_sync_draft', projectId, command },
  ),
  analyzeSubjectTrack: (projectId, command) => invoke<VideoBridgeResult<'analyzeSubjectTrack'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'analyze_subject_track', projectId, command },
  ),
  preflightVariant: (projectId, variantId, command) => invoke<VideoBridgeResult<'preflightVariant'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'preflight_variant', projectId, variantId, command },
  ),
  previewVariant: (projectId, variantId, command) => invoke<VideoBridgeResult<'previewVariant'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'preview_variant', projectId, variantId, command },
  ),
  chooseExportDestination: (projectId, variantId) => invoke<VideoBridgeResult<'chooseExportDestination'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'choose_export_destination', projectId, variantId },
  ),
  renderVariant: (projectId, variantId, destinationGrantId, command) => invoke<VideoBridgeResult<'renderVariant'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'render_variant', projectId, variantId, destinationGrantId, command },
  ),
  confirmPostRenderQuality: (projectId, operationId, command) => invoke<VideoBridgeResult<'confirmPostRenderQuality'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'confirm_post_render_quality', projectId, operationId, command },
  ),
  cancelOperation: operationId => invoke<VideoBridgeResult<'cancelOperation'>>(
    ELECTRON_IPC_CHANNELS.videoWorkbench,
    { action: 'cancel_operation', operationId },
  ),
}

const media = {
  images,
  videos,
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
