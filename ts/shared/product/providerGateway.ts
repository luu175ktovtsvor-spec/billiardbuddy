export const PROVIDER_GATEWAY_PROTOCOL = {
  name: 'bb-provider-gateway',
  major: 1,
  minor: 0,
  headerValue: 'bb-provider-gateway/1.0',
} as const

export const PROVIDER_GATEWAY_PROTOCOL_HEADER = 'X-BB-Provider-Protocol'
export const PROVIDER_OPERATION_ID_HEADER = 'X-BB-Operation-ID'
export const PROVIDER_OPERATION_CONFIRM_UNKNOWN_RETRY_HEADER = 'X-BB-Confirm-Unknown-Retry'
export const PROVIDER_OPERATION_RESULT_ID_HEADER = 'X-BB-Result-Operation'
export const PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER = 'X-BB-Result-Capability'
export const PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER = 'X-BB-Result-Fingerprint'
export const PROVIDER_OPERATION_ACK_PATH = '/v1/operations/ack'
export const MEDIA_RESULT_HANDOFF_HEADER = 'X-BB-Media-Result-Handoff'
export const MEDIA_RESULT_HANDOFF_DIRECT_V1 = 'direct-v1'
export const GATEWAY_ACCESS_TOKEN_CAPABILITY_HEADER = 'X-BB-Gateway-Access-Token-Capability'
export const GATEWAY_ACCESS_TOKEN_UPDATE_PATH = '/internal/gateway-access-token'
