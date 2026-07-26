import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  SqliteUsageBudgetService,
  UsageBudgetError,
  type UsageBudgetPolicy,
  usageFingerprint,
} from './usageBudget'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function policy(): UsageBudgetPolicy {
  const limit = { requests: 2, input_bytes: 10, output_units: 10 }
  return {
    revision: 'test-v1', period: 'utc_day',
    capabilities: {
      TextReasoning: { principal: limit, installation: limit },
      VisualEvidence: { principal: limit, installation: limit },
      MediaReasoning: { principal: limit, installation: limit },
      SpeechTranscription: { principal: limit, installation: limit },
    },
  }
}

function input(operation: string, installation = 'install-a') {
  return {
    operation_id: operation,
    principal_id: 'principal-a',
    installation_id: installation,
    capability: 'TextReasoning' as const,
    fingerprint: usageFingerprint('same-input'),
    amount: { requests: 1, input_bytes: 4, output_units: 2 },
  }
}

test('usage budget binds duplicate operations and finalizes exactly once', () => {
  const service = new SqliteUsageBudgetService(':memory:', policy(), () => Date.UTC(2026, 6, 24))
  const first = service.reserve(input('operation-1'))
  expect(first.duplicate).toBe(false)
  expect(service.reserve(input('operation-1'))).toEqual({ duplicate: true, receipt: first.receipt })
  expect(() => service.reserve({ ...input('operation-1'), fingerprint: usageFingerprint('different') })).toThrow('OPERATION_CONFLICT')

  const settled = service.settle('operation-1', first.receipt.fencing_token, { requests: 1, input_bytes: 4, output_units: 1 }, usageFingerprint('provider-receipt'))
  expect(settled).toMatchObject({ state: 'settled', actual: { requests: 1, input_bytes: 4, output_units: 1 } })
  expect(service.release('operation-1', first.receipt.fencing_token)).toEqual(settled)
  expect(() => service.release('operation-1', first.receipt.fencing_token + 1)).toThrow('STALE_FENCING')
})

test('usage summary is scoped to the verified principal and installation and includes the UTC reset', () => {
  const service = new SqliteUsageBudgetService(':memory:', policy(), () => Date.UTC(2026, 6, 24, 12))
  const first = service.reserve(input('operation-1'))
  service.settle('operation-1', first.receipt.fencing_token, first.receipt.reserved)

  expect(service.summary('principal-a', 'install-a')).toEqual({
    period: '2026-07-24',
    resets_at: '2026-07-25T00:00:00.000Z',
    capabilities: {
      TextReasoning: { remaining_percent: 50, exhausted: false },
      VisualEvidence: { remaining_percent: 100, exhausted: false },
      MediaReasoning: { remaining_percent: 100, exhausted: false },
      SpeechTranscription: { remaining_percent: 100, exhausted: false },
    },
  })
  expect(service.summary('principal-a', 'install-b').capabilities.TextReasoning.remaining_percent).toBe(50)
  expect(service.summary('principal-b', 'install-b').capabilities.TextReasoning.remaining_percent).toBe(100)
})

test('a zero policy limit is exhausted instead of reporting full availability', () => {
  const zero = policy()
  zero.capabilities.TextReasoning.principal = { requests: 0, input_bytes: 0, output_units: 0 }
  const service = new SqliteUsageBudgetService(':memory:', zero, () => Date.UTC(2026, 6, 24, 12))

  expect(service.summary('principal-a', 'install-a').capabilities.TextReasoning).toEqual({
    remaining_percent: 0,
    exhausted: true,
  })
})

test('principal budget cannot be bypassed by changing installation', () => {
  const service = new SqliteUsageBudgetService(':memory:', policy())
  const first = service.reserve(input('operation-1', 'install-a'))
  service.markOutcomeUnknown('operation-1', first.receipt.fencing_token)
  const second = service.reserve(input('operation-2', 'install-b'))
  service.settle('operation-2', second.receipt.fencing_token, second.receipt.reserved)
  expect(() => service.reserve(input('operation-3', 'install-c'))).toThrow(new UsageBudgetError(429, 'USAGE_LIMIT_REACHED'))
})

test('the same client operation id is isolated between principals', () => {
  const service = new SqliteUsageBudgetService(':memory:', policy())
  const first = service.reserve(input('operation-1'))
  const second = service.reserve({ ...input('operation-1'), principal_id: 'principal-b', installation_id: 'install-b' })
  expect(first.duplicate).toBe(false)
  expect(second.duplicate).toBe(false)
  expect(second.receipt.fencing_token).not.toBe(first.receipt.fencing_token)
})

test('installation budgets are scoped by verified principal and installation together', () => {
  const isolated = policy()
  isolated.capabilities.TextReasoning.principal = { requests: 4, input_bytes: 20, output_units: 20 }
  isolated.capabilities.TextReasoning.installation = { requests: 1, input_bytes: 10, output_units: 10 }
  const service = new SqliteUsageBudgetService(':memory:', isolated)
  const first = service.reserve(input('operation-1', 'shared-installation'))
  service.settle('operation-1', first.receipt.fencing_token, first.receipt.reserved)
  expect(() => service.reserve(input('operation-2', 'shared-installation'))).toThrow('USAGE_LIMIT_REACHED')
  expect(service.reserve({
    ...input('operation-2', 'shared-installation'),
    principal_id: 'principal-b',
  }).duplicate).toBe(false)
})

test('released reservations restore budget while unknown outcomes retain it', () => {
  const service = new SqliteUsageBudgetService(':memory:', policy())
  const first = service.reserve(input('operation-1'))
  service.release('operation-1', first.receipt.fencing_token)
  const second = service.reserve(input('operation-2'))
  service.markOutcomeUnknown('operation-2', second.receipt.fencing_token)
  const third = service.reserve(input('operation-3'))
  service.settle('operation-3', third.receipt.fencing_token, third.receipt.reserved)
  expect(() => service.reserve(input('operation-4'))).toThrow('USAGE_LIMIT_REACHED')
})

test('sqlite reservations are durable and serialized across service instances', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-usage-budget-'))
  roots.push(root)
  const path = join(root, 'usage.sqlite')
  const left = new SqliteUsageBudgetService(path, policy())
  const right = new SqliteUsageBudgetService(path, policy())
  const first = left.reserve(input('operation-1'))
  expect(right.reserve(input('operation-1'))).toEqual({ duplicate: true, receipt: first.receipt })
  right.markOutcomeUnknown('operation-1', first.receipt.fencing_token)
  const second = left.reserve(input('operation-2', 'install-b'))
  left.settle('operation-2', second.receipt.fencing_token, second.receipt.reserved)
  expect(() => right.reserve(input('operation-3', 'install-c'))).toThrow('USAGE_LIMIT_REACHED')
})
