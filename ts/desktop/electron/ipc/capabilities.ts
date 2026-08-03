import { z } from 'zod/v4'
import {
  adoptImageCandidateInputSchema,
  imageCanvasCommandRequestInputSchema,
  imageArtboardSelectVersionInputSchema,
  imageCanvasCreateInputSchema,
  imageCanvasPreflightInputSchema,
  imageCanvasRenderInputSchema,
  imageSaveOutputInputSchema,
  imageDestinationGrantRequestSchema,
  imageDeliverySpecRevisionInputSchema,
  imageExportInputSchema,
  createCreativePlanInputSchema,
  createGenerationRoundInputSchema,
  decideImageCandidateInputSchema,
  deriveImageCandidateInputSchema,
  estimateDeriveImageCandidateInputSchema,
  estimateGenerationRoundInputSchema,
  updateImageReferenceControlInputSchema,
} from '../../../shared/contracts/imageGeneration'
import {
  mediaIdSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
} from '../../../shared/contracts/media'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './channels'

type Validator = (payload: unknown) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const noPayload: Validator = value => value === undefined
const optionalRecord: Validator = value => value === undefined || isRecord(value)
const stringPayload: Validator = value => typeof value === 'string'
const computerUseConfiguration: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['allowedAppIds'])
  && Array.isArray(value.allowedAppIds)
  && value.allowedAppIds.length <= 64
  && value.allowedAppIds.every(item => typeof item === 'string' && item.length > 0 && item.length <= 32_767 && !/[\u0000\r\n]/.test(item))
const browserPolicyConfiguration: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['allowedHosts', 'blockedHosts'])
  && Array.isArray(value.allowedHosts)
  && value.allowedHosts.length <= 256
  && value.allowedHosts.every(item => typeof item === 'string' && item.length > 0 && item.length <= 255 && !/[\u0000\r\n]/.test(item))
  && Array.isArray(value.blockedHosts)
  && value.blockedHosts.length <= 256
  && value.blockedHosts.every(item => typeof item === 'string' && item.length > 0 && item.length <= 255 && !/[\u0000\r\n]/.test(item))
const hasOnlyKeys = (value: Record<string, unknown>, allowedKeys: string[]) =>
  Object.keys(value).every(key => allowedKeys.includes(key))
const commandInvoke: Validator = value =>
  isRecord(value)
  && typeof value.command === 'string'
  && value.command.length > 0
  && (value.args === undefined || isRecord(value.args))

const personalModelProfileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)

const personalModelProviderPresetId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(value)

const personalModelProtocol = (value: unknown): boolean =>
  value === 'openai-compatible' || value === 'openai-responses'

const personalModelAuthMode = (value: unknown): boolean =>
  value === 'bearer' || value === 'x-api-key' || value === 'api-key'

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

const nativeWindowsSandboxMode = (value: unknown): value is string =>
  value === 'elevated' || value === 'unelevated'

const nativeImageDetail = (value: unknown): boolean =>
  value === undefined || value === 'auto' || value === 'low' || value === 'high' || value === 'original'

const nativeInputPath = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 4_096
  && !/[\u0000\r\n]/.test(value)

const nativeInputName = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 512
  && !/[\u0000\r\n]/.test(value)

