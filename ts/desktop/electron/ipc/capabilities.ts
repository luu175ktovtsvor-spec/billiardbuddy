import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './channels'

type Validator = (payload: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const noPayload: Validator = value => value === undefined
const optionalRecord: Validator = value => value === undefined || isRecord(value)
const stringPayload: Validator = value => typeof value === 'string'
const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: string[]) =>
  Object.keys(value).every(key => allowedKeys.includes(key))
const commandInvoke: Validator = value =>
  isRecord(value)
  && typeof value.command === 'string'
  && value.command.length > 0
  && (value.args === undefined || isRecord(value.args))

const personalModelProfileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)

const personalModelCatalogEntryId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{2,160}$/i.test(value)

const personalModelCapability = (value: unknown): boolean =>
  value === 'TextReasoning' || value === 'VisualEvidence'

const personalModelProtocol = (value: unknown): boolean =>
  value === 'openai-compatible' || value === 'openai-responses'

const personalModelAuthMode = (value: unknown): boolean =>
  value === 'bearer' || value === 'x-api-key' || value === 'api-key'

const personalModelContextWindow = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 8_192 && value <= 2_000_000

const personalModelMaxOutputTokens = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1_024 && value <= 1_000_000

const personalModelContextContract = (contextWindowTokens: unknown, maxOutputTokens: unknown): boolean =>
  contextWindowTokens === undefined && maxOutputTokens === undefined
  || typeof contextWindowTokens === 'number'
    && typeof maxOutputTokens === 'number'
    && personalModelContextWindow(contextWindowTokens)
    && personalModelMaxOutputTokens(maxOutputTokens)
    && maxOutputTokens < contextWindowTokens

const nativeCodexId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)

const nativeWorkspacePath = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 4_096
  && !/[\u0000\r\n]/.test(value)

const nativeMessageId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 512
  && !/[\u0000\r\n]/.test(value)

const nativePermissionMode = (value: unknown): value is string =>
  value === 'ask' || value === 'approve-for-me' || value === 'full-access'

const nativeTurnInput = (value: unknown): boolean =>
  isRecord(value)
  && hasOnlyKeys(value, ['type', 'text', 'url'])
  && (
    value.type === 'text'
      ? typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 1_048_576 && value.url === undefined
      : value.type === 'image'
        ? typeof value.url === 'string'
        && value.url.length > 0
        && value.url.length <= 32 * 1024 * 1024
        && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.url)
        && value.text === undefined
        : false
  )

const nativeAgentStartThread: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd', 'permissionMode'])
  && nativeWorkspacePath(value.cwd)
  && (value.permissionMode === undefined || nativePermissionMode(value.permissionMode))

const nativePageCursor = (value: unknown): boolean =>
  value === undefined
  || typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/[\u0000\r\n]/.test(value)

const nativePageLimit = (value: unknown): boolean =>
  value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 200

const nativeSortDirection = (value: unknown): boolean =>
  value === undefined || value === 'asc' || value === 'desc'

const nativeThreadSortKey = (value: unknown): boolean =>
  value === undefined || value === 'created_at' || value === 'updated_at' || value === 'recency_at'

const nativeThreadSearchTerm = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000\r\n]/.test(value)

const nativeTurnItemsView = (value: unknown): boolean =>
  value === undefined || value === 'notLoaded' || value === 'summary' || value === 'full'

const nativeAgentListThreads: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd', 'cursor', 'limit', 'archived', 'searchTerm', 'sortKey', 'sortDirection'])
  && nativeWorkspacePath(value.cwd)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)
  && (value.archived === undefined || typeof value.archived === 'boolean')
  && (value.searchTerm === undefined || nativeThreadSearchTerm(value.searchTerm))
  && nativeThreadSortKey(value.sortKey)
  && nativeSortDirection(value.sortDirection)

const nativeAgentSearchThreads: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd', 'searchTerm', 'cursor', 'limit', 'archived', 'sortKey', 'sortDirection'])
  && nativeWorkspacePath(value.cwd)
  && nativeThreadSearchTerm(value.searchTerm)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)
  && (value.archived === undefined || typeof value.archived === 'boolean')
  && nativeThreadSortKey(value.sortKey)
  && nativeSortDirection(value.sortDirection)

const nativeAgentResumeThread: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)

const nativeAgentForkThread: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd', 'lastTurnId', 'permissionMode'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)
  && (value.permissionMode === undefined || nativePermissionMode(value.permissionMode))
  && (value.lastTurnId === undefined || nativeCodexId(value.lastTurnId))

