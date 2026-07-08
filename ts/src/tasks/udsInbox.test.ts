import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendToUdsSocket } from './udsClient'
import { startUdsInbox } from './udsInbox'

async function waitFor<T>(fn: () => T | null, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('startUdsInbox pushes wrapped cross-session messages into an inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-inbox-'))
  const inbox: string[] = []
  const server = await startUdsInbox({ socketPath: join(root, 'peer.sock'), inbox })
  try {
    await sendToUdsSocket(server.socketPath, 'hello from another session')
    const message = await waitFor(() => inbox[0] ?? null)
    expect(message).toContain('<cross-session-message from="uds:')
    expect(message).toContain('hello from another session')
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
