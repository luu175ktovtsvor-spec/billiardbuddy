export const BROWSER_CAPABILITY_PROTOCOL_VERSION = 1 as const

export const RECRUITING_ACTION_KINDS = [
  'send_message',
  'invite',
  'reject',
] as const

export type RecruitingActionKind = (typeof RECRUITING_ACTION_KINDS)[number]

export type BrowserCandidateEvidence = {
  candidate_ref: string
  headline?: string
  experience_summary?: string
  skills: string[]
}

export type BrowserPageSnapshot = {
  session_id: string
  page_revision: string
  url: string
  title: string
  captured_at: string
  candidates: BrowserCandidateEvidence[]
}

export type RecruitingActionState =
  | 'awaiting_confirmation'
  | 'approved_waiting'
  | 'dispatching'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'rejected'
  | 'expired'

export type PublicRecruitingAction = {
  id: string
  task_id: string
  revision: number
  session_id: string
  page_revision: string
  kind: RecruitingActionKind
  candidate_ref: string
  target_label: string
  message?: string
  state: RecruitingActionState
  created_at: string
  updated_at: string
  failure_code?: string
}

export type BrowserCapabilityStatus = {
  state: 'not_configured' | 'waiting_for_extension' | 'connected' | 'degraded'
  connected_sessions: number
  last_seen_at?: string
  reason?: 'BRIDGE_NOT_CONFIGURED' | 'EXTENSION_NOT_CONNECTED' | 'BRIDGE_DESCRIPTOR_FAILED'
}

export type RecruitingBrowserSetupStatus = BrowserCapabilityStatus & {
  native_host_installed: boolean
  extension_available: boolean
  extension_path: string
}

export type NativeBrowserCommand = {
  command_id: string
  operation_id: string
  session_id: string
  page_revision: string
  action: RecruitingActionKind
  candidate_ref: string
  message?: string
}

export type NativeBrowserActionResult = {
  operation_id: string
  command_id: string
  outcome: 'succeeded' | 'failed' | 'outcome_unknown'
  failure_code?: string
}
