import { createConnection } from 'node:net'

export interface SendToUdsSocketOptions {
  timeoutMs?: number
}

export async function sendToUdsSocket(socketPath: string, message: string, options: SendToUdsSocketOptions = {}): Promise<void> {
  if (!socketPath.trim()) throw new Error('address target must not be empty')
  const timeoutMs = options.timeoutMs ?? 5000
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let settled = false

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) socket.destroy()
      if (err) reject(err)
      else resolve()
    }

    const timer = setTimeout(() => {
      socket.destroy()
      finish(new Error(`Timed out sending to ${socketPath}`))
    }, timeoutMs)

    socket.once('error', err => finish(err instanceof Error ? err : new Error(String(err))))
    socket.once('connect', () => {
      socket.end(message, 'utf8')
    })
    socket.once('close', hadError => {
      if (!hadError) finish()
    })
  })
}
