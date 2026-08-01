import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './channels'

type Validator = (payload: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const noPayload: Validator = value => value === undefined
const optionalRecord: Validator = value => value === undefined || isRecord(value)
const stringPayload: Validator = value => typeof value === 'string'
const booleanPayload: Validator = value => typeof value === 'boolean'
const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: string[]) =>
  Object.keys(value).every(key => allowedKeys.includes(key))
const productTaskId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-zA-Z_-]{1,64}$/.test(value)

const commandInvoke: Validator = value =>
  isRecord(value)
  && typeof value.command === 'string'
  && value.command.length > 0
  && (value.args === undefined || isRecord(value.args))

const personalModelProfileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)

const personalModelCapability = (value: unknown): boolean =>
  value === 'TextReasoning' || value === 'VisualEvidence'

const personalModelProtocol = (value: unknown): boolean =>
  value === 'openai-compatible' || value === 'openai-responses' || value === 'anthropic-messages'

const modelConfigurationSave: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['id', 'label', 'base_url', 'model', 'api_key', 'protocol', 'capabilities', 'supports_tool_calls'])
  && (value.id === undefined || personalModelProfileId(value.id))
  && typeof value.label === 'string' && value.label.trim().length > 0 && value.label.length <= 80
  && typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048
  && typeof value.model === 'string' && value.model.trim().length > 0 && value.model.length <= 200
  && typeof value.api_key === 'string' && value.api_key.length <= 4_096
  && personalModelProtocol(value.protocol)
  && Array.isArray(value.capabilities) && value.capabilities.length === 1
  && value.capabilities[0] === 'TextReasoning'
  && (value.supports_tool_calls === undefined || typeof value.supports_tool_calls === 'boolean')

const modelConfigurationSetRoute: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['capability', 'profileId'])
  && personalModelCapability(value.capability)
  && (value.profileId === null || personalModelProfileId(value.profileId))

const terminalWrite: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['taskId', 'sessionId', 'data'])
  && productTaskId(value.taskId)
  && Number.isSafeInteger(value.sessionId)
  && Number(value.sessionId) > 0
  && typeof value.data === 'string'
  && value.data.length <= 65_536

const terminalSpawn: Validator = value =>
  value === undefined
  || (
    isRecord(value)
    && productTaskId(value.taskId)
    && (value.cols === undefined || typeof value.cols === 'number')
    && (value.rows === undefined || typeof value.rows === 'number')
    && (value.cols === undefined || Number.isFinite(value.cols))
    && (value.rows === undefined || Number.isFinite(value.rows))
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && hasOnlyKeys(value, ['taskId', 'cols', 'rows', 'cwd'])
  )

const terminalResize: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['taskId', 'sessionId', 'cols', 'rows'])
  && productTaskId(value.taskId)
  && Number.isSafeInteger(value.sessionId)
  && Number(value.sessionId) > 0
  && typeof value.cols === 'number'
  && Number.isFinite(value.cols)
  && typeof value.rows === 'number'
  && Number.isFinite(value.rows)

const terminalSessionId: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['taskId', 'sessionId'])
  && productTaskId(value.taskId)
  && Number.isSafeInteger(value.sessionId)
  && Number(value.sessionId) > 0

const boundsPayload: Validator = value =>
  isRecord(value)
  && typeof value.x === 'number'
  && typeof value.y === 'number'
  && typeof value.width === 'number'
  && typeof value.height === 'number'

const urlWithOptionalBounds: Validator = value =>
  isRecord(value)
  && typeof value.url === 'string'
  && (value.bounds === undefined || boundsPayload(value.bounds))

const zoomPayload: Validator = value => typeof value === 'number' && Number.isFinite(value)

const browserResolveAction: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['taskId', 'actionId', 'expectedRevision', 'approved'])
  && productTaskId(value.taskId)
  && typeof value.actionId === 'string'
  && /^[0-9a-zA-Z_-]{8,128}$/.test(value.actionId)
  && Number.isSafeInteger(value.expectedRevision)
  && Number(value.expectedRevision) >= 0
  && typeof value.approved === 'boolean'

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
  [ELECTRON_IPC_CHANNELS.modelConfigurationSave]: modelConfigurationSave,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSetRoute]: modelConfigurationSetRoute,
  [ELECTRON_IPC_CHANNELS.modelConfigurationRemove]: personalModelProfileId,
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
  [ELECTRON_IPC_CHANNELS.browserStatus]: noPayload,
  [ELECTRON_IPC_CHANNELS.browserInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.browserListActions]: productTaskId,
  [ELECTRON_IPC_CHANNELS.browserResolveAction]: browserResolveAction,
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
  [ELECTRON_IPC_CHANNELS.windowOpenProductTask]: productTaskId,
  [ELECTRON_IPC_CHANNELS.terminalSpawn]: terminalSpawn,
  [ELECTRON_IPC_CHANNELS.terminalWrite]: terminalWrite,
  [ELECTRON_IPC_CHANNELS.terminalResize]: terminalResize,
  [ELECTRON_IPC_CHANNELS.terminalKill]: terminalSessionId,
  [ELECTRON_IPC_CHANNELS.terminalGetBashPath]: noPayload,
  [ELECTRON_IPC_CHANNELS.terminalSetBashPath]: value => value === null || stringPayload(value),
  [ELECTRON_IPC_CHANNELS.previewOpen]: urlWithOptionalBounds,
  [ELECTRON_IPC_CHANNELS.previewNavigate]: stringPayload,
  [ELECTRON_IPC_CHANNELS.previewSetBounds]: boundsPayload,
  [ELECTRON_IPC_CHANNELS.previewSetVisible]: booleanPayload,
  [ELECTRON_IPC_CHANNELS.previewSetZoom]: zoomPayload,
  [ELECTRON_IPC_CHANNELS.previewClose]: noPayload,
  [ELECTRON_IPC_CHANNELS.previewMessage]: () => true,
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