const nativeTurnInput = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.type === 'text') {
    return hasOnlyKeys(value, ['type', 'text'])
      && typeof value.text === 'string'
      && value.text.length > 0
      && value.text.length <= 1_048_576
  }
  if (value.type === 'image') {
    return hasOnlyKeys(value, ['type', 'url', 'detail'])
      && typeof value.url === 'string'
      && value.url.length > 0
      && value.url.length <= 32 * 1024 * 1024
      && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.url)
      && nativeImageDetail(value.detail)
  }
  if (value.type === 'localImage') {
    return hasOnlyKeys(value, ['type', 'path', 'detail'])
      && nativeInputPath(value.path)
      && nativeImageDetail(value.detail)
  }
  if (value.type === 'audio') {
    return hasOnlyKeys(value, ['type', 'url'])
      && typeof value.url === 'string'
      && value.url.length > 0
      && value.url.length <= 64 * 1024 * 1024
      && /^data:audio\/(?:wav|mpeg|mp4|webm|ogg);base64,[A-Za-z0-9+/=]+$/.test(value.url)
  }
  if (value.type === 'localAudio') {
    return hasOnlyKeys(value, ['type', 'path']) && nativeInputPath(value.path)
  }
  if (value.type === 'skill') {
    return hasOnlyKeys(value, ['type', 'name', 'path'])
      && nativeInputName(value.name)
      && nativeInputPath(value.path)
  }
  return value.type === 'mention'
    && hasOnlyKeys(value, ['type', 'name', 'path'])
    && nativeInputName(value.name)
    && nativeInputPath(value.path)
    && /^(?:app|plugin):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/.test(value.path)
}

const nativeAgentStartThread: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd', 'permissionMode'])
  && nativeWorkspacePath(value.cwd)
  && (value.permissionMode === undefined || nativePermissionMode(value.permissionMode))

const nativeAgentWindowsSandboxReadiness: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd'])
  && nativeWorkspacePath(value.cwd)

const nativeAgentWindowsSandboxSetupStart: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['cwd', 'mode'])
  && nativeWorkspacePath(value.cwd)
  && nativeWindowsSandboxMode(value.mode)

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
  && hasOnlyKeys(value, ['threadId', 'turnId', 'input', 'clientUserMessageId'])
  && nativeCodexId(value.threadId)
  && nativeCodexId(value.turnId)
  && Array.isArray(value.input)
  && value.input.length > 0
  && value.input.length <= 64
  && value.input.every(nativeTurnInput)
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

const nativeAgentThreadOccurrenceSearch: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'searchTerm', 'cursor', 'limit'])
  && nativeCodexId(value.threadId)
  && nativeThreadSearchTerm(value.searchTerm)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)

const nativeAgentModelList: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cursor', 'limit', 'includeHidden'])
  && nativeCodexId(value.threadId)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)
  && (value.includeHidden === undefined || typeof value.includeHidden === 'boolean')

const nativeAgentPermissionProfileList: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd', 'cursor', 'limit'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)

const nativeAgentThreadMemoryMode: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'mode'])
  && nativeCodexId(value.threadId)
  && (value.mode === 'enabled' || value.mode === 'disabled')

const nativeThreadSectionId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 200
  && !/[\u0000\r\n]/.test(value)

const nativeThreadSectionName = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 512
  && !/[\u0000\r\n]/.test(value)

const nativeAgentThreadSectionList: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cursor', 'limit'])
  && nativeCodexId(value.threadId)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)

const nativeAgentThreadSectionCreate: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'name'])
  && nativeCodexId(value.threadId)
  && nativeThreadSectionName(value.name)

const nativeAgentThreadSectionUpdate: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'sectionId', 'name'])
  && nativeCodexId(value.threadId)
  && nativeThreadSectionId(value.sectionId)
  && nativeThreadSectionName(value.name)

const nativeAgentThreadSectionDelete: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'sectionId'])
  && nativeCodexId(value.threadId)
  && nativeThreadSectionId(value.sectionId)

const nativeAgentThreadSectionMove: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'sectionId', 'beforeThreadId'])
  && nativeCodexId(value.threadId)
  && (value.sectionId === null || nativeThreadSectionId(value.sectionId))
  && (value.beforeThreadId === undefined || nativeCodexId(value.beforeThreadId))

const nativeThreadGoalStatus = (value: unknown): boolean =>
  value === undefined
  || value === 'active'
  || value === 'paused'
  || value === 'blocked'
  || value === 'usageLimited'
  || value === 'budgetLimited'
  || value === 'complete'

