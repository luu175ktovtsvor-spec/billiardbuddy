export const CORE_OPERATION_BRIDGE_ERROR_CODES = [
  'CORE_OPERATION_INPUT_CONFLICT',
  'CORE_OPERATION_TERMINAL_FAILURE',
  'CORE_OPERATION_JOURNAL_INVALID',
  'CORE_OPERATION_BINDING_MISMATCH',
] as const

export type CoreOperationBridgeErrorCode =
  (typeof CORE_OPERATION_BRIDGE_ERROR_CODES)[number]

export type CoreOperationKind = 'create' | 'branch' | 'rename'
