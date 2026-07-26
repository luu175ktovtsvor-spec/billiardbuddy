import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mapLegacyQwenModelValue } from './qwenLegacyModelMapper'

test('legacy Qwen values map without retaining a runtime route', () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/provider-legacy-qwen-model-values-v1.json'), 'utf8')) as {
    values: Array<{ legacy_model: string; result: string | null }>
  }
  for (const entry of fixture.values) {
    expect(mapLegacyQwenModelValue(entry.legacy_model)).toBe(entry.result ?? undefined)
  }
  expect(mapLegacyQwenModelValue(' qwen3-coder-plus ')).toBe('deepseek-v4-flash')
  expect(mapLegacyQwenModelValue(undefined)).toBeUndefined()

  const gatewayApp = readFileSync(resolve(import.meta.dir, 'app.ts'), 'utf8')
  expect(gatewayApp).not.toContain("from './qwenChat'")
  expect(gatewayApp).not.toContain('GW_QWEN_')
})