const nativeThreadGoalObjective = (value: unknown): boolean =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= 4_000
  && !value.includes('\u0000')

const nativeThreadGoalTokenBudget = (value: unknown): boolean =>
  value === undefined
  || value === null
  || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const nativeAgentThreadGoalSet: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'objective', 'status', 'tokenBudget'])
  && nativeCodexId(value.threadId)
  && (value.objective === undefined || nativeThreadGoalObjective(value.objective))
  && nativeThreadGoalStatus(value.status)
  && nativeThreadGoalTokenBudget(value.tokenBudget)
  && (value.objective !== undefined || value.status !== undefined || value.tokenBudget !== undefined)

const nativeAgentBackgroundTerminalsPage: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cursor', 'limit'])
  && nativeCodexId(value.threadId)
  && nativePageCursor(value.cursor)
  && nativePageLimit(value.limit)

const nativeBackgroundTerminalProcessId = (value: unknown): boolean =>
  typeof value === 'string'
  && /^[1-9][0-9]{0,9}$/.test(value)
  && Number(value) <= 2_147_483_647

const nativeAgentBackgroundTerminalReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'processId'])
  && nativeCodexId(value.threadId)
  && nativeBackgroundTerminalProcessId(value.processId)

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

const nativeAgentMigrationSource = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 128
  && !/[\u0000\r\n]/.test(value)

const nativeAgentDetectExternalConfig: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd', 'includeHome', 'migrationSource'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)
  && typeof value.includeHome === 'boolean'
  && (value.migrationSource === undefined || nativeAgentMigrationSource(value.migrationSource))

const nativeAgentImportExternalConfig: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'detectionId', 'itemIndexes'])
  && nativeCodexId(value.threadId)
  && nativeCodexId(value.detectionId)
  && Array.isArray(value.itemIndexes)
  && value.itemIndexes.length > 0
  && value.itemIndexes.length <= 64
  && value.itemIndexes.every(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item < 256)
  && new Set(value.itemIndexes).size === value.itemIndexes.length

const nativeScheduledTaskId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)

const nativeIntegerBetween = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum

const nativeScheduledTaskSchedule = (value: unknown): boolean => {
  if (!isRecord(value)) return false
  if (value.kind === 'once') return hasOnlyKeys(value, ['kind', 'at']) && typeof value.at === 'number' && Number.isFinite(value.at) && value.at >= 0
  if (value.kind === 'interval') return hasOnlyKeys(value, ['kind', 'everyMs']) && nativeIntegerBetween(value.everyMs, 60_000, 31 * 24 * 60 * 60_000)
  const validClock = nativeIntegerBetween(value.hour, 0, 23) && nativeIntegerBetween(value.minute, 0, 59)
  if (value.kind === 'daily') return hasOnlyKeys(value, ['kind', 'hour', 'minute']) && validClock
  return value.kind === 'weekly' && hasOnlyKeys(value, ['kind', 'days', 'hour', 'minute']) && validClock
    && Array.isArray(value.days) && value.days.length > 0 && value.days.length <= 7
    && value.days.every(day => nativeIntegerBetween(day, 0, 6)) && new Set(value.days).size === value.days.length
}

const nativeAgentListScheduledTasks: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId'])
  && (value.threadId === undefined || nativeCodexId(value.threadId))

const nativeAgentCreateScheduledTask: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'cwd', 'prompt', 'schedule', 'enabled'])
  && nativeCodexId(value.threadId)
  && nativeWorkspacePath(value.cwd)
  && typeof value.prompt === 'string' && value.prompt.trim().length > 0 && value.prompt.length <= 32_000 && !value.prompt.includes('\u0000')
  && nativeScheduledTaskSchedule(value.schedule)
  && typeof value.enabled === 'boolean'

const nativeAgentScheduledTaskReference: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'taskId'])
  && nativeCodexId(value.threadId)
  && nativeScheduledTaskId(value.taskId)

