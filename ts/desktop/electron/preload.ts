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
  updatePermissionMode: (threadId: string, permissionMode: unknown) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentUpdatePermissionMode,
    { threadId, permissionMode },
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
  listHooks: (threadId: string, cwd: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListHooks,
    { threadId, cwd },
  ),
  listCollaborationModes: (threadId: string) => invoke(
    ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes,
    { threadId },
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
      save: (input: unknown) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationSave, input),
      setRoute: (capability: unknown, profileId: string | null) => invoke(
        ELECTRON_IPC_CHANNELS.modelConfigurationSetRoute,
        { capability, profileId },
      ),
      remove: (profileId: string) => invoke(ELECTRON_IPC_CHANNELS.modelConfigurationRemove, profileId),
    },
  })
}
