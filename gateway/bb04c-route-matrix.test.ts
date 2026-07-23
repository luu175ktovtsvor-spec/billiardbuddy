import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'
import { gatewayTestAccessToken, gatewayTestAuthority } from './auth/testFixture'

test('BB-04C rejects Qwen, MiMo, unknown and case-mismatched model IDs before upstream work', async () => {
  const calls: string[] = []
  const fetch = createGatewayFetch({
    authority: gatewayTestAuthority,
    env: { GW_RELAY_TOKEN: 'relay', GW_DEEPSEEK_KEY: 'key', GW_DEEPSEEK_BASE: 'https://deepseek.example' },
    usageStore: new MemoryUsageStore(), transcribeImpl: null,
    fetchImpl: async input => { calls.push(String(input)); return new Response('unexpected') },
  })
  for (const model of ['qwen3-coder-plus', 'mimo-v2.5', 'unknown', 'DEEPSEEK-V4-FLASH']) {
    const response = await fetch(new Request('http://local/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${gatewayTestAccessToken}`, 'Content-Type': 'application/json', 'X-BB-Data-Egress-Consent': 'a'.repeat(64), 'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0' }, body: JSON.stringify({ model, messages: [] }) }))
    expect(response.status).toBe(400)
  }
  expect(calls).toEqual([])
})