const nativeAgentUpdatePermissionMode: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'permissionMode'])
  && nativeCodexId(value.threadId)
  && nativePermissionMode(value.permissionMode)

const nativeAgentStartTurn: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'input', 'clientUserMessageId', 'collaborationMode'])
  && nativeCodexId(value.threadId)
  && Array.isArray(value.input)
  && value.input.length > 0
  && value.input.length <= 64
  && value.input.every(nativeTurnInput)
  && (value.clientUserMessageId === undefined || nativeMessageId(value.clientUserMessageId))
  && (value.collaborationMode === undefined || value.collaborationMode === 'default' || value.collaborationMode === 'plan')

const nativeReviewLine = (value: unknown): boolean =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 512
  && !/[\u0000\r\n]/.test(value)

const nativeReviewTarget = (value: unknown): boolean =>
  isRecord(value)
  && (
    value.type === 'uncommittedChanges'
      ? hasOnlyKeys(value, ['type'])
      : value.type === 'baseBranch'
        ? hasOnlyKeys(value, ['type', 'branch']) && nativeReviewLine(value.branch)
        : value.type === 'commit'
          ? hasOnlyKeys(value, ['type', 'sha', 'title'])
            && nativeReviewLine(value.sha)
            && (value.title === undefined || nativeReviewLine(value.title))
          : value.type === 'custom'
            ? hasOnlyKeys(value, ['type', 'instructions'])
              && typeof value.instructions === 'string'
              && value.instructions.trim().length > 0
              && value.instructions.length <= 1_048_576
              && !value.instructions.includes('\u0000')
            : false
  )

const nativeAgentStartReview: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'target', 'delivery'])
  && nativeCodexId(value.threadId)
  && nativeReviewTarget(value.target)
  && (value.delivery === undefined || value.delivery === 'inline' || value.delivery === 'detached')

const nativeAgentSteerTurn: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'turnId', 'text', 'clientUserMessageId'])
  && nativeCodexId(value.threadId)
  && nativeCodexId(value.turnId)
  && typeof value.text === 'string'
  && value.text.length > 0
  && value.text.length <= 1_048_576
  && (value.clientUserMessageId === undefined || nativeMessageId(value.clientUserMessageId))

const nativeAgentTurnReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'turnId'])
  && nativeCodexId(value.threadId)
  && nativeCodexId(value.turnId)

const nativeAgentThreadReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId'])
  && nativeCodexId(value.threadId)

const nativeAgentStoredThreadReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)

const nativeAgentThreadName: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'name'])
  && nativeCodexId(value.threadId)
  && typeof value.name === 'string'
  && value.name.trim().length > 0
  && value.name.length <= 512
  && !/[\u0000\r\n]/.test(value.name)

const nativeAgentThreadRollback: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'numTurns'])
  && nativeCodexId(value.threadId)
  && typeof value.numTurns === 'number'
  && Number.isSafeInteger(value.numTurns)
  && value.numTurns >= 1
  && value.numTurns <= 10_000

const nativeAgentThreadTurnsPage: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'])
  && nativeCodexId(value.threadId)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)
  && nativeSortDirection(value.sortDirection)
  && nativeTurnItemsView(value.itemsView)

const nativeAgentThreadItemsPage: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'turnId', 'cursor', 'limit', 'sortDirection'])
  && nativeCodexId(value.threadId)
  && (value.turnId === undefined || nativeCodexId(value.turnId))
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)
  && nativeSortDirection(value.sortDirection)

const nativeMcpServerName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

const nativeJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 16 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 16
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => nativeJsonValue(item, depth + 1))
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 256 && entries.every(([key, item]) => (
    key.length > 0
    && key.length <= 256
    && key !== '__proto__'
    && key !== 'constructor'
    && key !== 'prototype'
    && nativeJsonValue(item, depth + 1)
  ))
}

const nativeAgentResolveServerRequest: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['requestId', 'response'])
  && nativeCodexId(value.requestId)
  && isRecord(value.response)
  && nativeJsonValue(value.response)
  && Buffer.byteLength(JSON.stringify(value.response)) <= 512 * 1024

const nativeAgentConfigureMcpServer: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'name', 'config'])
  && nativeCodexId(value.threadId)
  && nativeMcpServerName(value.name)
  && isRecord(value.config)
  && nativeJsonValue(value.config)
  && Buffer.byteLength(JSON.stringify(value.config)) <= 512 * 1024

const nativeAgentMcpServerReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'name'])
  && nativeCodexId(value.threadId)
  && nativeMcpServerName(value.name)

const nativeAgentCatalogReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)

const nativeAgentSetSkillEnabled: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'name', 'path', 'enabled'])
  && nativeCodexId(value.threadId)
  && typeof value.enabled === 'boolean'
  && (
    typeof value.name === 'string'
      ? value.name.length > 0 && value.name.length <= 512 && value.path === undefined && !/[\u0000\r\n]/.test(value.name)
      : typeof value.path === 'string'
        ? value.path.length > 0 && value.path.length <= 4_096 && value.name === undefined && !/[\u0000\r\n]/.test(value.path)
        : false
  )

const nativePluginText = (value: unknown, maximum = 512): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= maximum
  && !/[\u0000\r\n]/.test(value)

const nativeAgentSetExtraSkillRoots: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'roots'])
  && nativeCodexId(value.threadId)
  && Array.isArray(value.roots)
  && value.roots.length <= 64
  && value.roots.every(nativeWorkspacePath)

const nativeAgentPluginCatalog: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)

const nativeAgentPluginReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'marketplacePath', 'pluginName'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.marketplacePath)
  && nativePluginText(value.pluginName)

const nativeAgentMarketplaceAdd: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'source', 'refName', 'sparsePaths'])
  && nativeCodexId(value.threadId)
  && nativePluginText(value.source, 4_096)
  && (value.refName === undefined || nativePluginText(value.refName))
  && (value.sparsePaths === undefined
    || Array.isArray(value.sparsePaths)
      && value.sparsePaths.length <= 64
      && value.sparsePaths.every(item => nativePluginText(item, 4_096)))

const nativeAgentMarketplaceReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'marketplaceName'])
  && nativeCodexId(value.threadId)
  && nativePluginText(value.marketplaceName)

const nativeAgentMarketplaceUpgrade: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'marketplaceName'])
  && nativeCodexId(value.threadId)
  && (value.marketplaceName === undefined || nativePluginText(value.marketplaceName))

const nativeAgentPluginUninstall: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'pluginId'])
  && nativeCodexId(value.threadId)
  && nativePluginText(value.pluginId)

const modelConfigurationSave: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, [
    'id',
    'label',
    'base_url',
    'model',
    'api_key',
    'protocol',
    'auth_mode',
    'capabilities',
    'supports_tool_calls',
    'supports_parallel_tool_calls',
    'catalog_entry_id',
    'context_window_tokens',
    'max_output_tokens',
  ])
  && (value.id === undefined || personalModelProfileId(value.id))
  && typeof value.label === 'string' && value.label.trim().length > 0 && value.label.length <= 80
  && typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048
  && typeof value.model === 'string' && value.model.trim().length > 0 && value.model.length <= 200
  && typeof value.api_key === 'string' && value.api_key.length <= 4_096
  && personalModelProtocol(value.protocol)
  && (value.auth_mode === undefined || personalModelAuthMode(value.auth_mode))
  && Array.isArray(value.capabilities) && value.capabilities.length === 1
  && value.capabilities[0] === 'TextReasoning'
  && (value.supports_tool_calls === undefined || typeof value.supports_tool_calls === 'boolean')
  && (value.supports_parallel_tool_calls === undefined || typeof value.supports_parallel_tool_calls === 'boolean')
  && (value.catalog_entry_id === undefined || value.catalog_entry_id === null || personalModelCatalogEntryId(value.catalog_entry_id))
  && personalModelContextContract(value.context_window_tokens, value.max_output_tokens)

const modelConfigurationDiscover: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['base_url', 'api_key', 'protocol', 'auth_mode'])
  && typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048
  && typeof value.api_key === 'string' && value.api_key.length >= 8 && value.api_key.length <= 4_096
  && personalModelProtocol(value.protocol)
  && (value.auth_mode === undefined || personalModelAuthMode(value.auth_mode))

const modelConfigurationSetRoute: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['capability', 'profileId'])
  && personalModelCapability(value.capability)
  && (value.profileId === null || personalModelProfileId(value.profileId))

const zoomPayload: Validator = value => typeof value === 'number' && Number.isFinite(value)

const updateCheckOptions: Validator = value => {
  if (value === undefined) return true
  if (!isRecord(value) || !hasOnlyKeys(value, ['proxy'])) return false
  return value.proxy === undefined || (typeof value.proxy === 'string' && value.proxy.trim().length > 0)
}

const mediaProjectId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(value)

const imageSubmitProject: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'confirmUnknownRetry'])
  && mediaProjectId(value.projectId)
  && typeof value.confirmUnknownRetry === 'boolean'

