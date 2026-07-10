import { mkdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { dirname } from 'node:path'
import { formatCrossSessionMessage } from './crossSessionMessages'

export interface UdsInboxServer {
  socketPath: string
  close(): Promise<void>
}

export interface StartUdsInboxOptions {
  socketPath: string
  inbox: string[]
  fromPrefix?: string
}

/** Accepted connections that never send data and never close are dropped after this long. */
const ACCEPTED_SOCKET_IDLE_TIMEOUT_MS = 30_000

/** The minimal surface `attachInboxConnectionHandlers` needs from an accepted socket (kept narrow so tests can pass a bare EventEmitter-like fake). */
export interface InboxSocketLike {
  setEncoding(encoding: 'utf8'): unknown
  on(event: string, listener: (...args: any[]) => void): unknown
  setTimeout?(ms: number): unknown
  destroy?(): unknown
}

/**
 * Wire up lifecycle handling for one accepted UDS connection.
 *
 * Exported (not just inlined into `createServer`) so tests can drive it with
 * a lightweight fake socket and prove that an 'error' event — which is
 * exactly what a client dying mid-write (ECONNRESET) or a broken pipe (EPIPE)
 * raises — cannot crash the process. Node/Bun throw synchronously for any
 * EventEmitter 'error' event with zero listeners; this connection handler
 * used to attach none, so a single flaky client could take the whole
 * sidecar process down.
 */
export function attachInboxConnectionHandlers(
  socket: InboxSocketLike,
  options: { inbox: string[]; socketPath: string; fromPrefix?: string },
): void {
  let message = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    message += chunk
  })
  socket.on('end', () => {
    if (!message.trim()) return
    options.inbox.push(formatCrossSessionMessage(`${options.fromPrefix ?? 'uds'}:${options.socketPath}`, message))
  })
  // See the doc comment above: never leave this accepted socket without an
  // 'error' listener. Log and move on instead of crashing the sidecar.
  socket.on('error', err => {
    console.error(`[uds-inbox] connection error on ${options.socketPath}:`, err instanceof Error ? err.message : err)
  })
  // A client that connects but never sends/closes (stalled process, dropped
  // network) would otherwise leak the connection forever. Drop it instead.
  if (typeof socket.setTimeout === 'function') {
    socket.on('timeout', () => socket.destroy?.())
    socket.setTimeout(ACCEPTED_SOCKET_IDLE_TIMEOUT_MS)
  }
}

export async function startUdsInbox(options: StartUdsInboxOptions): Promise<UdsInboxServer> {
  const socketPath = options.socketPath.trim()
  if (!socketPath) throw new Error('socketPath is required')
  await mkdir(dirname(socketPath), { recursive: true })
  await rm(socketPath, { force: true }).catch(() => undefined)

  const server = createServer(socket => {
    attachInboxConnectionHandlers(socket, { inbox: options.inbox, socketPath, fromPrefix: options.fromPrefix })
  })

  // Runtime errors after startup (EMFILE, socket file removed out from under
  // us, etc.) must not crash the sidecar either — log and keep serving.
  server.on('error', err => {
    console.error(`[uds-inbox] server error on ${socketPath}:`, err instanceof Error ? err.message : err)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })

  return {
    socketPath,
    async close() {
      await closeServer(server)
      await rm(socketPath, { force: true }).catch(() => undefined)
    },
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(err => {
      if (err) reject(err)
      else resolve()
    })
  })
}
