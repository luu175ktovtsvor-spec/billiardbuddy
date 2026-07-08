import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendToUdsSocket } from './udsClient'
import { startUdsInbox } from './udsInbox'
import { UdsPeerRegistry } from './udsPeerRegistry'

async function waitFor<T>(fn: () => T | null, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('UdsPeerRegistry registers live sockets and prunes closed peers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-peer-registry-'))
  const inbox: string[] = []
  const registry = new UdsPeerRegistry(root)
  const socketPath = join(root, 'peer.sock')
  const server = await startUdsInbox({ socketPath, inbox })
  try {
    const record = await registry.register({
      socketPath,
      conversationId: 'c-uds-peer',
      workspaceRoot: root,
      explicit: true,
      source: 'test',
    })
    expect(record.target).toBe(`uds:${socketPath}`)

    const peers = await registry.list()
    expect(peers).toEqual([expect.objectContaining({
      id: record.id,
      target: `uds:${socketPath}`,
      conversationId: 'c-uds-peer',
      workspaceRoot: root,
      explicit: true,
      source: 'test',
    })])

    await sendToUdsSocket(socketPath, 'hello peer')
    const delivered = await waitFor(() => inbox[0] ?? null)
    expect(delivered).toContain('hello peer')

    await server.close()
    expect(existsSync(socketPath)).toBe(false)
    expect(await registry.list()).toEqual([])
  } finally {
    await server.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
})

test('UdsPeerRegistry generates stable short default socket paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-peer-default-'))
  try {
    const registry = new UdsPeerRegistry(root)
    const first = registry.defaultSocketPath('conv-a')
    const second = registry.defaultSocketPath('conv-a')
    const other = registry.defaultSocketPath('conv-b')
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toContain('billiards-agent-uds')
    expect(first.length).toBeLessThan(90)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
