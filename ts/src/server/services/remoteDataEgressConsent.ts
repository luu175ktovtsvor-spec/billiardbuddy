import { createHash } from 'node:crypto'
import {
  REMOTE_DATA_EGRESS_CAPABILITIES,
  REMOTE_DATA_EGRESS_POLICY_REVISION,
  type RemoteDataEgressReceipt,
  type RemoteDataEgressStatus,
} from '../../../shared/product/dataEgress.js'
import { SettingsService } from './settingsService.js'

const SETTINGS_KEY = 'billiardBuddyRemoteDataEgressConsent'

type ConsentState = {
  schema_version: 1
  receipts: RemoteDataEgressReceipt[]
}

const DISCLOSURE: RemoteDataEgressStatus['disclosure'] = {
  purpose: '完成文字任务、读取任务中的图片，以及把录音转成文字',
  data: ['任务文字和必要上下文', '用户附加的图片（仅在任务包含图片时）', '用户主动录制的音频（仅在使用语音输入时）'],
  receivers: [
    {
      capability: 'TextReasoning',
      provider: 'DeepSeek',
      region: '中国大陆',
      retention: '按其隐私政策为实现处理目的所需的最短期间保存；依法留存的网络日志可能至少六个月，当前账号的 API 专属期限未核验',
    },
    {
      capability: 'VisualEvidence',
      provider: 'Xiaomi MiMo',
      region: '中国大陆服务端点（当前网关配置）',
      retention: '按小米公开隐私政策在实现处理目的或满足法律要求所需期间保存；当前 MiMo API 账号的专属期限未核验',
    },
    {
      capability: 'SpeechTranscription',
      provider: 'Alibaba Cloud Model Studio Fun-ASR',
      region: '北京服务端点（当前网关配置）',
      retention: '阿里云公开说明会依法及按服务协议保存模型调用数据；当前账号的精确期限未核验',
    },
  ],
  billable: true,
  revocable: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function receiptId(installationId: string, grantedAt: string): string {
  return createHash('sha256').update([
    REMOTE_DATA_EGRESS_POLICY_REVISION,
    installationId,
    grantedAt,
    ...REMOTE_DATA_EGRESS_CAPABILITIES,
  ].join('\0')).digest('hex')
}

function validReceipt(value: unknown, installationId: string): value is RemoteDataEgressReceipt {
  if (!isRecord(value)) return false
  if (value.policy_revision !== REMOTE_DATA_EGRESS_POLICY_REVISION) return false
  if (value.purpose !== 'managed_ai_tasks' || value.billable !== true) return false
  if (typeof value.granted_at !== 'string' || Number.isNaN(Date.parse(value.granted_at))) return false
  if (value.revoked_at !== null && (typeof value.revoked_at !== 'string' || Number.isNaN(Date.parse(value.revoked_at)))) return false
  if (!Array.isArray(value.capabilities) || value.capabilities.join('\0') !== REMOTE_DATA_EGRESS_CAPABILITIES.join('\0')) return false
  return typeof value.receipt_id === 'string'
    && value.receipt_id === receiptId(installationId, value.granted_at)
}

function consentState(value: unknown, installationId: string): ConsentState {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.receipts)) {
    return { schema_version: 1, receipts: [] }
  }
  return {
    schema_version: 1,
    receipts: value.receipts.filter(receipt => validReceipt(receipt, installationId)),
  }
}

export class RemoteDataEgressConsentService {
  constructor(
    private readonly settings: Pick<SettingsService, 'getUserSettings' | 'mutateUserSettings'> = new SettingsService(),
    private readonly installationId = (process.env.BB_INSTALLATION_ID ?? '').trim(),
    private readonly now = () => new Date(),
  ) {}

  private async state(): Promise<ConsentState> {
    const settings = await this.settings.getUserSettings()
    return consentState(settings[SETTINGS_KEY], this.installationId)
  }

  async activeReceipt(): Promise<RemoteDataEgressReceipt | null> {
    if (!this.installationId) return null
    const state = await this.state()
    return [...state.receipts].reverse().find(receipt => receipt.revoked_at === null) ?? null
  }

  async status(): Promise<RemoteDataEgressStatus> {
    const receipt = await this.activeReceipt()
    return {
      available: Boolean(this.installationId),
      active: receipt !== null,
      policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
      receipt,
      disclosure: DISCLOSURE,
    }
  }

  async grant(input: { policy_revision: unknown; acknowledged: unknown }): Promise<RemoteDataEgressStatus> {
    if (!this.installationId) throw new Error('INSTALLATION_IDENTITY_UNAVAILABLE')
    if (input.policy_revision !== REMOTE_DATA_EGRESS_POLICY_REVISION || input.acknowledged !== true) {
      throw new Error('CONSENT_ACKNOWLEDGEMENT_INVALID')
    }
    const grantedAt = this.now().toISOString()
    const receipt: RemoteDataEgressReceipt = {
      receipt_id: receiptId(this.installationId, grantedAt),
      policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
      capabilities: [...REMOTE_DATA_EGRESS_CAPABILITIES],
      purpose: 'managed_ai_tasks',
      billable: true,
      granted_at: grantedAt,
      revoked_at: null,
    }
    await this.settings.mutateUserSettings(current => {
      const state = consentState(current[SETTINGS_KEY], this.installationId)
      const active = state.receipts.find(item => item.revoked_at === null)
      if (active) return current
      return { ...current, [SETTINGS_KEY]: { ...state, receipts: [...state.receipts, receipt] } }
    })
    return this.status()
  }

  async revoke(): Promise<RemoteDataEgressStatus> {
    if (!this.installationId) return this.status()
    const revokedAt = this.now().toISOString()
    await this.settings.mutateUserSettings(current => {
      const state = consentState(current[SETTINGS_KEY], this.installationId)
      return {
        ...current,
        [SETTINGS_KEY]: {
          ...state,
          receipts: state.receipts.map(receipt => receipt.revoked_at === null
            ? { ...receipt, revoked_at: revokedAt }
            : receipt),
        },
      }
    })
    return this.status()
  }
}

export const remoteDataEgressConsentService = new RemoteDataEgressConsentService()
