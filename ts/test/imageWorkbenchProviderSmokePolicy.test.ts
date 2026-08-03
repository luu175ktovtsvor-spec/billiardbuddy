import { expect, test } from 'bun:test'
import { providerSmokeCancelAction } from './imageWorkbenchProviderSmokePolicy.js'

test('Provider smoke 仅尝试取消最后已知为 queued 的任务', () => {
  expect(providerSmokeCancelAction('queued')).toBe('attempt_cancel')
  expect(providerSmokeCancelAction('running')).toBe('do_not_cancel')
  expect(providerSmokeCancelAction('succeeded')).toBe('do_not_cancel')
  expect(providerSmokeCancelAction('failed')).toBe('do_not_cancel')
  expect(providerSmokeCancelAction('cancelled')).toBe('do_not_cancel')
  expect(providerSmokeCancelAction(undefined)).toBe('do_not_cancel')
})
