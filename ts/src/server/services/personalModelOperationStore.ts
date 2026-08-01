import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { PersonalModelCapability, PersonalModelProfile } from '../../../shared/product/personalModels.js'
import {
  GatewayOperationResultError,
  SqliteGatewayOperationResultStore,
  type GatewayOperationResultBinding,
} from '../../../../gateway/operationResultStore.js'
import { getProductConfigDir } from '../product/productPaths.js'

export type PersonalModelOperationHandle = {
  binding: GatewayOperationResultBinding
  fencingToken: number
}

export type PersonalModelOperationStart =
  | { outcome: 'started'; handle: PersonalModelOperationHandle }
  | { outcome: 'succeeded'; payload: string; binding: GatewayOperationResultBinding }
  | { outcome: 'in_progress' }
  | { outcome: 'outcome_unknown' }

let operationStore: SqliteGatewayOperationResultStore | undefined

function store(): SqliteGatewayOperationResultStore {
  if (operationStore) return operationStore
  const directory = join(getProductConfigDir(), 'billiardbuddy', 'personal-model')
  const file = join(directory, 'operations.sqlite')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryStat = lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('PERSONAL_MODEL_OPERATION_RESULT_UNAVAILABLE')
  if (!existsSync(file)) closeSync(openSync(file, 'wx', 0o600))
  const fileStat = lstatSync(file)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('PERSONAL_MODEL_OPERATION_RESULT_UNAVAILABLE')
  operationStore = new SqliteGatewayOperationResultStore(file)
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    try { chmodSync(candidate, 0o600) } catch { /* Windows applies the current user ACL. */ }
  }
  return operationStore
}

function mappedStoreError(error: unknown): Error {
  if (!(error instanceof GatewayOperationResultError)) return error instanceof Error ? error : new Error('PERSONAL_MODEL_OPERATION_RESULT_UNAVAILABLE')
  return new Error(error.code === 'OPERATION_RESULT_CONFLICT'
    ? 'PERSONAL_MODEL_OPERATION_CONFLICT'
    : 'PERSONAL_MODEL_OPERATION_RESULT_UNAVAILABLE')
}

function binding(input: {
  capability: PersonalModelCapability
  operationId: string
  profile: Pick<PersonalModelProfile, 'id' | 'base_url' | 'model' | 'protocol' | 'auth_mode' | 'api_key'>
  requestBody: string
}): GatewayOperationResultBinding {
  const operationDigest = createHash('sha256')
    .update(input.capability).update('\0')
    .update(input.operationId)
    .digest('hex')
  const fingerprint = createHash('sha256')
    .update('bb.personal-model-operation.v1\0')
    .update(input.capability).update('\0')
    .update(input.profile.id).update('\0')
    .update(input.profile.protocol).update('\0')
    .update(input.profile.auth_mode).update('\0')
    .update(input.profile.base_url).update('\0')
    .update(input.profile.model).update('\0')
    .update(createHash('sha256').update(input.profile.api_key).digest()).update('\0')
    .update(input.requestBody)
    .digest('hex')
  return {
    principal_id: 'billiardbuddy-local-personal-model',
    installation_id: 'billiardbuddy-local-installation',
    operation_id: `personal:${operationDigest}`,
    capability: input.capability,
    fingerprint,
  }
}

export function beginPersonalModelOperation(input: {
  capability: PersonalModelCapability
  operationId: string
  profile: Pick<PersonalModelProfile, 'id' | 'base_url' | 'model' | 'protocol' | 'auth_mode' | 'api_key'>
  requestBody: string
  confirmUnknownRetry?: boolean
}): PersonalModelOperationStart {
  try {
    const operationBinding = binding(input)
    const result = store().begin(operationBinding, {
      confirmUnknownRetry: input.confirmUnknownRetry,
      awaitingConsumerAck: true,
    })
    if (result.outcome === 'started') {
      return { outcome: 'started', handle: { binding: operationBinding, fencingToken: result.fencing_token } }
    }
    return result.outcome === 'succeeded'
      ? { ...result, binding: operationBinding }
      : result
  } catch (error) {
    throw mappedStoreError(error)
  }
}

export function completePersonalModelOperation(
  handle: PersonalModelOperationHandle,
  payload: string,
  options?: { awaitingConsumerAck?: boolean },
): void {
  try { store().complete(handle.binding, handle.fencingToken, payload, options) } catch (error) { throw mappedStoreError(error) }
}

export function acknowledgePersonalModelOperation(binding: GatewayOperationResultBinding): boolean {
  try { return store().acknowledge(binding) === 'acknowledged' } catch (error) { throw mappedStoreError(error) }
}

export function releasePersonalModelOperation(handle: PersonalModelOperationHandle): void {
  try { store().release(handle.binding, handle.fencingToken) } catch (error) { throw mappedStoreError(error) }
}

export function markPersonalModelOperationOutcomeUnknown(handle: PersonalModelOperationHandle): void {
  try { store().markOutcomeUnknown(handle.binding, handle.fencingToken) } catch (error) { throw mappedStoreError(error) }
}

export function personalModelStatusHasDefiniteNoResult(status: number): boolean {
  return [400, 401, 402, 403, 404, 409, 413, 415, 422, 429].includes(status)
}
