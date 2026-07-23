export const PRODUCT_TASK_AUTHORITY_VERSION = 1 as const

export const PRODUCT_TASK_AUTHORITY_ERROR_CODES = [
  'AUTHORITY_INVALID',
  'AUTHORITY_CONFLICT',
  'LEGACY_SOURCE_CHANGED',
  'OPERATION_REJECTED',
  'UNSUPPORTED_SCHEMA',
  'WORKSPACE_REQUIRED',
  'WORKSPACE_RELINK_REQUIRED',
  'ATTACHMENT_INGEST_UNAVAILABLE',
  'OPERATION_INPUT_CONFLICT',
] as const
export type ProductTaskAuthorityErrorCode = (typeof PRODUCT_TASK_AUTHORITY_ERROR_CODES)[number]

export type ProductTaskOperationEnvelope = {
  expected_revision: number
  client_operation_id: string
}

export type ProductTaskOperationOutcome = 'accepted' | 'duplicate' | 'conflict' | 'rejected'

export type ProductTaskOperationReceipt<T = unknown> = {
  client_operation_id: string
  expected_revision: number
  outcome: ProductTaskOperationOutcome
  revision: number
  result?: T
  error?: ProductTaskAuthorityErrorCode
}

export type ProductTaskAuthoritySnapshot<T = unknown, S = unknown> = {
  revision: number
  event_sequence: number
  tasks: T[]
  side_tasks: S[]
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype'])

export function assertAuthorityMapKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !key || forbidden.has(key)) {
    throw new Error('AUTHORITY_INVALID')
  }
}

export function assertOperationEnvelope(value: unknown): asserts value is ProductTaskOperationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTHORITY_INVALID')
  const envelope = value as Record<string, unknown>
  if (!Number.isSafeInteger(envelope.expected_revision) || (envelope.expected_revision as number) < 0) {
    throw new Error('AUTHORITY_INVALID')
  }
  if (typeof envelope.client_operation_id !== 'string' || !envelope.client_operation_id.trim() || forbidden.has(envelope.client_operation_id)) {
    throw new Error('AUTHORITY_INVALID')
  }
}