const imageUpdateUnknownProject: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input'])) return false
  if (!mediaProjectId(value.projectId) || !isRecord(value.input)) return false
  const input = value.input
  return hasOnlyKeys(input, ['revision', 'user_request', 'size', 'confirm_unknown_retry'])
    && typeof input.revision === 'number'
    && Number.isInteger(input.revision)
    && input.revision >= 0
    && typeof input.user_request === 'string'
    && input.user_request.trim().length > 0
    && input.user_request.length <= 8000
    && typeof input.size === 'string'
    && /^\d{3,4}x\d{3,4}$/.test(input.size)
    && input.confirm_unknown_retry === true
}

const videoAddSource: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'path'])
  && mediaProjectId(value.projectId)
  && typeof value.path === 'string'
  && value.path.length > 0
  && value.path.length <= 4096

const videoRender: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'baseRevision', 'timelineVersionId', 'outputPath'])
  && mediaProjectId(value.projectId)
  && typeof value.baseRevision === 'number'
  && Number.isInteger(value.baseRevision)
  && value.baseRevision >= 0
  && mediaProjectId(value.timelineVersionId)
  && typeof value.outputPath === 'string'
  && value.outputPath.length > 0
  && value.outputPath.length <= 4096

const videoAnalyze: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'baseRevision', 'userGoal'])
  && mediaProjectId(value.projectId)
  && typeof value.baseRevision === 'number'
  && Number.isInteger(value.baseRevision)
  && value.baseRevision >= 0
  && typeof value.userGoal === 'string'
  && value.userGoal.trim().length > 0
  && value.userGoal.length <= 8000

const imageSaveOutput: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input'])) return false
  if (!mediaProjectId(value.projectId) || !isRecord(value.input)) return false
  return hasOnlyKeys(value.input, ['output_id', 'version_id', 'output_path'])
    && (mediaProjectId(value.input.output_id) || mediaProjectId(value.input.version_id))
    && typeof value.input.output_path === 'string'
    && value.input.output_path.length > 0
    && value.input.output_path.length <= 4096
}

const imageStartOperation: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input'])) return false
  if (!mediaProjectId(value.projectId) || !isRecord(value.input)) return false
  return hasOnlyKeys(value.input, [
    'revision', 'base_version_id', 'kind', 'instruction', 'mask_data_url', 'confirm_unknown_retry',
  ])
    && typeof value.input.revision === 'number'
    && Number.isInteger(value.input.revision)
    && value.input.revision >= 0
    && mediaProjectId(value.input.base_version_id)
    && (value.input.kind === 'edit' || value.input.kind === 'inpaint')
    && typeof value.input.instruction === 'string'
    && value.input.instruction.length > 0
    && value.input.instruction.length <= 4000
    && (value.input.mask_data_url === undefined
      || typeof value.input.mask_data_url === 'string' && value.input.mask_data_url.length <= 45_000_000)
    && typeof value.input.confirm_unknown_retry === 'boolean'
}