const nativeAgentSetScheduledTaskEnabled: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['threadId', 'taskId', 'enabled'])
  && nativeCodexId(value.threadId)
  && nativeScheduledTaskId(value.taskId)
  && typeof value.enabled === 'boolean'

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
  ])
  && (value.id === undefined || personalModelProfileId(value.id))
  && typeof value.label === 'string' && value.label.trim().length > 0 && value.label.length <= 80
  && typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048
  && typeof value.model === 'string' && value.model.trim().length > 0 && value.model.length <= 200
  && typeof value.api_key === 'string' && value.api_key.length <= 4_096
  && personalModelProtocol(value.protocol)
  && (value.auth_mode === undefined || personalModelAuthMode(value.auth_mode))

const modelConfigurationDiscover: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['base_url', 'api_key', 'protocol', 'auth_mode'])
  && typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048
  && typeof value.api_key === 'string' && value.api_key.length >= 8 && value.api_key.length <= 4_096
  && personalModelProtocol(value.protocol)
  && (value.auth_mode === undefined || personalModelAuthMode(value.auth_mode))

const modelConfigurationDiscoverPreset: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, ['provider_preset_id', 'api_key', 'base_url'])
  && personalModelProviderPresetId(value.provider_preset_id)
  && typeof value.api_key === 'string' && value.api_key.length >= 8 && value.api_key.length <= 4_096
  && (value.base_url === undefined || typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048)

const modelConfigurationSavePreset: Validator = value =>
  isRecord(value)
  && hasOnlyKeys(value, [
    'id',
    'provider_preset_id',
    'api_key',
    'model',
    'label',
    'base_url',
    'protocol',
    'provider_terms_confirmed',
  ])
  && (value.id === undefined || personalModelProfileId(value.id))
  && personalModelProviderPresetId(value.provider_preset_id)
  && typeof value.api_key === 'string' && value.api_key.length <= 4_096
  && typeof value.model === 'string' && value.model.trim().length > 0 && value.model.length <= 200
  && (value.label === undefined || typeof value.label === 'string' && value.label.trim().length > 0 && value.label.length <= 80)
  && (value.base_url === undefined || typeof value.base_url === 'string' && value.base_url.trim().length > 0 && value.base_url.length <= 2_048)
  && (value.protocol === undefined || personalModelProtocol(value.protocol))
  && (value.provider_terms_confirmed === undefined || typeof value.provider_terms_confirmed === 'boolean')

const zoomPayload: Validator = value => typeof value === 'number' && Number.isFinite(value)

const updateCheckOptions: Validator = value => {
  if (value === undefined) return true
  if (!isRecord(value) || !hasOnlyKeys(value, ['proxy'])) return false
  return value.proxy === undefined || (typeof value.proxy === 'string' && value.proxy.trim().length > 0)
}

const mediaProjectId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(value)

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

