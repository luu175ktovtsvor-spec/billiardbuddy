export const REMOTE_DATA_EGRESS_POLICY_REVISION = 'bb-04f-managed-remote-v1'

export const REMOTE_DATA_EGRESS_CAPABILITIES = [
  'TextReasoning',
  'VisualEvidence',
  'SpeechTranscription',
] as const

export type RemoteDataEgressCapability = (typeof REMOTE_DATA_EGRESS_CAPABILITIES)[number]

export const PROVIDER_GATEWAY_PROTOCOL = {
  name: 'bb-provider-gateway',
  major: 1,
  minor: 0,
  headerValue: 'bb-provider-gateway/1.0',
} as const

export const PROVIDER_GATEWAY_PROTOCOL_HEADER = 'X-BB-Provider-Protocol'
export const DATA_EGRESS_CONSENT_HEADER = 'X-BB-Data-Egress-Consent'

export type RemoteDataEgressReceipt = {
  receipt_id: string
  policy_revision: typeof REMOTE_DATA_EGRESS_POLICY_REVISION
  capabilities: RemoteDataEgressCapability[]
  purpose: 'managed_ai_tasks'
  billable: true
  granted_at: string
  revoked_at: string | null
}

export type RemoteDataEgressStatus = {
  available: boolean
  active: boolean
  policy_revision: typeof REMOTE_DATA_EGRESS_POLICY_REVISION
  receipt: RemoteDataEgressReceipt | null
  disclosure: {
    purpose: string
    data: string[]
    receivers: Array<{
      capability: RemoteDataEgressCapability
      provider: string
      region: string
      retention: string
    }>
    billable: true
    revocable: true
  }
}
