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

export async function startUdsInbox(options: StartUdsInboxOptions): Promise<UdsInboxServer> {
  const socketPath = options.socketPath.trim()
  if (!socketPath) throw new Error('socketPath is required')
  await mkdir(dirname(socketPath), { recursive: true })
  await rm(socketPath, { force: true }).catch(() => undefined)

  const server = createServer(socket => {
    let message = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      message += chunk
    })
    socket.on('end', () => {
      if (!message.trim()) return
      options.inbox.push(formatCrossSessionMessage(`${options.fromPrefix ?? 'uds'}:${socketPath}`, message))
    })
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
