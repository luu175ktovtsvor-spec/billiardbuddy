import type {
  CodexNativeJsonObject,
  CodexNativeJsonValue,
  CodexNativeServerRequest,
} from './codexNativeAppServer'

/**
 * Server requests that BilliardBuddy can present to a user without creating a
 * second Agent, Tool Router, or permission model in TypeScript. Rust remains
 * the authority for the request schema and the resulting Agent state.
 */
export type NativeInteractiveServerRequestMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/tool/requestUserInput'
  | 'mcpServer/elicitation/request'
  | 'item/permissions/requestApproval'

type JsonRecord = Record<string, unknown>

const MAX_SERVER_REQUEST_RESPONSE_BYTES = 512 * 1024
const MAX_USER_INPUT_ANSWERS = 64
const MAX_USER_INPUT_ANSWER_LENGTH = 16 * 1024

function protocolError(code: string): never {
  throw new Error(code)
}

function record(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as JsonRecord : undefined
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function isNativeJson(value: unknown, depth = 0): value is CodexNativeJsonValue {
  if (depth > 16 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 16
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => isNativeJson(item, depth + 1))
  const object = record(value)
  if (!object) return false
  const entries = Object.entries(object)
  return entries.length <= 256
    && entries.every(([key, item]) => (
      key.length > 0
      && key.length <= 256
      && key !== '__proto__'
      && key !== 'constructor'
      && key !== 'prototype'
      && isNativeJson(item, depth + 1)
    ))
}

function boundedNativeJsonObject(value: unknown): CodexNativeJsonObject {
  const object = record(value)
  if (!object || !isNativeJson(object) || Buffer.byteLength(JSON.stringify(object)) > MAX_SERVER_REQUEST_RESPONSE_BYTES) {
    return protocolError('CODEX_NATIVE_SERVER_REQUEST_RESPONSE_INVALID')
  }
  return object as CodexNativeJsonObject
}

function nativeText(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000\r\n]/.test(value)
}

function userAnswerText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_USER_INPUT_ANSWER_LENGTH && !value.includes('\u0000')
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]))
  }
  const leftObject = record(left)
  const rightObject = record(right)
  if (!leftObject || !rightObject) return false
  const leftKeys = Object.keys(leftObject).sort()
  const rightKeys = Object.keys(rightObject).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(leftObject[key], rightObject[key]))
}

function nativeInteractiveServerRequestMethod(value: string): NativeInteractiveServerRequestMethod | undefined {
  switch (value) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/tool/requestUserInput':
    case 'mcpServer/elicitation/request':
    case 'item/permissions/requestApproval':
      return value
    default:
      return undefined
  }
}

export function nativeServerRequestKey(id: CodexNativeServerRequest['id']): string {
  return `${typeof id}:${id}`
}

export function nativeInteractiveServerRequest(value: string): NativeInteractiveServerRequestMethod | undefined {
  return nativeInteractiveServerRequestMethod(value)
}

/**
 * BilliardBuddy never registers App Server dynamic tools: image/video stay
 * product services rather than becoming a second TypeScript Tool Router.
 * If an unexpected dynamic call reaches this boundary, return the source
 * failure shape instead of executing unregistered renderer code.
 */
export function unsupportedNativeServerRequestFallback(
  request: Pick<CodexNativeServerRequest, 'method'>,
): CodexNativeJsonObject | undefined {
  return request.method === 'item/tool/call'
    ? { contentItems: [], success: false }
    : undefined
}

function commandDecisionIsAllowed(params: JsonRecord, decision: unknown): boolean {
  const available = params.availableDecisions
  if (Array.isArray(available) && available.length > 0) {
    return available.some(candidate => isNativeJson(candidate) && jsonEqual(candidate, decision))
  }
  // Older source requests omit `availableDecisions`. These choices are the
  // stable non-persistent subset; policy amendments must be source-offered.
  return decision === 'accept'
    || decision === 'acceptForSession'
    || decision === 'decline'
    || decision === 'cancel'
}

