import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendToUdsSocket } from './udsClient'
import { attachInboxConnectionHandlers, startUdsInbox } from './udsInbox'

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

test('a client that hard-disconnects mid-write does not crash the inbox server, and later connections still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'uds-inbox-crash-'))
  const inbox: string[] = []
  const server = await startUdsInbox({ socketPath: join(root, 'peer.sock'), inbox })
  try {
    // Connect, write partial data, then hard-abort the connection (no clean
    // FIN via .end()) — the scenario that used to be able to crash the
    // sidecar if the accepted socket ever emitted an unhandled 'error'.
    await new Promise<void>(resolve => {
      const client = createConnection(server.socketPath)
      client.once('connect', () => {
        client.write('partial message that never gets a clean close')
        client.destroy()
        resolve()
      })
      client.once('error', () => resolve())
    })

    // Give the server-side accepted socket a tick to process the abrupt close.
    await new Promise(resolve => setTimeout(resolve, 50))

    // The server process must still be alive and accept new connections normally.
    await sendToUdsSocket(server.socketPath, 'hello after the crash attempt')
    const message = await waitFor(() => inbox.find(m => m.includes('hello after the crash attempt')) ?? null)
    expect(message).toContain('hello after the crash attempt')
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('attachInboxConnectionHandlers survives an "error" event on the accepted socket (ECONNRESET/EPIPE) without throwing', () => {
  const inbox: string[] = []
  const destroyed: boolean[] = []
  const fakeSocket = new EventEmitter() as EventEmitter & {
    setEncoding: (encoding: 'utf8') => void
    setTimeout: (ms: number) => void
    destroy: () => void
  }
  fakeSocket.setEncoding = () => undefined
  fakeSocket.setTimeout = () => undefined
  fakeSocket.destroy = () => {
    destroyed.push(true)
  }

  expect(() => {
    attachInboxConnectionHandlers(fakeSocket, { inbox, socketPath: '/tmp/fake-uds-test.sock' })
  }).not.toThrow()

  // This is exactly what a client dying mid-write (ECONNRESET) or a broken
  // pipe (EPIPE) looks like from the accepted socket's perspective. Node/Bun
  // throw synchronously for an 'error' event with zero listeners — before
  // the fix this line would have thrown and could have taken the sidecar down.
  expect(() => {
    fakeSocket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  }).not.toThrow()

  // The connection must still be fully usable after the error — later
  // 'data'/'end' events still get processed into the inbox normally.
  fakeSocket.emit('data', 'still works after an error event')
  fakeSocket.emit('end')
  expect(inbox[0]).toContain('still works after an error event')

  // Idle-timeout wiring must also destroy the socket instead of leaking it.
  fakeSocket.emit('timeout')
  expect(destroyed).toEqual([true])
})