export const ELECTRON_IPC_VALIDATORS = {
  [ELECTRON_IPC_CHANNELS.appGetVersion]: noPayload,
  [ELECTRON_IPC_CHANNELS.runtimeGetServerUrl]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSummary]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationCatalog]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationDiscover]: modelConfigurationDiscover,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSave]: modelConfigurationSave,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSetRoute]: modelConfigurationSetRoute,
  [ELECTRON_IPC_CHANNELS.modelConfigurationRemove]: personalModelProfileId,
  [ELECTRON_IPC_CHANNELS.nativeAgentStartThread]: nativeAgentStartThread,
  [ELECTRON_IPC_CHANNELS.nativeAgentListThreads]: nativeAgentListThreads,
  [ELECTRON_IPC_CHANNELS.nativeAgentSearchThreads]: nativeAgentSearchThreads,
  [ELECTRON_IPC_CHANNELS.nativeAgentResumeThread]: nativeAgentResumeThread,
  [ELECTRON_IPC_CHANNELS.nativeAgentReadThread]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentForkThread]: nativeAgentForkThread,
  [ELECTRON_IPC_CHANNELS.nativeAgentUnarchiveThread]: nativeAgentStoredThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentDeleteThread]: nativeAgentStoredThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetThreadName]: nativeAgentThreadName,
  [ELECTRON_IPC_CHANNELS.nativeAgentCompactThread]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentRollbackThread]: nativeAgentThreadRollback,
  [ELECTRON_IPC_CHANNELS.nativeAgentListThreadTurns]: nativeAgentThreadTurnsPage,
  [ELECTRON_IPC_CHANNELS.nativeAgentListThreadItems]: nativeAgentThreadItemsPage,
  [ELECTRON_IPC_CHANNELS.nativeAgentUpdatePermissionMode]: nativeAgentUpdatePermissionMode,
  [ELECTRON_IPC_CHANNELS.nativeAgentStartTurn]: nativeAgentStartTurn,
  [ELECTRON_IPC_CHANNELS.nativeAgentStartReview]: nativeAgentStartReview,
  [ELECTRON_IPC_CHANNELS.nativeAgentSteerTurn]: nativeAgentSteerTurn,
  [ELECTRON_IPC_CHANNELS.nativeAgentInterruptTurn]: nativeAgentTurnReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentArchiveThread]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentResolveServerRequest]: nativeAgentResolveServerRequest,
  [ELECTRON_IPC_CHANNELS.nativeAgentConfigureMcpServer]: nativeAgentConfigureMcpServer,
  [ELECTRON_IPC_CHANNELS.nativeAgentRemoveMcpServer]: nativeAgentMcpServerReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListMcpServerStatuses]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentStartMcpOAuth]: nativeAgentMcpServerReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListSkills]: nativeAgentCatalogReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetSkillEnabled]: nativeAgentSetSkillEnabled,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetExtraSkillRoots]: nativeAgentSetExtraSkillRoots,
  [ELECTRON_IPC_CHANNELS.nativeAgentListHooks]: nativeAgentCatalogReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListPlugins]: nativeAgentPluginCatalog,
  [ELECTRON_IPC_CHANNELS.nativeAgentListInstalledPlugins]: nativeAgentPluginCatalog,
  [ELECTRON_IPC_CHANNELS.nativeAgentReadPlugin]: nativeAgentPluginReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentAddMarketplace]: nativeAgentMarketplaceAdd,
  [ELECTRON_IPC_CHANNELS.nativeAgentRemoveMarketplace]: nativeAgentMarketplaceReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentUpgradeMarketplace]: nativeAgentMarketplaceUpgrade,
  [ELECTRON_IPC_CHANNELS.nativeAgentInstallPlugin]: nativeAgentPluginReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentUninstallPlugin]: nativeAgentPluginUninstall,
  [ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.commandInvoke]: commandInvoke,
  [ELECTRON_IPC_CHANNELS.clipboardReadText]: noPayload,
  [ELECTRON_IPC_CHANNELS.clipboardWriteText]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpen]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpenPath]: stringPayload,
  [ELECTRON_IPC_CHANNELS.dialogOpen]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.dialogSave]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.imageSubmitProject]: imageSubmitProject,
  [ELECTRON_IPC_CHANNELS.imageStartOperation]: imageStartOperation,
  [ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject]: imageUpdateUnknownProject,
  [ELECTRON_IPC_CHANNELS.imageSaveOutput]: imageSaveOutput,
  [ELECTRON_IPC_CHANNELS.videoAddSource]: videoAddSource,
  [ELECTRON_IPC_CHANNELS.videoRender]: videoRender,
  [ELECTRON_IPC_CHANNELS.videoAnalyze]: videoAnalyze,
  [ELECTRON_IPC_CHANNELS.updateCheck]: updateCheckOptions,
  [ELECTRON_IPC_CHANNELS.updateDownload]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updatePrepareInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateCancelInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.updateRelaunch]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationPermissionState]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationRequestPermission]: noPayload,
  [ELECTRON_IPC_CHANNELS.notificationSend]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.notificationActionAck]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.windowMinimize]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowToggleMaximize]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowClose]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowStartDragging]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowRequestAttention]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowFocus]: noPayload,
  [ELECTRON_IPC_CHANNELS.windowIsMaximized]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeSet]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.appModeDetectPortableDir]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModePrepareRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.appModeRestart]: noPayload,
  [ELECTRON_IPC_CHANNELS.zoomSet]: zoomPayload,
} satisfies Record<ElectronIpcChannel, Validator>

const allowedChannels = new Set<ElectronIpcChannel>(
  Object.values(ELECTRON_IPC_CHANNELS),
)

export function isElectronIpcChannel(channel: string): channel is ElectronIpcChannel {
  return allowedChannels.has(channel as ElectronIpcChannel)
}

export function validateElectronIpcPayload(channel: ElectronIpcChannel, payload: unknown): boolean {
  return ELECTRON_IPC_VALIDATORS[channel](payload)
}