export const imageSubmitProjectIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  confirmUnknownRetry: submitImageProjectInputSchema.shape.confirm_unknown_retry,
}).strict()
export const imageStartOperationIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: startImageOperationInputSchema.strict(),
}).strict()
export const imageUpdateUnknownProjectIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: updateImageProjectInputSchema.strict(),
}).strict()
export const imageSaveOutputIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: imageSaveOutputInputSchema,
}).strict()
export const imageRequestDestinationIpcPayloadSchema = imageDestinationGrantRequestSchema
export const imageCreateCreativePlanIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: createCreativePlanInputSchema,
}).strict()
export const imageEstimateGenerationRoundIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: estimateGenerationRoundInputSchema,
}).strict()
export const imageEstimateDerivationIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  candidateId: mediaIdSchema,
  input: estimateDeriveImageCandidateInputSchema,
}).strict()
export const imageCreateGenerationRoundIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: createGenerationRoundInputSchema,
}).strict()
export const imageDecideCandidateIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  candidateId: mediaIdSchema,
  input: decideImageCandidateInputSchema,
}).strict()
export const imageAdoptCandidateIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  candidateId: mediaIdSchema,
  input: adoptImageCandidateInputSchema,
}).strict()
export const imageDeriveCandidateIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  candidateId: mediaIdSchema,
  input: deriveImageCandidateInputSchema,
}).strict()
export const imageCancelGenerationOperationIpcPayloadSchema = z.object({
  operationId: mediaIdSchema,
}).strict()
export const imageUpdateReferenceControlIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  referenceId: mediaIdSchema,
  input: updateImageReferenceControlInputSchema,
}).strict()
export const imageCreateDeliverySpecRevisionIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: imageDeliverySpecRevisionInputSchema,
}).strict()
export const imageCreateCanvasIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: imageCanvasCreateInputSchema,
}).strict()
export const imageApplyCanvasCommandIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  canvasId: mediaIdSchema,
  input: imageCanvasCommandRequestInputSchema,
}).strict()
export const imagePreflightCanvasIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  canvasId: mediaIdSchema,
  input: imageCanvasPreflightInputSchema,
}).strict()
export const imageRenderCanvasIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  canvasId: mediaIdSchema,
  input: imageCanvasRenderInputSchema,
}).strict()
export const imageExportDeliveryIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  input: imageExportInputSchema,
}).strict()
export const imageSelectArtboardVersionIpcPayloadSchema = z.object({
  projectId: mediaIdSchema,
  artboardId: mediaIdSchema,
  input: imageArtboardSelectVersionInputSchema,
}).strict()

const imageSubmitProject: Validator = value => imageSubmitProjectIpcPayloadSchema.safeParse(value).success
const imageStartOperation: Validator = value => imageStartOperationIpcPayloadSchema.safeParse(value).success
const imageUpdateUnknownProject: Validator = value => imageUpdateUnknownProjectIpcPayloadSchema.safeParse(value).success
const imageSaveOutput: Validator = value => imageSaveOutputIpcPayloadSchema.safeParse(value).success
const imageCreateCreativePlan: Validator = value => imageCreateCreativePlanIpcPayloadSchema.safeParse(value).success
const imageEstimateGenerationRound: Validator = value => imageEstimateGenerationRoundIpcPayloadSchema.safeParse(value).success
const imageEstimateDerivation: Validator = value => imageEstimateDerivationIpcPayloadSchema.safeParse(value).success
const imageCreateGenerationRound: Validator = value => imageCreateGenerationRoundIpcPayloadSchema.safeParse(value).success
const imageDecideCandidate: Validator = value => imageDecideCandidateIpcPayloadSchema.safeParse(value).success
const imageAdoptCandidate: Validator = value => imageAdoptCandidateIpcPayloadSchema.safeParse(value).success
const imageDeriveCandidate: Validator = value => imageDeriveCandidateIpcPayloadSchema.safeParse(value).success
const imageCancelGenerationOperation: Validator = value => imageCancelGenerationOperationIpcPayloadSchema.safeParse(value).success
const imageUpdateReferenceControl: Validator = value => imageUpdateReferenceControlIpcPayloadSchema.safeParse(value).success
const imageCreateDeliverySpecRevision: Validator = value => imageCreateDeliverySpecRevisionIpcPayloadSchema.safeParse(value).success
const imageCreateCanvas: Validator = value => imageCreateCanvasIpcPayloadSchema.safeParse(value).success
const imageApplyCanvasCommand: Validator = value => imageApplyCanvasCommandIpcPayloadSchema.safeParse(value).success
const imagePreflightCanvas: Validator = value => imagePreflightCanvasIpcPayloadSchema.safeParse(value).success
const imageRenderCanvas: Validator = value => imageRenderCanvasIpcPayloadSchema.safeParse(value).success
const imageExportDelivery: Validator = value => imageExportDeliveryIpcPayloadSchema.safeParse(value).success
const imageRequestDestination: Validator = value => imageRequestDestinationIpcPayloadSchema.safeParse(value).success
const imageSelectArtboardVersion: Validator = value => imageSelectArtboardVersionIpcPayloadSchema.safeParse(value).success

