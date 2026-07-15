import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { startServer } from './index'
import { websocketControlProtocol } from './middleware/controlPlaneAuth'

async function rawWebSocketHandshake(port: number, headers: Record<string, string>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    socket.setTimeout(2000, () => socket.destroy(new Error('handshake timeout')))
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
      if (!response.includes('\r\n\r\n')) return
      socket.destroy()
      resolve(response)
    })
    socket.once('connect', () => {
      const lines = [
        'GET /agent/ws?conversationId=security-probe HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
  })
}

test('受保护 sidecar 只公开健康检查，控制面要求正确 Bearer token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-auth-'))
  const token = 'desktop-control-token'
  const server = startServer({ port: 0, transcriptRoot: root, controlToken: token })
  const base = `http://127.0.0.1:${server.port}`
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/api/settings`)).status).toBe(401)
    expect((await fetch(`${base}/api/settings`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${base}/api/settings`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('WebSocket 同时校验控制令牌和浏览器 Origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'control-ws-auth-'))
  const token = 'desktop-ws-token'
  const server = startServer({ port: 0, transcriptRoot: root, controlToken: token })
  try {
    const missing = await rawWebSocketHandshake(server.port!, { Origin: 'http://127.0.0.1:5173' })
    expect(missing).toStartWith('HTTP/1.1 401')

    const hostile = await rawWebSocketHandshake(server.port!, {
      Origin: 'http://evil.example',
      'Sec-WebSocket-Protocol': websocketControlProtocol(token),
    })
    expect(hostile).toStartWith('HTTP/1.1 403')

    const trusted = await rawWebSocketHandshake(server.port!, {
      Origin: 'http://localhost:5173',
      'Sec-WebSocket-Protocol': websocketControlProtocol(token),
    })
    expect(trusted).toStartWith('HTTP/1.1 101')
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})