function commandApprovalResponse(params: JsonRecord, response: JsonRecord): CodexNativeJsonObject {
  if (!hasOnlyKeys(response, ['decision']) || !hasOwn(response, 'decision') || !commandDecisionIsAllowed(params, response.decision)) {
    return protocolError('CODEX_NATIVE_COMMAND_APPROVAL_RESPONSE_INVALID')
  }
  return { decision: response.decision as CodexNativeJsonValue }
}

function fileApprovalResponse(response: JsonRecord): CodexNativeJsonObject {
  const decision = response.decision
  if (
    !hasOnlyKeys(response, ['decision'])
    || (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline' && decision !== 'cancel')
  ) {
    return protocolError('CODEX_NATIVE_FILE_APPROVAL_RESPONSE_INVALID')
  }
  return { decision }
}

function userInputResponse(params: JsonRecord, response: JsonRecord): CodexNativeJsonObject {
  if (!hasOnlyKeys(response, ['answers']) || !hasOwn(response, 'answers')) {
    return protocolError('CODEX_NATIVE_USER_INPUT_RESPONSE_INVALID')
  }
  const sourceQuestions = Array.isArray(params.questions) ? params.questions : []
  const questionIds = new Set<string>()
  for (const question of sourceQuestions) {
    const sourceQuestion = record(question)
    if (!sourceQuestion || !nativeText(sourceQuestion.id)) return protocolError('CODEX_NATIVE_USER_INPUT_REQUEST_INVALID')
    questionIds.add(sourceQuestion.id)
  }
  const answers = record(response.answers)
  if (!answers || Object.keys(answers).length > questionIds.size) {
    return protocolError('CODEX_NATIVE_USER_INPUT_RESPONSE_INVALID')
  }
  for (const [questionId, answer] of Object.entries(answers)) {
    const answerObject = record(answer)
    const values = answerObject?.answers
    if (
      !questionIds.has(questionId)
      || !answerObject
      || !hasOnlyKeys(answerObject, ['answers'])
      || !Array.isArray(values)
      || values.length > MAX_USER_INPUT_ANSWERS
      || !values.every(userAnswerText)
    ) {
      return protocolError('CODEX_NATIVE_USER_INPUT_RESPONSE_INVALID')
    }
  }
  return { answers: answers as CodexNativeJsonObject }
}

function requestedPathSubset(value: unknown, requested: unknown): boolean {
  if (value === null) return true
  if (!Array.isArray(value) || !value.every(path => nativeText(path, 4_096))) return false
  const requestedPaths = Array.isArray(requested) ? requested.filter((path): path is string => typeof path === 'string') : []
  return value.every(path => requestedPaths.includes(path))
}

function requestedEntrySubset(value: unknown, requested: unknown): boolean {
  if (!Array.isArray(value) || !Array.isArray(requested) || !value.every(isNativeJson)) return false
  return value.every(entry => requested.some(candidate => jsonEqual(candidate, entry)))
}

function grantedNetworkIsSubset(requested: JsonRecord, granted: unknown): boolean {
  const requestedNetwork = record(requested.network)
  const grantedNetwork = record(granted)
  if (!requestedNetwork || !grantedNetwork || !hasOnlyKeys(grantedNetwork, ['enabled']) || !hasOwn(grantedNetwork, 'enabled')) {
    return false
  }
  const enabled = grantedNetwork.enabled
  if (enabled !== true && enabled !== false && enabled !== null) return false
  return enabled !== true || requestedNetwork.enabled === true
}

function grantedFileSystemIsSubset(requested: JsonRecord, granted: unknown): boolean {
  const requestedFileSystem = record(requested.fileSystem)
  const grantedFileSystem = record(granted)
  if (!requestedFileSystem || !grantedFileSystem || !hasOnlyKeys(grantedFileSystem, ['read', 'write', 'globScanMaxDepth', 'entries'])) {
    return false
  }
  if (hasOwn(grantedFileSystem, 'read') && !requestedPathSubset(grantedFileSystem.read, requestedFileSystem.read)) return false
  if (hasOwn(grantedFileSystem, 'write') && !requestedPathSubset(grantedFileSystem.write, requestedFileSystem.write)) return false
  if (hasOwn(grantedFileSystem, 'entries') && !requestedEntrySubset(grantedFileSystem.entries, requestedFileSystem.entries)) return false
  if (hasOwn(grantedFileSystem, 'globScanMaxDepth')) {
    const grantedDepth = grantedFileSystem.globScanMaxDepth
    const requestedDepth = requestedFileSystem.globScanMaxDepth
    if (
      typeof grantedDepth !== 'number'
      || !Number.isSafeInteger(grantedDepth)
      || grantedDepth < 0
      || typeof requestedDepth !== 'number'
      || !Number.isSafeInteger(requestedDepth)
      || grantedDepth > requestedDepth
    ) return false
  }
  return true
}

function permissionsApprovalResponse(params: JsonRecord, response: JsonRecord): CodexNativeJsonObject {
  if (!hasOnlyKeys(response, ['permissions', 'scope', 'strictAutoReview']) || !hasOwn(response, 'permissions')) {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  const requested = record(params.permissions)
  const granted = record(response.permissions)
  if (!requested || !granted || !hasOnlyKeys(granted, ['network', 'fileSystem'])) {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  if (hasOwn(granted, 'network') && !grantedNetworkIsSubset(requested, granted.network)) {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  if (hasOwn(granted, 'fileSystem') && !grantedFileSystemIsSubset(requested, granted.fileSystem)) {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  if (response.scope !== undefined && response.scope !== 'turn' && response.scope !== 'session') {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  if (response.strictAutoReview !== undefined && typeof response.strictAutoReview !== 'boolean') {
    return protocolError('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  }
  return {
    permissions: granted as CodexNativeJsonObject,
    ...(response.scope === undefined ? {} : { scope: response.scope }),
    ...(response.strictAutoReview === undefined ? {} : { strictAutoReview: response.strictAutoReview }),
  }
}

function mcpElicitationResponse(response: JsonRecord): CodexNativeJsonObject {
  if (
    !hasOnlyKeys(response, ['action', 'content', '_meta'])
    || (response.action !== 'accept' && response.action !== 'decline' && response.action !== 'cancel')
    || !hasOwn(response, 'content')
    || !hasOwn(response, '_meta')
    || !isNativeJson(response.content)
    || !isNativeJson(response._meta)
    || (response.action !== 'accept' && response.content !== null)
  ) {
    return protocolError('CODEX_NATIVE_MCP_ELICITATION_RESPONSE_INVALID')
  }
  return {
    action: response.action,
    content: response.content as CodexNativeJsonValue,
    _meta: response._meta as CodexNativeJsonValue,
  }
}

/**
 * Validate a renderer response against the exact source request that spawned
 * it. This is a protocol boundary only: it cannot create permissions, tools,
 * or agent state which Rust did not offer in the original request.
 */
export function validateNativeServerRequestResponse(
  method: NativeInteractiveServerRequestMethod,
  requestParams: CodexNativeJsonObject,
  response: unknown,
): CodexNativeJsonObject {
  const safeResponse = boundedNativeJsonObject(response)
  const sourceParams = record(requestParams)
  if (!sourceParams) return protocolError('CODEX_NATIVE_SERVER_REQUEST_INVALID')
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return commandApprovalResponse(sourceParams, safeResponse)
    case 'item/fileChange/requestApproval':
      return fileApprovalResponse(safeResponse)
    case 'item/tool/requestUserInput':
      return userInputResponse(sourceParams, safeResponse)
    case 'mcpServer/elicitation/request':
      return mcpElicitationResponse(safeResponse)
    case 'item/permissions/requestApproval':
      return permissionsApprovalResponse(sourceParams, safeResponse)
  }
}
