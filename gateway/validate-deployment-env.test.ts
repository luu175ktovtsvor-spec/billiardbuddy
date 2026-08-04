import { expect, test } from 'bun:test'

import {
  GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES,
  validateDeploymentEnvironment,
} from './validate-deployment-env'

function productionGatewayEnvironment(): Record<string, string> {
  const capacity = Object.fromEntries(GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES.map(name => [name, '1']))
  const quotaCapabilities = ['TEXT_REASONING', 'VISUAL_EVIDENCE', 'MEDIA_REASONING', 'IMAGE_ADVICE', 'SPEECH_TRANSCRIPTION']
  const quotaScopes = ['PRINCIPAL', 'INSTALLATION']
  const quotaAxes = ['REQUESTS', 'INPUT_BYTES', 'OUTPUT_UNITS', 'TOTAL_TOKENS']
  const quota = Object.fromEntries(quotaCapabilities.flatMap(capability => quotaScopes.flatMap(scope => quotaAxes.map(axis => [
    `GW_QUOTA_${capability}_${scope}_${axis}`,
    '1000',
  ]))))
  return {
    ...capacity,
    ...quota,
    GW_QUOTA_POLICY_REVISION: 'gateway-quota-production-v1',
    GW_CAPACITY_POLICY_REVISION: 'gateway-production-v1',
    GW_BOOTSTRAP_RPM: '30', GW_BOOTSTRAP_QUEUE_MAX: '0', GW_BOOTSTRAP_QUEUE_MAX_WAIT: '0',
    GW_DEEPSEEK_RPM: '120', GW_DEEPSEEK_CONC: '8', GW_DEEPSEEK_USER_CONC: '2', GW_DEEPSEEK_TOKEN_CONC: '4', GW_DEEPSEEK_INFLIGHT_PER_USER: '4', GW_DEEPSEEK_QUEUE_MAX: '24', GW_DEEPSEEK_QUEUE_MAX_WAIT: '5', GW_DEEPSEEK_RESPONSE_TIMEOUT_MS: '120000',
    GW_MIMO_RPM: '60', GW_MIMO_CONC: '8', GW_MIMO_MEDIA_CONC: '5', GW_VISION_CONC: '3', GW_MIMO_USER_CONC: '1', GW_MIMO_TOKEN_CONC: '2', GW_MIMO_INFLIGHT_PER_USER: '1', GW_MIMO_QUEUE_MAX: '16', GW_MIMO_QUEUE_MAX_WAIT: '3', GW_VISION_QUEUE_MAX: '8', GW_VISION_QUEUE_MAX_WAIT_MS: '2000', GW_VISION_PER_CLIENT_CONC: '1', GW_VISION_MAX_INFLIGHT_PER_CLIENT: '1', GW_VISION_PER_REQUEST_CONC: '1', GW_VISION_TIMEOUT_MS: '30000',
    GW_QWEN_RPM: '60', GW_QWEN_CONC: '4', GW_QWEN_USER_CONC: '1', GW_QWEN_TOKEN_CONC: '2', GW_QWEN_INFLIGHT_PER_USER: '2', GW_QWEN_QUEUE_MAX: '12', GW_QWEN_QUEUE_MAX_WAIT: '3', GW_QWEN_RESPONSE_TIMEOUT_MS: '60000',
    GW_TRANSCRIBE_RPM: '6', GW_TRANSCRIBE_CONC: '1', GW_TRANSCRIBE_USER_CONC: '1', GW_TRANSCRIBE_TOKEN_CONC: '1', GW_TRANSCRIBE_INFLIGHT_PER_USER: '1', GW_TRANSCRIBE_QUEUE_MAX: '4', GW_QUEUE_MAX_WAIT: '15', GW_TRANSCRIBE_MAX_BYTES: String(64 * 1024 * 1024), GW_TRANSCRIBE_TIMEOUT_MS: '180000',
    GW_INGRESS_INFLIGHT_BODY_BYTES: String(64 * 1024 * 1024), GW_INGRESS_BODY_READ_TIMEOUT_MS: '30000', GW_SERVER_IDLE_TIMEOUT_SECONDS: '120',
    GW_AUTH_SIGNING_KEY: 'a'.repeat(32),
    GW_ADMIN_TOKEN: 'gateway-admin-token',
    GW_DB: '/data/usage.db',
    GW_DEEPSEEK_KEY: 'deepseek-key',
    GW_MIMO_KEY: 'mimo-key',
    GW_FUNASR_KEY: 'funasr-key',
    GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'i'.repeat(32),
    GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'v'.repeat(32),
  }
}

test('Gateway production preflight requires an explicit capacity envelope', () => {
  const environment = productionGatewayEnvironment()
  expect(() => validateDeploymentEnvironment(environment)).not.toThrow()
  expect(() => validateDeploymentEnvironment({ ...environment, GW_DEEPSEEK_RPM: '' }))
    .toThrow('GW_DEEPSEEK_RPM is required')
  expect(() => validateDeploymentEnvironment({ ...environment, GW_MIMO_MEDIA_CONC: '6' }))
    .toThrow('GW_MIMO_MEDIA_CONC + GW_VISION_CONC must equal GW_MIMO_CONC')
  expect(() => validateDeploymentEnvironment({ ...environment, GW_QUOTA_IMAGE_ADVICE_PRINCIPAL_REQUESTS: '' }))
    .toThrow('GW_QUOTA_IMAGE_ADVICE_PRINCIPAL_REQUESTS is required')
  const { GW_QUOTA_TEXT_REASONING_INSTALLATION_TOTAL_TOKENS: _namedDailyLimit, ...withDailyAlias } = environment
  expect(() => validateDeploymentEnvironment({ ...withDailyAlias, GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT: '1000' })).not.toThrow()
  expect(() => validateDeploymentEnvironment({ ...environment, GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT: '1000' }))
    .toThrow('GW_QUOTA_TEXT_REASONING_INSTALLATION_TOTAL_TOKENS and GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT cannot both be set')
})
