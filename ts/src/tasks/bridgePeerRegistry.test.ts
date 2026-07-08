import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgePeerRegistry } from './bridgePeerRegistry'

test('BridgePeerRegistry persists Remote Control peer metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-peer-registry-'))
  try {
    const registry = new BridgePeerRegistry(root)
    const peer = await registry.register({
      sessionId: 'session_abc123',
      label: 'Laptop session',
      workspaceRoot: '/repo/app',
      machineName: 'MacBook',
      status: 'connected',
      inboundEnabled: true,
    })
    expect(peer.target).toBe('bridge:session_abc123')
    expect(peer.status).toBe('connected')

    const reloaded = new BridgePeerRegistry(root)
    expect(await reloaded.list()).toEqual([expect.objectContaining({
      id: peer.id,
      sessionId: 'session_abc123',
      target: 'bridge:session_abc123',
      label: 'Laptop session',
      workspaceRoot: '/repo/app',
      machineName: 'MacBook',
      inboundEnabled: true,
    })])

    const updated = await reloaded.updateStatus('bridge:session_abc123', 'outbound_only', 'inbound disabled')
    expect(updated).toMatchObject({
      status: 'outbound_only',
      inboundEnabled: false,
      lastError: 'inbound disabled',
    })

    await reloaded.unregister('session_abc123')
    expect(await reloaded.list()).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgePeerRegistry rejects empty or unsafe session ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-peer-invalid-'))
  try {
    const registry = new BridgePeerRegistry(root)
    await expect(registry.register({ sessionId: '' })).rejects.toThrow('sessionId is required')
    await expect(registry.register({ sessionId: 'session with spaces' })).rejects.toThrow('unsupported')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