export const ELECTRON_IPC_VALIDATORS = {
  [ELECTRON_IPC_CHANNELS.appGetVersion]: noPayload,
  [ELECTRON_IPC_CHANNELS.runtimeGetServerUrl]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSummary]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationProviderPresets]: noPayload,
  [ELECTRON_IPC_CHANNELS.modelConfigurationOpenProviderPortal]: personalModelProviderPresetId,
  [ELECTRON_IPC_CHANNELS.modelConfigurationDiscover]: modelConfigurationDiscover,
  [ELECTRON_IPC_CHANNELS.modelConfigurationDiscoverPreset]: modelConfigurationDiscoverPreset,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSavePreset]: modelConfigurationSavePreset,
  [ELECTRON_IPC_CHANNELS.modelConfigurationSave]: modelConfigurationSave,
  [ELECTRON_IPC_CHANNELS.modelConfigurationRemove]: personalModelProfileId,
  [ELECTRON_IPC_CHANNELS.nativeAgentStartThread]: nativeAgentStartThread,
  [ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxReadiness]: nativeAgentWindowsSandboxReadiness,
  [ELECTRON_IPC_CHANNELS.nativeAgentWindowsSandboxSetupStart]: nativeAgentWindowsSandboxSetupStart,
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
  [ELECTRON_IPC_CHANNELS.nativeAgentSearchThreadOccurrences]: nativeAgentThreadOccurrenceSearch,
  [ELECTRON_IPC_CHANNELS.nativeAgentListModels]: nativeAgentModelList,
  [ELECTRON_IPC_CHANNELS.nativeAgentReadModelProviderCapabilities]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListPermissionProfiles]: nativeAgentPermissionProfileList,
  [ELECTRON_IPC_CHANNELS.nativeAgentReadConfigRequirements]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetThreadMemoryMode]: nativeAgentThreadMemoryMode,
  [ELECTRON_IPC_CHANNELS.nativeAgentResetMemory]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListThreadSections]: nativeAgentThreadSectionList,
  [ELECTRON_IPC_CHANNELS.nativeAgentCreateThreadSection]: nativeAgentThreadSectionCreate,
  [ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSection]: nativeAgentThreadSectionUpdate,
  [ELECTRON_IPC_CHANNELS.nativeAgentDeleteThreadSection]: nativeAgentThreadSectionDelete,
  [ELECTRON_IPC_CHANNELS.nativeAgentMoveThreadToSection]: nativeAgentThreadSectionMove,
  [ELECTRON_IPC_CHANNELS.nativeAgentGetThreadGoal]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetThreadGoal]: nativeAgentThreadGoalSet,
  [ELECTRON_IPC_CHANNELS.nativeAgentClearThreadGoal]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListBackgroundTerminals]: nativeAgentBackgroundTerminalsPage,
  [ELECTRON_IPC_CHANNELS.nativeAgentTerminateBackgroundTerminal]: nativeAgentBackgroundTerminalReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentCleanBackgroundTerminals]: nativeAgentThreadReference,
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
  [ELECTRON_IPC_CHANNELS.nativeAgentDetectExternalConfig]: nativeAgentDetectExternalConfig,
  [ELECTRON_IPC_CHANNELS.nativeAgentImportExternalConfig]: nativeAgentImportExternalConfig,
  [ELECTRON_IPC_CHANNELS.nativeAgentListScheduledTasks]: nativeAgentListScheduledTasks,
  [ELECTRON_IPC_CHANNELS.nativeAgentCreateScheduledTask]: nativeAgentCreateScheduledTask,
  [ELECTRON_IPC_CHANNELS.nativeAgentSetScheduledTaskEnabled]: nativeAgentSetScheduledTaskEnabled,
  [ELECTRON_IPC_CHANNELS.nativeAgentRemoveScheduledTask]: nativeAgentScheduledTaskReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListHooks]: nativeAgentCatalogReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentListPlugins]: nativeAgentPluginCatalog,
  [ELECTRON_IPC_CHANNELS.nativeAgentListInstalledPlugins]: nativeAgentPluginCatalog,
  [ELECTRON_IPC_CHANNELS.nativeAgentReadPlugin]: nativeAgentPluginReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentAddMarketplace]: nativeAgentMarketplaceAdd,
  [ELECTRON_IPC_CHANNELS.nativeAgentAddBundledMarketplace]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentRemoveMarketplace]: nativeAgentMarketplaceReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentUpgradeMarketplace]: nativeAgentMarketplaceUpgrade,
  [ELECTRON_IPC_CHANNELS.nativeAgentInstallPlugin]: nativeAgentPluginReference,
  [ELECTRON_IPC_CHANNELS.nativeAgentUninstallPlugin]: nativeAgentPluginUninstall,
  [ELECTRON_IPC_CHANNELS.nativeAgentListCollaborationModes]: nativeAgentThreadReference,
  [ELECTRON_IPC_CHANNELS.computerUseConfigurationGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.computerUseConfigurationSet]: computerUseConfiguration,
  [ELECTRON_IPC_CHANNELS.chromeNativeMessagingGetStatus]: noPayload,
  [ELECTRON_IPC_CHANNELS.chromeNativeMessagingInstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.chromeNativeMessagingUninstall]: noPayload,
  [ELECTRON_IPC_CHANNELS.browserUsePolicyGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.browserUsePolicySet]: browserPolicyConfiguration,
  [ELECTRON_IPC_CHANNELS.chromeControlPolicyGet]: noPayload,
  [ELECTRON_IPC_CHANNELS.chromeControlPolicySet]: browserPolicyConfiguration,
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
  [ELECTRON_IPC_CHANNELS.imageCreateCreativePlan]: imageCreateCreativePlan,
  [ELECTRON_IPC_CHANNELS.imageEstimateGenerationRound]: imageEstimateGenerationRound,
  [ELECTRON_IPC_CHANNELS.imageEstimateDerivation]: imageEstimateDerivation,
  [ELECTRON_IPC_CHANNELS.imageCreateGenerationRound]: imageCreateGenerationRound,
  [ELECTRON_IPC_CHANNELS.imageDecideCandidate]: imageDecideCandidate,
  [ELECTRON_IPC_CHANNELS.imageAdoptCandidate]: imageAdoptCandidate,
  [ELECTRON_IPC_CHANNELS.imageDeriveCandidate]: imageDeriveCandidate,
  [ELECTRON_IPC_CHANNELS.imageCancelGenerationOperation]: imageCancelGenerationOperation,
  [ELECTRON_IPC_CHANNELS.imageUpdateReferenceControl]: imageUpdateReferenceControl,
  [ELECTRON_IPC_CHANNELS.imageCreateDeliverySpecRevision]: imageCreateDeliverySpecRevision,
  [ELECTRON_IPC_CHANNELS.imageCreateCanvas]: imageCreateCanvas,
  [ELECTRON_IPC_CHANNELS.imageApplyCanvasCommand]: imageApplyCanvasCommand,
  [ELECTRON_IPC_CHANNELS.imagePreflightCanvas]: imagePreflightCanvas,
  [ELECTRON_IPC_CHANNELS.imageRenderCanvas]: imageRenderCanvas,
  [ELECTRON_IPC_CHANNELS.imageExportDelivery]: imageExportDelivery,
  [ELECTRON_IPC_CHANNELS.imageRequestDestination]: imageRequestDestination,
  [ELECTRON_IPC_CHANNELS.imageSelectArtboardVersion]: imageSelectArtboardVersion,
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
