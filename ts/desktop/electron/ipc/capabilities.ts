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

const commandInvoke: Validator = value =>
  isRecord(value)
  && typeof value.command === 'string'
  && value.command.length > 0
  && (value.args === undefined || isRecord(value.args))

const terminalWrite: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'
  && typeof value.data === 'string'

const terminalSpawn: Validator = value =>
  value === undefined
  || (
    isRecord(value)
    && (value.cols === undefined || typeof value.cols === 'number')
    && (value.rows === undefined || typeof value.rows === 'number')
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.shell === undefined || typeof value.shell === 'string')
  )

const terminalResize: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'
  && typeof value.cols === 'number'
  && typeof value.rows === 'number'

const terminalSessionId: Validator = value =>
  isRecord(value)
  && typeof value.sessionId === 'number'

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

const productTaskId: Validator = value =>
  typeof value === 'string'
  && /^[0-9a-zA-Z_-]{1,64}$/.test(value)

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

const mediaSubmitImage: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'confirmUnknownRetry', 'confirmedDataEgress'])
  && mediaProjectId(value.projectId)
  && typeof value.confirmUnknownRetry === 'boolean'
  && typeof value.confirmedDataEgress === 'boolean'

const mediaUpdateUnknownImage: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input'])) return false
  if (!mediaProjectId(value.projectId) || !isRecord(value.input)) return false
  const input = value.input
  return hasOnlyKeys(input, ['revision', 'prompt', 'size', 'count', 'confirm_unknown_retry'])
    && typeof input.revision === 'number'
    && Number.isInteger(input.revision)
    && input.revision >= 0
    && typeof input.prompt === 'string'
    && input.prompt.trim().length > 0
    && input.prompt.length <= 8000
    && ['1024x1024', '1536x1024', '1024x1536'].includes(String(input.size))
    && typeof input.count === 'number'
    && Number.isInteger(input.count)
    && input.count >= 1
    && input.count <= 4
    && input.confirm_unknown_retry === true
}

const mediaRenderVideo: Validator = value =>
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

const mediaAnalyzeVideo: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['projectId', 'baseRevision', 'userGoal'])
  && mediaProjectId(value.projectId)
  && typeof value.baseRevision === 'number'
  && Number.isInteger(value.baseRevision)
  && value.baseRevision >= 0
  && typeof value.userGoal === 'string'
  && value.userGoal.trim().length > 0
  && value.userGoal.length <= 8000

const mediaSaveImageOutput: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input'])) return false
  if (!mediaProjectId(value.projectId) || !isRecord(value.input)) return false
  return hasOnlyKeys(value.input, ['output_id', 'version_id', 'output_path'])
    && (mediaProjectId(value.input.output_id) || mediaProjectId(value.input.version_id))
    && typeof value.input.output_path === 'string'
    && value.input.output_path.length > 0
    && value.input.output_path.length <= 4096
}

const mediaStartImageOperation: Validator = value => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['projectId', 'input', 'confirmedDataEgress'])) return false
  if (!mediaProjectId(value.projectId) || typeof value.confirmedDataEgress !== 'boolean' || !isRecord(value.input)) return false
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
  [ELECTRON_IPC_CHANNELS.commandInvoke]: commandInvoke,
  [ELECTRON_IPC_CHANNELS.clipboardReadText]: noPayload,
  [ELECTRON_IPC_CHANNELS.clipboardWriteText]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpen]: stringPayload,
  [ELECTRON_IPC_CHANNELS.shellOpenPath]: stringPayload,
  [ELECTRON_IPC_CHANNELS.dialogOpen]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.dialogSave]: optionalRecord,
  [ELECTRON_IPC_CHANNELS.mediaSubmitImage]: mediaSubmitImage,
  [ELECTRON_IPC_CHANNELS.mediaStartImageOperation]: mediaStartImageOperation,
  [ELECTRON_IPC_CHANNELS.mediaUpdateUnknownImage]: mediaUpdateUnknownImage,
  [ELECTRON_IPC_CHANNELS.mediaSaveImageOutput]: mediaSaveImageOutput,
  [ELECTRON_IPC_CHANNELS.mediaRenderVideo]: mediaRenderVideo,
  [ELECTRON_IPC_CHANNELS.mediaAnalyzeVideo]: mediaAnalyzeVideo,
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
