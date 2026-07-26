import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProductMcpHeaders } from './productMcpHeaders.js'

const roots: string[] = []
const originalSecret = process.env.BILLIARDBUDDY_TEST_HOST_SECRET

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalSecret === undefined) delete process.env.BILLIARDBUDDY_TEST_HOST_SECRET
  else process.env.BILLIARDBUDDY_TEST_HOST_SECRET = originalSecret
})

function helper(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bb-mcp-headers-')); roots.push(root)
  const file = join(root, 'headers.sh')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o700)
  return file
}

describe('Product MCP headers helper', () => {
  test('uses bounded JSON output and lets fresh helper credentials replace static values', async () => {
    const file = helper(`printf '%s' '{"Authorization":"Bearer fresh","X-Nonce":"one"}'`)
    expect(await resolveProductMcpHeaders({ Authorization: 'Bearer stale', Accept: 'application/json' }, file)).toEqual({
      Authorization: 'Bearer fresh',
      Accept: 'application/json',
      'X-Nonce': 'one',
    })
  })

  test('does not delegate Host credential environment variables to the helper', async () => {
    process.env.BILLIARDBUDDY_TEST_HOST_SECRET = 'must-not-cross-boundary'
    const file = helper(`if [ -n "$BILLIARDBUDDY_TEST_HOST_SECRET" ]; then exit 9; fi\nprintf '%s' '{}'`)
    await expect(resolveProductMcpHeaders(undefined, file)).resolves.toEqual({})
  })

  test('rejects malformed or newline-bearing header output', async () => {
    const file = helper(`printf '%s' '{"Authorization":"bad\\nvalue"}'`)
    await expect(resolveProductMcpHeaders(undefined, file)).rejects.toThrow('MCP_HEADERS_HELPER_OUTPUT_INVALID')
  })
})
