import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { startServer } from './index'
import { SessionService } from './services/sessionService'
import { TaskService } from '../tasks/taskService'
import { textBlock, userText } from '../types/message'
import { getAutoMemDir } from '../harness/memoryNames'
import { signApproval } from '../permissions/approval'
import { sendToUdsSocket } from '../tasks/udsClient'

let server: ReturnType<typeof startServer>
let serverRoot: string
beforeAll(() => {
  serverRoot = mkdtempSync(join(tmpdir(), 'server-global-'))
  server = startServer({ port: 0, transcriptRoot: serverRoot, mcpConfigPath: join(serverRoot, 'missing.mcp.json') })
}) // port:0 = OS 随机端口
afterAll(() => {
  server.stop(true)
  rmSync(serverRoot, { recursive: true, force: true })
})

function wsClient(url: string) {
  const ws = new WebSocket(url)
  const queue: unknown[] = []
  const waiters: Array<(value: unknown) => void> = []
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket open failed')), { once: true })
  })
  ws.addEventListener('message', event => {
    const parsed = JSON.parse(String(event.data)) as unknown
    const waiter = waiters.shift()
    if (waiter) waiter(parsed)
    else queue.push(parsed)
  })
  return {
    ws,
    opened,
    async next(timeoutMs = 2000): Promise<any> {
      if (queue.length > 0) return queue.shift()
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('websocket message timeout')), timeoutMs)
        waiters.push(value => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    close() { ws.close() },
  }
}

async function collectWsEvents(client: ReturnType<typeof wsClient>): Promise<any[]> {
  const events: any[] = []
  for (let i = 0; i < 50; i++) {
    const msg = await client.next()
    events.push(msg)
    if (msg.type === 'event' && msg.event?.type === 'done') return events
  }
  throw new Error('websocket did not finish')
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timeout')
}

function sseResponse(payload: unknown): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

class FakeBridgeWebSocket {
  static instances: FakeBridgeWebSocket[] = []
  readonly listeners = new Map<string, Array<(event: any) => void>>()
  closed = false
  constructor(readonly url: string, readonly init?: any) {
    FakeBridgeWebSocket.instances.push(this)
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(): void {}
  close(): void { this.closed = true }
  emit(type: string, event: any = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

test('GET /health returns 200 ok', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; service: string }
  expect(body.ok).toBe(true)
  expect(body.service).toBe('ts-harness')
})

test('local dev CORS allows localhost frontend origins', async () => {
  const preflight = await fetch(`http://127.0.0.1:${server.port}/health`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:3100',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type',
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3100')

  const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
    headers: { origin: 'http://127.0.0.1:3100' },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3100')
})

test('legacy frontend capability endpoints are served by TS server', async () => {
  const [skillsRes, stylesRes, packsRes, commandsRes, pluginsRes, mcpRes] = await Promise.all([
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/skills`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/output-styles`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/packs`),
    fetch(`http://127.0.0.1:${server.port}/commands`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/plugins`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/mcp`),
  ])
  expect(skillsRes.status).toBe(200)
  expect(stylesRes.status).toBe(200)
  expect(packsRes.status).toBe(200)
  expect(commandsRes.status).toBe(200)
  expect(pluginsRes.status).toBe(200)
  expect(mcpRes.status).toBe(200)

  const skills = await skillsRes.json() as any
  const styles = await stylesRes.json() as any
  const packs = await packsRes.json() as any
  const commands = await commandsRes.json() as any
  const plugins = await pluginsRes.json() as any
  const mcp = await mcpRes.json() as any
  expect(Array.isArray(skills.skills)).toBe(true)
  expect(Array.isArray(styles.output_styles)).toBe(true)
  expect(packs.packs).toEqual([expect.objectContaining({ id: 'billiards', default_enabled: false })])
  expect(commands.commands.some((command: any) => command.name === 'doctor')).toBe(true)
  expect(Array.isArray(plugins.plugins)).toBe(true)
  expect(Array.isArray(mcp.servers)).toBe(true)
})

test('GET /api/v1/agent/commands 汇总 builtin+skill+领域知识挂载入口', async () => {
  // 不启用领域包:激活入口始终可发现
  const genericRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/commands`)
  expect(genericRes.status).toBe(200)
  const generic = await genericRes.json() as { commands: Array<{ name: string; description: string; source: string; argHint?: string; whenToUse?: string }> }
  expect(Array.isArray(generic.commands)).toBe(true)
  expect(generic.commands.some(command => command.name === '台球')).toBe(true)
  expect(generic.commands.some(command => command.name.startsWith('billiards:'))).toBe(false)
  // source 只在约定枚举内
  expect(generic.commands.every(command => ['builtin', 'skill', 'pack', 'plugin'].includes(command.source))).toBe(true)

  // 启用领域包后仍只有 /台球 入口,不新增领域工作流子命令
  const packRes = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/commands?conversationId=c1&enabledPacks=${encodeURIComponent('台球')}`)
  expect(packRes.status).toBe(200)
  const packed = await packRes.json() as { commands: Array<{ name: string; source: string }> }
  const names = packed.commands.map(command => command.name)
  expect(names).toContain('台球')
  expect(names.some(name => name.startsWith('billiards:'))).toBe(false)
  const entry = packed.commands.find(command => command.name === '台球')!
  expect(entry.source).toBe('pack')

  // POST 不允许
  const post = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/commands`, { method: 'POST' })
  expect(post.status).toBe(405)
})

test('workspace status endpoint returns compact git status for working_dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-status-'))
  try {
    execFileSync('git', ['init'], { cwd: root })
    writeFileSync(join(root, 'BILLIARDBUDDY.md'), '遵守项目规则\n')
    writeFileSync(join(root, 'draft.ts'), 'export const draft = 1\n')
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/workspace-status?working_dir=${encodeURIComponent(root)}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.git).toMatchObject({
      isGit: true,
      dirty: true,
      changed: 2,
      untracked: 2,
    })
    expect(body.projectInstructions).toEqual({
      files: [{ file: 'BILLIARDBUDDY.md', truncated: false }],
      count: 1,
      truncated: false,
    })
    expect(body.tree).toMatchObject({
      root,
      truncated: false,
    })
    expect(body.tree.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'BILLIARDBUDDY.md', path: 'BILLIARDBUDDY.md', type: 'file' }),
      expect.objectContaining({ name: 'draft.ts', path: 'draft.ts', type: 'file' }),
    ]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy conversation endpoints project TS sessions and support deleted-items restore/purge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-legacy-conv-'))
  const svc = new SessionService(root)
  await svc.touch('conv_legacy', { title: '旧前端会话', workspaceRoot: root, status: 'idle' })
  await svc.transcript('conv_legacy', root).save([
    userText('帮我写一条活动文案'),
    { role: 'assistant', content: [textBlock('今晚九点前到店开台有惊喜。')] },
  ])
  const convServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
  try {
    const list = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations`)).json() as any
    expect(list.conversations).toEqual([expect.objectContaining({ conversation_id: 'conv_legacy', title: '旧前端会话' })])

    const detail = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations/conv_legacy`)).json() as any
    expect(detail.messages).toEqual([
      { role: 'user', content: '帮我写一条活动文案' },
      { role: 'assistant', content: '今晚九点前到店开台有惊喜。' },
    ])

    const deleted = await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations/conv_legacy`, { method: 'DELETE' })
    expect(await deleted.json()).toMatchObject({ ok: true, conversation_id: 'conv_legacy' })
    const hidden = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations`)).json() as any
    expect(hidden.conversations).toEqual([])
    const trash = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/deleted-items`)).json() as any
    expect(trash.items).toEqual([expect.objectContaining({ kind: 'task', conversation_id: 'conv_legacy' })])

    const restored = await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/deleted-items/restore`, {
      method: 'POST',
      body: JSON.stringify({ conversation_id: 'conv_legacy' }),
    })
    expect(await restored.json()).toMatchObject({ ok: true })
    const visible = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations`)).json() as any
    expect(visible.conversations).toHaveLength(1)

    await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations/conv_legacy`, { method: 'DELETE' })
    const purged = await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/deleted-items/purge`, {
      method: 'POST',
      body: JSON.stringify({ conversation_id: 'conv_legacy' }),
    })
    expect(await purged.json()).toMatchObject({ ok: true })
    const gone = await (await fetch(`http://127.0.0.1:${convServer.port}/api/v1/agent/conversations/conv_legacy`)).json() as any
    expect(gone.messages).toEqual([])
  } finally {
    convServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy artifact endpoints save, rate, soft-delete and restore local TS artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-legacy-artifact-'))
  const artifactServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
  try {
    const saved = await (await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/saved-artifacts`, {
      method: 'POST',
      body: JSON.stringify({ title: '朋友圈文案', content: '今晚来打两局。', kind: 'assistant_answer', conversation_id: 'conv_a' }),
    })).json() as any
    expect(saved).toMatchObject({ kind: 'content', title: '朋友圈文案', content: '今晚来打两局。', conversation_id: 'conv_a' })

    const recent = await (await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/recent-artifacts`)).json() as any
    expect(recent.items).toEqual([expect.objectContaining({ id: saved.id, title: '朋友圈文案' })])

    const rated = await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/recent-artifacts/${saved.id}/rating`, {
      method: 'POST',
      body: JSON.stringify({ rating: 'good', note: 'usable' }),
    })
    expect(await rated.json()).toMatchObject({ ok: true, id: saved.id, rating: 'good' })

    const removed = await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/recent-artifacts/${saved.id}`, { method: 'DELETE' })
    expect(await removed.json()).toMatchObject({ ok: true, id: saved.id })
    const trash = await (await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/deleted-items`)).json() as any
    expect(trash.items).toEqual([expect.objectContaining({ id: saved.id, title: '朋友圈文案' })])

    const restored = await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/deleted-items/restore`, {
      method: 'POST',
      body: JSON.stringify({ id: saved.id }),
    })
    expect(await restored.json()).toMatchObject({ ok: true })
    const again = await (await fetch(`http://127.0.0.1:${artifactServer.port}/api/v1/agent/recent-artifacts`)).json() as any
    expect(again.items).toEqual([expect.objectContaining({ id: saved.id })])
  } finally {
    artifactServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy file diff and restore endpoints operate on explicit local backup paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-file-diff-'))
  const file = join(root, 'copy.txt')
  const backup = join(root, 'copy.txt.bak')
  writeFileSync(backup, 'old text')
  writeFileSync(file, 'new text')
  try {
    const diff = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/file-diff?path=${encodeURIComponent(file)}&backup_path=${encodeURIComponent(backup)}`)).json() as any
    expect(diff).toMatchObject({ ok: true, path: file, backup_path: backup, old: 'old text', new: 'new text' })

    const restored = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/file-restore`, {
      method: 'POST',
      body: JSON.stringify({ path: file, backup_path: backup }),
    })).json() as any
    expect(restored.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('old text')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy /api/v1/agent/chat streams frontend-compatible SSE from TS turn runner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-legacy-chat-'))
  const chatServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '收到' }, finish_reason: 'stop' }] })}\n\n`))
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  try {
    const res = await fetch(`http://127.0.0.1:${chatServer.port}/api/v1/agent/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: '你好', conversation_id: 'legacy_chat' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"type":"final"')
    expect(text).toContain('收到')
    expect(text).toContain('"type":"done"')
    expect(text).toContain('"conversation_id":"legacy_chat"')
  } finally {
    chatServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('desktop product compatibility endpoints are served by TS without Python', async () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-product-api-'))
  const productServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
  const base = `http://127.0.0.1:${productServer.port}`
  try {
    const store = await (await fetch(`${base}/api/v1/stores/me`, {
      method: 'PUT',
      body: JSON.stringify({ name: '九号台球', table_count: 12 }),
    })).json() as any
    expect(store).toMatchObject({ name: '九号台球', table_count: 12, my_role: 'owner' })

    const byok = await (await fetch(`${base}/api/v1/stores/me/byok`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, base_url: 'https://model.example/v1', model: 'mimo-v2.5', api_key: 'sk-test-123456' }),
    })).json() as any
    expect(byok).toMatchObject({ enabled: true, base_url: 'https://model.example/v1', model: 'mimo-v2.5', key_configured: true })
    expect(byok.key_mask).not.toContain('sk-test-123456')

    const scheduled = await (await fetch(`${base}/api/v1/scheduled-tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: '每日文案', instruction: '写一条朋友圈', schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 } }),
    })).json() as any
    expect(scheduled).toMatchObject({ name: '每日文案', enabled: true })

    const docsDir = join(root, 'store-docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '价目表.txt'), '黄金档台费 68 元一小时，会员充值满 1000 送 120。')
    const docs = await (await fetch(`${base}/api/v1/store-docs`, {
      method: 'PUT',
      body: JSON.stringify({ folder_path: docsDir }),
    })).json() as any
    expect(docs).toMatchObject({ folder_path: docsDir, status: 'ready', indexed_file_count: 1 })

    const notifications = await (await fetch(`${base}/api/v1/notifications?after=0`)).json() as any
    expect(notifications).toMatchObject({ items: [], cursor: 0 })

    const backup = await fetch(`${base}/api/v1/backup/export`)
    expect(backup.headers.get('content-type')).toContain('application/json')
    expect(await backup.text()).toContain('九号台球')
  } finally {
    productServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('voice transcribe endpoint uses configured local runner and rejects empty upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-local-'))
  const runner = join(root, 'fake-whisper.js')
  writeFileSync(runner, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], '台球语音');\n")
  const voiceServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      PATH: process.env.PATH,
      WHISPER_TRANSCRIBE_COMMAND: `${process.execPath} ${runner} {output}`,
    },
  })
  const base = `http://127.0.0.1:${voiceServer.port}`
  try {
    const form = new FormData()
    form.set('file', new File([Buffer.from('fake-audio')], 'voice.webm', { type: 'audio/webm' }))
    const ok = await (await fetch(`${base}/api/v1/voice/transcribe`, { method: 'POST', body: form })).json() as any
    expect(ok).toEqual({ text: '台球语音' })

    const emptyForm = new FormData()
    emptyForm.set('file', new File([], 'empty.webm', { type: 'audio/webm' }))
    const empty = await fetch(`${base}/api/v1/voice/transcribe`, { method: 'POST', body: emptyForm })
    expect(empty.status).toBe(400)
    expect(await empty.json()).toMatchObject({ detail: '没收到录音内容，请重新录一次' })
  } finally {
    voiceServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('voice transcribe endpoint prefers the authenticated remote service without local model files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-remote-'))
  const outbound: Array<{ url: string; authorization: string; body: unknown }> = []
  const voiceServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      PATH: process.env.PATH,
      QF_GATEWAY_URL: 'https://gateway.example/gw',
      QF_GATEWAY_TOKEN: 'app-token',
    },
    fetchImpl: async (input, init) => {
      outbound.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: init?.body,
      })
      return Response.json({ text: '远程识别成功' })
    },
  })
  const base = `http://127.0.0.1:${voiceServer.port}`
  try {
    const form = new FormData()
    form.set('file', new File([Buffer.from('fake-audio')], 'voice.webm', { type: 'audio/webm' }))
    const response = await fetch(`${base}/api/v1/voice/transcribe`, { method: 'POST', body: form })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: '远程识别成功' })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]).toMatchObject({
      url: 'https://gateway.example/gw/v1/audio/transcriptions',
      authorization: 'Bearer app-token',
    })
    expect(outbound[0]!.body).toBeInstanceOf(FormData)
    expect(existsSync(join(root, 'voice-tmp'))).toBe(false)
  } finally {
    voiceServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('canvas local TS endpoints render and write deterministic text formats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-local-'))
  const canvasServer = startServer({ port: 0, transcriptRoot: root })
  const base = `http://127.0.0.1:${canvasServer.port}`
  try {
    const html = await (await fetch(`${base}/api/v1/canvas/render`, {
      method: 'POST',
      body: JSON.stringify({ content: '# 标题\n\n- 项目', format: 'html' }),
    })).json() as any
    expect(html.ext).toBe('html')
    expect(Buffer.from(html.base64, 'base64').toString('utf8')).toContain('<h1>标题</h1>')

    const docx = await (await fetch(`${base}/api/v1/canvas/render`, {
      method: 'POST',
      body: JSON.stringify({ content: '# 标题\n\n正文', format: 'docx' }),
    })).json() as any
    expect(docx.ext).toBe('docx')
    const docxBytes = Buffer.from(docx.base64, 'base64')
    expect(docxBytes.subarray(0, 2).toString('utf8')).toBe('PK')
    expect(docxBytes.toString('utf8')).toContain('word/document.xml')

    const docxPath = join(root, 'proposal.docx')
    writeFileSync(docxPath, docxBytes)
    const docxBlocks = await (await fetch(`${base}/api/v1/canvas/doc-blocks`, {
      method: 'POST',
      body: JSON.stringify({ path: docxPath }),
    })).json() as any
    expect(docxBlocks.blocks.map((b: any) => b.text)).toEqual(['标题', '正文'])
    const docxSave = await (await fetch(`${base}/api/v1/canvas/doc-save`, {
      method: 'POST',
      body: JSON.stringify({ path: docxPath, edits: { b1: '正文已改' } }),
    })).json() as any
    expect(docxSave).toMatchObject({ ok: true, saved: 1 })
    const docxAfter = await (await fetch(`${base}/api/v1/canvas/doc-blocks`, {
      method: 'POST',
      body: JSON.stringify({ path: docxPath }),
    })).json() as any
    expect(docxAfter.blocks.map((b: any) => b.text)).toContain('正文已改')

    const pptx = await (await fetch(`${base}/api/v1/canvas/render`, {
      method: 'POST',
      body: JSON.stringify({ content: '# 台球活动\n\n- 九点开赛', format: 'pptx' }),
    })).json() as any
    expect(pptx.ext).toBe('pptx')
    const pptxPath = join(root, 'deck.pptx')
    writeFileSync(pptxPath, Buffer.from(pptx.base64, 'base64'))
    const pptxBlocks = await (await fetch(`${base}/api/v1/canvas/doc-blocks`, {
      method: 'POST',
      body: JSON.stringify({ path: pptxPath }),
    })).json() as any
    expect(pptxBlocks.blocks.map((b: any) => b.text)).toEqual(['台球活动', '九点开赛'])
    const pptxSave = await (await fetch(`${base}/api/v1/canvas/doc-save`, {
      method: 'POST',
      body: JSON.stringify({ path: pptxPath, edits: { b1: '十点决赛' } }),
    })).json() as any
    expect(pptxSave).toMatchObject({ ok: true, saved: 1 })
    const pptxAfter = await (await fetch(`${base}/api/v1/canvas/doc-blocks`, {
      method: 'POST',
      body: JSON.stringify({ path: pptxPath }),
    })).json() as any
    expect(pptxAfter.blocks.map((b: any) => b.text)).toContain('十点决赛')

    const xlsx = await (await fetch(`${base}/api/v1/canvas/render`, {
      method: 'POST',
      body: JSON.stringify({ content: '姓名,分数\n小王,8', format: 'xlsx' }),
    })).json() as any
    expect(xlsx.ext).toBe('xlsx')
    const xlsxPath = join(root, 'score.xlsx')
    writeFileSync(xlsxPath, Buffer.from(xlsx.base64, 'base64'))
    const sheet = await (await fetch(`${base}/api/v1/canvas/sheet`, {
      method: 'POST',
      body: JSON.stringify({ path: xlsxPath }),
    })).json() as any
    expect(sheet.sheets[0].rows).toEqual([['姓名', '分数'], ['小王', '8']])
    const xlsxEdited = await (await fetch(`${base}/api/v1/canvas/excel-edit`, {
      method: 'POST',
      body: JSON.stringify({ path: xlsxPath, cell: 'B2', value: '9' }),
    })).json() as any
    expect(xlsxEdited).toMatchObject({ ok: true, cell: 'B2', old: '8', new: '9' })
    const sheetAfter = await (await fetch(`${base}/api/v1/canvas/sheet`, {
      method: 'POST',
      body: JSON.stringify({ path: xlsxPath }),
    })).json() as any
    expect(sheetAfter.sheets[0].rows[1][1]).toBe('9')

    const saved = await (await fetch(`${base}/api/v1/canvas/save-to-library`, {
      method: 'POST',
      body: JSON.stringify({ content: '正文', format: 'docx', name: '导出测试' }),
    })).json() as any
    expect(saved.path.endsWith('.docx')).toBe(true)
    expect(existsSync(saved.path)).toBe(true)

    const textPath = join(root, 'note.md')
    writeFileSync(textPath, '第一段\n\n第二段')
    const blocks = await (await fetch(`${base}/api/v1/canvas/doc-blocks`, {
      method: 'POST',
      body: JSON.stringify({ path: textPath }),
    })).json() as any
    expect(blocks.blocks.map((b: any) => b.text)).toEqual(['第一段', '第二段'])
    const docSave = await (await fetch(`${base}/api/v1/canvas/doc-save`, {
      method: 'POST',
      body: JSON.stringify({ path: textPath, edits: { b1: '第二段已改' } }),
    })).json() as any
    expect(docSave).toMatchObject({ ok: true, saved: 1 })
    expect(readFileSync(textPath, 'utf8')).toContain('第二段已改')
    expect(existsSync(join(root, '.billiards-backups'))).toBe(true)

    const csvPath = join(root, 'sheet.csv')
    writeFileSync(csvPath, 'A,B\nC,D')
    const edited = await (await fetch(`${base}/api/v1/canvas/excel-edit`, {
      method: 'POST',
      body: JSON.stringify({ path: csvPath, cell: 'B2', value: 'X' }),
    })).json() as any
    expect(edited).toMatchObject({ ok: true, cell: 'B2', old: 'D', new: 'X' })
    expect(readFileSync(csvPath, 'utf8')).toBe('A,B\nC,X')
  } finally {
    canvasServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /api/v1/agent/execute verifies approval token and runs TS tool registry', async () => {
  const args = { command: 'echo approved-tool' }
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'run_command',
      args,
      token: signApproval('run_command', args),
      permissionMode: 'full',
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.ok).toBe(true)
  expect(body.tool).toBe('run_command')
  expect(body.result).toContain('approved-tool')

  const denied = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({ tool: 'run_command', args, token: 'bad-token' }),
  })
  const deniedBody = await denied.json() as any
  expect(deniedBody.ok).toBe(false)
  expect(deniedBody.result).toContain('审批校验失败')
})

test('POST /api/v1/agent/execute writes the approved tool result into the transcript (cc approval-loop resume)', async () => {
  const args = { command: 'echo approved-into-transcript' }
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'run_command',
      args,
      token: signApproval('run_command', args),
      permissionMode: 'full',
      conversationId: 'approve-transcript',
    }),
  })
  expect(res.status).toBe(200)
  expect((await res.json() as any).ok).toBe(true)
  // 审批放行的工具结果应落进 transcript(append-only 事件日志,projects/<slug> 布局),下一轮模型能看见(不再永远停在 pending)
  const transcript = JSON.stringify(await new SessionService(serverRoot).loadTranscript('approve-transcript'))
  expect(transcript).toContain('[已批准并执行工具 run_command]')
  expect(transcript).toContain('approved-into-transcript')
})

test('POST /api/v1/agent/execute 无 working_dir 时从 session meta 自愈,写文件落进会话目录而非默认目录(2026-07-12 审计+真机逮到的孪生洞)', async () => {
  // 建一个绑到特定工作目录的会话(不传 working_dir 模拟前端漏带)
  const sessionDir = mkdtempSync(join(tmpdir(), 'approve-heal-ws-'))
  const svc = new SessionService(serverRoot)
  await svc.create({ id: 'approve-heal', title: 'heal', workspaceRoot: sessionDir })
  const args = { path: 'approve-heal.txt', content: 'landed-in-session-dir\n' }
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'write_file',
      args,
      token: signApproval('write_file', args),
      permissionMode: 'full',
      conversationId: 'approve-heal',
      // 故意不带 working_dir:后端应从 session meta 补回 sessionDir
    }),
  })
  expect(res.status).toBe(200)
  expect((await res.json() as any).ok).toBe(true)
  // 文件必须落在会话目录,不能落进默认目录(自愈生效的铁证)
  expect(existsSync(join(sessionDir, 'approve-heal.txt'))).toBe(true)
  expect(readFileSync(join(sessionDir, 'approve-heal.txt'), 'utf8')).toContain('landed-in-session-dir')
  rmSync(sessionDir, { recursive: true, force: true })
})

test('POST /api/v1/agent/execute 区分领域包字段缺失与显式空数组', async () => {
  const conversationId = 'approve-pack-state'
  const svc = new SessionService(serverRoot)
  await svc.create({ id: conversationId, title: 'pack state', workspaceRoot: serverRoot })
  await svc.touch(conversationId, { enabledPacks: ['billiards'] })
  const tool = 'billiards_knowledge_search'
  const args = { query: '日报' }
  const request = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool,
      args,
      token: signApproval(tool, args),
      permissionMode: 'full',
      conversationId,
      ...body,
    }),
  })

  const inherited = await request({})
  expect((await inherited.json() as any)).toMatchObject({ ok: true, tool })

  const disabled = await request({ enabled_packs: [] })
  const disabledBody = await disabled.json() as any
  expect(disabledBody.ok).toBe(false)
  expect(disabledBody.result).toContain('未知工具')
})

test('POST /api/v1/agent/execute uses approval_args for edited approval parameters', async () => {
  const originalArgs = { command: 'echo original-approval' }
  const editedArgs = { command: 'echo edited-approval' }
  const token = signApproval('run_command', originalArgs)

  const approved = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'run_command',
      args: editedArgs,
      approval_args: originalArgs,
      token,
      permissionMode: 'full',
    }),
  })
  const approvedBody = await approved.json() as any
  expect(approvedBody.ok).toBe(true)
  expect(approvedBody.result).toContain('edited-approval')
  expect(approvedBody.result).not.toContain('original-approval')

  const stale = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'run_command',
      args: editedArgs,
      token,
      permissionMode: 'full',
    }),
  })
  const staleBody = await stale.json() as any
  expect(staleBody.ok).toBe(false)
  expect(staleBody.result).toContain('审批校验失败')
})

test('POST /api/v1/agent/execute temporarily grants approved external file directories', async () => {
  const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'execute-workspace-')))
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'execute-external-')))
  try {
    const args = { path: join(externalRoot, 'approved.txt'), content: 'approved external' }
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
      method: 'POST',
      body: JSON.stringify({
        tool: 'write_file',
        args,
        token: signApproval('write_file', args),
        conversationId: 'execute-external-file',
        workspaceRoot,
        permissionMode: 'default',
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(readFileSync(join(externalRoot, 'approved.txt'), 'utf8')).toBe('approved external')

    const rememberArgs = { path: join(externalRoot, 'remembered.txt'), content: 'remembered external' }
    const remembered = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
      method: 'POST',
      body: JSON.stringify({
        tool: 'write_file',
        args: rememberArgs,
        token: signApproval('write_file', rememberArgs),
        conversationId: 'execute-external-file',
        workspaceRoot,
        permissionMode: 'default',
        remember_approval: true,
      }),
    })
    const rememberedBody = await remembered.json() as any
    expect(rememberedBody.ok).toBe(true)
    expect(rememberedBody.permission_updates).toEqual([
      { type: 'setMode', destination: 'session', mode: 'acceptEdits' },
      { type: 'addDirectories', destination: 'session', directories: [externalRoot] },
    ])
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('POST /api/v1/agent/execute sends bridge messages through Remote Control transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-execute-'))
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return new Response('{}', { status: 201 })
    },
  })
  const args = { to: 'bridge:session_bridge_execute', message: 'remote status please' }
  try {
    await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'session_bridge_execute', status: 'connected', inbound_enabled: true }),
    })
    const approved = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/execute`, {
      method: 'POST',
      body: JSON.stringify({
        tool: 'SendMessage',
        args,
        token: signApproval('SendMessage', args),
        permissionMode: 'full',
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'remote-token',
          org_uuid: 'org_remote',
        },
      }),
    })
    const body = await approved.json() as any
    expect(body.ok).toBe(true)
    expect(JSON.parse(body.result)).toMatchObject({
      success: true,
      routing: {
        target: 'bridge:session_bridge_execute',
        content: 'remote status please',
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://remote.example/v1/sessions/session_bridge_execute/events')
    expect(calls[0]!.headers).toMatchObject({
      authorization: 'Bearer remote-token',
      'x-organization-uuid': 'org_remote',
    })
    expect(calls[0]!.body).toMatchObject({
      events: [{
        session_id: 'session_bridge_execute',
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'remote status please' },
      }],
    })
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /api/v1/agent/execute stores oversized approved command results', async () => {
  const conversationId = 'approved-big-output'
  const args = { command: `node -e "process.stdout.write('HEAD\\n' + 'x'.repeat(25000) + '\\nTAIL')"` }
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/agent/execute`, {
    method: 'POST',
    body: JSON.stringify({
      tool: 'run_command',
      args,
      token: signApproval('run_command', args),
      permissionMode: 'full',
      conversation_id: conversationId,
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as any
  expect(body.ok).toBe(true)
  expect(body.result).toContain('<stored_tool_result')
  expect(body.result).toContain('HEAD')
  expect(body.result).toContain('TAIL')
  expect(body.result).not.toContain('x'.repeat(20_000))

  const path = String(body.result.match(/path="([^"]+)"/)?.[1] || '')
  expect(path).toContain(join('tool-results', conversationId))
  expect(existsSync(path)).toBe(true)
  const stored = readFileSync(path, 'utf8')
  expect(stored).toContain('HEAD')
  expect(stored).toContain('TAIL')
  expect(stored).toContain('x'.repeat(20_000))
})

test('server mounts MCP routes with the configured desktop library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-mcp-config-'))
  const cfgServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { BILLIARDBUDDY_LOCAL: '1', BILLIARDBUDDY_LIBRARY_DIR: root },
  })
  try {
    const add = await fetch(`http://127.0.0.1:${cfgServer.port}/api/v1/agent/mcp/add`, {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', command: 'node', args: ['server.js'] }),
    })
    expect(await add.json()).toMatchObject({ ok: true })

    const toggle = await fetch(`http://127.0.0.1:${cfgServer.port}/api/v1/agent/mcp/toggle`, {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', disabled: true }),
    })
    expect(await toggle.json()).toMatchObject({ ok: true })

    const listed = await fetch(`http://127.0.0.1:${cfgServer.port}/api/v1/agent/mcp`)
    const listBody = await listed.json() as any
    expect(listBody.servers).toEqual([expect.objectContaining({ name: 'demo', status: 'disabled', disabled: true })])

    const remove = await fetch(`http://127.0.0.1:${cfgServer.port}/api/v1/agent/mcp/remove`, {
      method: 'POST',
      body: JSON.stringify({ name: 'demo' }),
    })
    expect(await remove.json()).toMatchObject({ ok: true })
    const empty = await (await fetch(`http://127.0.0.1:${cfgServer.port}/api/v1/agent/mcp`)).json() as any
    expect(empty.servers).toEqual([])
  } finally {
    cfgServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('server mounts plugin routes with the configured library root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugins-'))
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo plugin', enabled: true }))
  const pluginServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { BILLIARDBUDDY_LOCAL: '1', BILLIARDBUDDY_LIBRARY_DIR: root },
  })
  try {
    const listed = await fetch(`http://127.0.0.1:${pluginServer.port}/api/v1/agent/plugins`)
    const listBody = await listed.json() as any
    expect(listBody.plugins).toEqual([expect.objectContaining({ name: 'demo', enabled: true, description: 'Demo plugin' })])

    const toggled = await fetch(`http://127.0.0.1:${pluginServer.port}/api/v1/agent/plugins/toggle`, {
      method: 'POST',
      body: JSON.stringify({ name: 'demo', enabled: false }),
    })
    expect(await toggled.json()).toMatchObject({ ok: true })

    const invalidInstall = await fetch(`http://127.0.0.1:${pluginServer.port}/api/v1/agent/plugins/install`, {
      method: 'POST',
      body: '{}',
    })
    expect(await invalidInstall.json()).toMatchObject({ ok: false })
  } finally {
    pluginServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

// 死链回归:已启用插件贡献的 hooks 与 commands 必须真接进会话(不再"函数写好了但从不调用")。
// hooks 走 /agent/run 主回合(SessionStart context 注入进系统提示);commands 走 /agent/execute 审批执行注册表(read_command 能读到)。
test('enabled plugin hooks, skills, commands and MCP are wired into the main Agent turn and discovery', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agent-plugin-wired-'))
  const pluginDir = join(root, 'plugins', 'demo')
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true })
  mkdirSync(join(pluginDir, 'skills', 'plugin-skill'), { recursive: true })
  mkdirSync(join(pluginDir, 'commands'), { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo plugin', enabled: true }))
  // cc 包裹结构:{ description, hooks: { <event>: [{hooks:[...]}] } };SessionStart 注入独特标记
  writeFileSync(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({
    description: 'demo plugin hooks',
    hooks: { SessionStart: [{ hooks: [{ decision: { action: 'context', additionalContext: 'PLUGIN_HOOK_SESSION_MARKER' } }] }] },
  }))
  writeFileSync(join(pluginDir, 'commands', 'plugintest.md'), `---
description: Demo plugin command
---
PLUGIN_COMMAND_BODY_MARKER
`)
  writeFileSync(join(pluginDir, 'skills', 'plugin-skill', 'SKILL.md'), `---
name: plugin-skill
description: Demo plugin skill
---
PLUGIN_SKILL_BODY_MARKER
`)
  const fixturePath = join(root, 'plugin-mcp-server.ts')
  writeFileSync(fixturePath, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'pluginfixture', version: '1.0.0' })
server.registerTool('echo', {
  description: 'Echo text through plugin MCP',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({ content: [{ type: 'text', text: 'plugin-mcp:' + text }] }))
await server.connect(new StdioServerTransport())
`)
  writeFileSync(join(pluginDir, '.mcp.json'), JSON.stringify({
    mcpServers: { pluginfixture: { command: process.execPath, args: [fixturePath] } },
  }))
  const sentBodies: any[] = []
  let calls = 0
  const wiredServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      BILLIARDBUDDY_LOCAL: '1',
      BILLIARDBUDDY_LIBRARY_DIR: root,
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(String(init?.body || '{}')))
      return sseResponse(calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'plugin-mcp-call', function: { name: 'mcp__pluginfixture__echo', arguments: JSON.stringify({ text: 'hello' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'plugin done' }, finish_reason: 'stop' }] })
    },
  })
  try {
    // A) 插件 hooks 接进主回合:SessionStart context 注入进发给模型的系统提示。
    const run = await fetch(`http://127.0.0.1:${wiredServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '你好', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    const runText = await run.text()
    const systemPrompt = String(sentBodies[0]?.messages?.[0]?.content ?? '')
    expect(systemPrompt).toContain('PLUGIN_HOOK_SESSION_MARKER')
    expect(systemPrompt).toContain('\n- /plugintest')
    expect(systemPrompt).toContain('\n- /plugin-skill')
    expect(sentBodies[0].tools.some((tool: any) => tool.function.name === 'mcp__pluginfixture__echo')).toBe(true)
    expect(runText).toContain('plugin-mcp:hello')

    const discovered = await (await fetch(`http://127.0.0.1:${wiredServer.port}/api/v1/agent/commands?working_dir=${encodeURIComponent(root)}`)).json() as any
    expect(discovered.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'plugintest', source: 'plugin' }),
      expect.objectContaining({ name: 'plugin-skill', source: 'plugin', layer: 'plugin' }),
    ]))

    // B) 插件 commands 接进会话命令来源:审批执行注册表的 read_command 能读到插件命令正文。
    const readArgs = { name: 'plugintest' }
    const exec = await fetch(`http://127.0.0.1:${wiredServer.port}/api/v1/agent/execute`, {
      method: 'POST',
      body: JSON.stringify({
        tool: 'read_command',
        args: readArgs,
        token: signApproval('read_command', readArgs),
        permissionMode: 'full',
        workspaceRoot: root,
      }),
    })
    expect(exec.status).toBe(200)
    const execBody = await exec.json() as any
    expect(execBody.ok).toBe(true)
    expect(String(execBody.result)).toContain('PLUGIN_COMMAND_BODY_MARKER')
  } finally {
    wiredServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('GET /agent/hello streams the real agent loop as SSE', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/agent/hello`)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  // 真循环 demo:think → list_dir → 结果回灌 → final;真模型出口 = W6
  expect(text).toContain('event: tool_call')
  expect(text).toContain('list_dir')
  expect(text).toContain('event: tool_result')
  expect(text).toContain('event: final')
  expect(text).toContain('event: done')
})

test('POST /agent/run streams through configured real Model adapter and tools', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-transcript-'))
  let calls = 0
  const realServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, _init) => {
      calls++
      const enc = new TextEncoder()
      const lines = calls === 1
        ? [
            JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
            '[DONE]',
          ]
        : [
            JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] }),
            '[DONE]',
          ]
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          for (const line of lines) c.enqueue(enc.encode(`data: ${line}\n\n`))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${realServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '列目录', conversationId: 'c1', permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: tool_call')
    expect(text).toContain('list_dir')
    expect(text).toContain('event: final')
    expect(text).toContain('完成')
    expect(calls).toBe(2)

    const sessionRes = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1`)
    expect(sessionRes.status).toBe(200)
    const sessionBody = await sessionRes.json() as any
    expect(sessionBody.session).toMatchObject({ id: 'c1', status: 'idle' })
    expect(sessionBody.messages.some((m: any) => m.role === 'assistant')).toBe(true)

    const eventsRes = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/events`)
    const eventsBody = await eventsRes.json() as any
    expect(eventsBody.events.map((e: any) => e.event.type)).toEqual(['user_prompt', 'tool_call', 'tool_result', 'final', 'done'])
    expect(eventsBody.nextSeq).toBe(5)
  } finally {
    realServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes WebSearch to the model only when gateway health enables it', async () => {
  async function modelToolNames(webSearchEnabled: boolean): Promise<string[]> {
    const transcriptRoot = mkdtempSync(join(tmpdir(), `agent-web-search-${webSearchEnabled ? 'on' : 'off'}-`))
    let modelRequest: any
    const capabilityServer = startServer({
      port: 0,
      transcriptRoot,
      env: {
        DEEPSEEK_BASE_URL: 'https://model.example/v1',
        DEEPSEEK_API_KEY: 'model-token',
        TEXT_MODEL_NAME: 'mimo-v2.5',
        QF_GATEWAY_URL: 'https://gateway.example',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url === 'https://gateway.example/healthz') {
          expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer app-token')
          return Response.json({ ok: true, features: { web_search: webSearchEnabled } })
        }
        modelRequest = JSON.parse(String(init?.body ?? '{}'))
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })
      },
    })
    try {
      const response = await fetch(`http://127.0.0.1:${capabilityServer.port}/agent/run`, {
        method: 'POST',
        body: JSON.stringify({ message: '查一下最新资料', conversationId: `web-search-${webSearchEnabled}`, permissionMode: 'full' }),
      })
      expect(response.status).toBe(200)
      await response.text()
      return (modelRequest.tools ?? []).map((tool: any) => tool.function.name)
    } finally {
      capabilityServer.stop(true)
      rmSync(transcriptRoot, { recursive: true, force: true })
    }
  }

  expect(await modelToolNames(false)).not.toContain('WebSearch')
  expect(await modelToolNames(true)).toContain('WebSearch')
})

// 错误路径兜底(B 线调用方):runAgentLoop 错误出口 throw 后,server 必须在 catch 里合成一条最终答复,
// 否则错误路径会"点了没最终回复"。这里让上游模型返回非可重试的 400 → ProxyModel 立刻抛错 → 循环 throw。
test('POST /agent/run 错误路径仍合成最终答复(server catch 兜底,不留悬空无 final)', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-error-'))
  let calls = 0
  const errServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => { calls++; return new Response('bad request', { status: 400 }) },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${errServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '触发模型错误', conversationId: 'cerr', permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // 错误路径也必须给出最终答复(合成的失败 final),而不是流悬空、无 final。
    expect(text).toContain('event: final')
    expect(text).toContain('任务执行失败')
    expect(calls).toBeGreaterThan(0)
    // 会话状态落为 failed(对齐 finally 里的 finalStatus)。
    const sessionRes = await fetch(`http://127.0.0.1:${errServer.port}/sessions/cerr`)
    const body = await sessionRes.json() as any
    expect(body.session.status).toBe('failed')
  } finally {
    errServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run starts a UDS inbox and injects cross-session steering', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-uds-inbox-'))
  let calls = 0
  let releaseSecondStep: (() => void) | undefined
  // 防竞态闸:第一步模型响应压到 UDS 插话真正落地之后再放行——否则瞬时 mock 响应会赶在
  // 插话进 steerInbox 前跑完 drainSteering 单次检查,高负载下必挂(2026-07-10 根因确认)。
  let releaseFirstStep!: () => void
  const firstStepGate = new Promise<void>(resolve => { releaseFirstStep = resolve })
  const udsServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      if (calls === 1) {
        await firstStepGate
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '初稿' }, finish_reason: 'stop' }] })}\n\n`))
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      await new Promise<void>(resolve => { releaseSecondStep = resolve })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '处理跨会话消息完成' }, finish_reason: 'stop' }] })}\n\n`))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const socketPath = join(transcriptRoot, 'session.sock')
  try {
    const runPromise = fetch(`http://127.0.0.1:${udsServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '等待跨会话消息',
        conversationId: 'uds-inbox-run',
        permissionMode: 'full',
        messagingSocketPath: socketPath,
      }),
    }).then(res => res.text())

    await waitFor(async () => existsSync(socketPath) ? 'ready' : null)
    await sendToUdsSocket(socketPath, 'please inspect parser state')
    // 客户端 send 已完成(字节已到服务端),留一拍让服务端 data handler 把消息推进 steerInbox,
    // 再放行第一步模型响应——保证 drainSteering 检查时插话确定在场。
    await new Promise(resolve => setTimeout(resolve, 25))
    releaseFirstStep()
    await waitFor(async () => calls >= 2 ? 'second-step-started' : null)
    releaseSecondStep?.()

    const text = await runPromise
    expect(text).toContain('event: steering')
    expect(text).toContain('<cross-session-message from=\\"uds:')
    expect(text).toContain('please inspect parser state')
    expect(text).toContain('处理跨会话消息完成')
    expect(existsSync(socketPath)).toBe(false)
  } finally {
    udsServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes default UDS inbox through ListPeers', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-uds-peers-'))
  let calls = 0
  const udsServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_peers', function: { name: 'ListPeers', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '已看到跨会话 peer' }, finish_reason: 'stop' }] }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${udsServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '列出可通信 peer',
        conversationId: 'uds-peer-list-run',
        permissionMode: 'full',
      }),
    })
    const text = await res.text()
    expect(text).toContain('event: tool_call')
    expect(text).toContain('ListPeers')
    expect(text).toContain('uds_peer_count')
    expect(text).toContain('uds_targets')
    expect(text).toContain('billiards-agent-uds')
    expect(text).toContain('已看到跨会话 peer')
    expect(calls).toBe(2)

    const registryPath = join(transcriptRoot, 'uds-peers', 'peers.json')
    expect(existsSync(registryPath)).toBe(false)
  } finally {
    udsServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('bridge peer API registers, lists, updates and deletes Remote Control peers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-peers-'))
  const bridgeServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
  try {
    const created = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`, {
      method: 'POST',
      body: JSON.stringify({
        session_id: 'session_remote_api',
        label: 'Remote API',
        workspace_root: '/remote/work',
        machine_name: 'Studio Mac',
        status: 'connected',
        inbound_enabled: true,
      }),
    })).json() as any
    expect(created.peer).toMatchObject({
      sessionId: 'session_remote_api',
      target: 'bridge:session_remote_api',
      label: 'Remote API',
      workspaceRoot: '/remote/work',
      machineName: 'Studio Mac',
      status: 'connected',
      inboundEnabled: true,
    })

    const listed = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`)).json() as any
    expect(listed.peers).toEqual([expect.objectContaining({ target: 'bridge:session_remote_api' })])

    const updated = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers/${encodeURIComponent('bridge:session_remote_api')}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'outbound_only', last_error: 'viewer only' }),
    })).json() as any
    expect(updated.peer).toMatchObject({
      status: 'outbound_only',
      inboundEnabled: false,
      lastError: 'viewer only',
    })

    const removed = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers/${encodeURIComponent('session_remote_api')}`, { method: 'DELETE' })
    expect(await removed.json()).toMatchObject({ ok: true })
    const empty = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`)).json() as any
    expect(empty.peers).toEqual([])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge code session API creates sessions and stores worker credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-code-session-'))
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (String(input).endsWith('/v1/code/sessions')) {
        return Response.json({ session: { id: 'cse_bridge_api' } }, { status: 201 })
      }
      if (String(input).endsWith('/v1/code/sessions/cse_bridge_api/bridge')) {
        return Response.json({
          worker_jwt: 'worker.jwt',
          api_base_url: 'https://session-ingress.example/sdk/cse_bridge_api',
          expires_in: 3600,
          worker_epoch: '7',
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  try {
    const createBody = {
      title: 'Desktop bridge',
      tags: ['desktop', 'coding-agent'],
      bridge_remote: {
        base_url: 'https://remote.example',
        token: 'oauth-token',
      },
    }
    const created = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions`, {
      method: 'POST',
      body: JSON.stringify(createBody),
    })).json() as any
    expect(created).toMatchObject({ ok: true, sessionId: 'cse_bridge_api', status: 201 })
    expect(calls[0]).toMatchObject({
      url: 'https://remote.example/v1/code/sessions',
      body: { title: 'Desktop bridge', bridge: {}, tags: ['desktop', 'coding-agent'] },
      headers: expect.objectContaining({
        authorization: 'Bearer oauth-token',
        'anthropic-version': '2023-06-01',
      }),
    })

    const fetched = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_bridge_api')}/credentials`, {
      method: 'POST',
      body: JSON.stringify({
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'oauth-token',
        },
        trusted_device_token: 'trusted-device',
      }),
    })).json() as any
    expect(fetched).toMatchObject({
      ok: true,
      sessionId: 'cse_bridge_api',
      credentials: {
        sessionId: 'cse_bridge_api',
        workerJwt: 'worker.jwt',
        apiBaseUrl: 'https://session-ingress.example/sdk/cse_bridge_api',
        expiresIn: 3600,
        workerEpoch: 7,
      },
    })
    expect(calls[1]).toMatchObject({
      url: 'https://remote.example/v1/code/sessions/cse_bridge_api/bridge',
      body: {},
      headers: expect.objectContaining({
        authorization: 'Bearer oauth-token',
        'x-trusted-device-token': 'trusted-device',
      }),
    })
    const stored = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_bridge_api')}/credentials`)).json() as any
    expect(stored.credentials).toMatchObject({ sessionId: 'cse_bridge_api', workerEpoch: 7 })
    const peers = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`)).json() as any
    expect(peers.peers).toEqual([expect.objectContaining({ target: 'bridge:cse_bridge_api', status: 'outbound_only' })])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge worker API starts CCR worker transport and uploads events/state/delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-worker-'))
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (String(input).endsWith('/v1/code/sessions/cse_worker_api/bridge')) {
        return Response.json({
          worker_jwt: 'worker.jwt',
          api_base_url: 'https://session-ingress.example',
          expires_in: 3600,
          worker_epoch: 13,
        })
      }
      if (String(input).includes('/v1/code/sessions/cse_worker_api/worker/events/stream')) {
        const permissionFrame = {
          event_id: 'evt_stream_1',
          sequence_num: 1,
          event_type: 'control_request',
          source: 'remote',
          created_at: new Date().toISOString(),
          payload: {
            type: 'control_request',
            request_id: 'req_stream',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Write',
              tool_use_id: 'toolu_stream',
              input: { file_path: 'remote.ts' },
            },
          },
        }
        const userFrame = {
          event_id: 'evt_stream_2',
          sequence_num: 2,
          event_type: 'user',
          source: 'remote',
          created_at: new Date().toISOString(),
          payload: {
            type: 'user',
            uuid: 'uuid_worker_user',
            message: { content: '读取远端附件' },
            file_attachments: [{ file_uuid: 'worker-attach-1', file_name: '远端 文件.txt' }],
          },
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`id: 1\nevent: client_event\ndata: ${JSON.stringify(permissionFrame)}\n\nid: 2\nevent: client_event\ndata: ${JSON.stringify(userFrame)}\n\n`))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (String(input).includes('/api/oauth/files/worker-attach-1/content')) {
        return new Response('worker attachment')
      }
      return Response.json({})
    },
  })
  const codeBase = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_worker_api')}`
  try {
    await fetch(`${codeBase}/credentials`, {
      method: 'POST',
      body: JSON.stringify({
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'oauth-token',
        },
      }),
    })
    const started = await (await fetch(`${codeBase}/worker`, {
      method: 'POST',
      body: JSON.stringify({
        heartbeat_interval_ms: 60000,
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'oauth-token',
        },
      }),
    })).json() as any
    expect(started).toMatchObject({ ok: true, sessionId: 'cse_worker_api', workerEpoch: 13 })

    await fetch(`${codeBase}/worker/event`, {
      method: 'POST',
      body: JSON.stringify({ event: { type: 'assistant', session_id: 'cse_worker_api', parent_tool_use_id: null, message: { id: 'msg_1' } } }),
    })
    await fetch(`${codeBase}/worker/state`, {
      method: 'POST',
      body: JSON.stringify({
        state: 'requires_action',
        details: {
          tool_name: 'Bash',
          action_description: 'Running npm test',
          tool_use_id: 'toolu_1',
          request_id: 'req_1',
          input: { command: 'npm test' },
        },
      }),
    })
    await fetch(`${codeBase}/worker/delivery`, {
      method: 'POST',
      body: JSON.stringify({ event_id: 'evt_1', status: 'processed' }),
    })
    await fetch(`${codeBase}/worker/heartbeat`, { method: 'POST' })
    await fetch(`${codeBase}/worker/flush`, { method: 'POST' })

    expect(calls.some(call => call.url === 'https://session-ingress.example/v1/code/sessions/cse_worker_api/worker' && call.method === 'PUT' && call.body.worker_status === 'idle' && call.body.worker_epoch === 13)).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/events') && call.body.events[0].payload.type === 'assistant')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker') && call.body.worker_status === 'requires_action' && call.body.requires_action_details.request_id === 'req_1')).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/events/delivery') && call.body.updates.some((item: any) => item.event_id === 'evt_1'))).toBe(true)
    expect(calls.some(call => call.url.endsWith('/worker/events/delivery') && call.body.updates.some((item: any) => item.event_id === 'evt_stream_1' && item.status === 'processed'))).toBe(true)
    await waitFor(async () => calls.some(call => call.url.endsWith('/worker/events/delivery') && call.body.updates.some((item: any) => item.event_id === 'evt_stream_2' && item.status === 'processed')) ? true : null)
    expect(calls.some(call => call.url.endsWith('/worker/heartbeat') && call.body.session_id === 'cse_worker_api')).toBe(true)
    const pending = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('cse_worker_api')}/permissions?status=pending`)).json() as any
    expect(pending.permissions).toEqual([expect.objectContaining({ requestId: 'req_stream', toolName: 'Write' })])
    const inbound = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('cse_worker_api')}/inbound`)).json() as any
    expect(inbound.messages).toEqual([
      expect.objectContaining({
        uuid: 'uuid_worker_user',
        content: expect.stringContaining('读取远端附件'),
      }),
    ])
    expect(inbound.messages[0].content).toContain('@')
    expect(inbound.messages[0].resolvedPaths[0]).toContain(join(root, 'bridge-uploads', 'cse_worker_api'))
    const workerStatus = await (await fetch(`${codeBase}/worker`)).json() as any
    expect(workerStatus.stream).toMatchObject({ lastSequenceNum: 2 })
    const stopped = await (await fetch(`${codeBase}/worker`, { method: 'DELETE' })).json() as any
    expect(stopped).toMatchObject({ ok: true, sessionId: 'cse_worker_api' })
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge worker refresh refetches credentials, rebuilds epoch and resumes SSE sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-worker-refresh-'))
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  let bridgeCredentialCalls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (String(input).endsWith('/v1/code/sessions/cse_worker_refresh/bridge')) {
        bridgeCredentialCalls++
        return Response.json({
          worker_jwt: `worker.jwt.${bridgeCredentialCalls}`,
          api_base_url: 'https://session-ingress.example',
          expires_in: 3600,
          worker_epoch: bridgeCredentialCalls === 1 ? 13 : 14,
        })
      }
      if (String(input).includes('/v1/code/sessions/cse_worker_refresh/worker/events/stream')) {
        const sequence = String(input).includes('from_sequence_num=1') ? 2 : 1
        const frame = {
          event_id: `evt_stream_${sequence}`,
          sequence_num: sequence,
          event_type: 'assistant',
          source: 'remote',
          created_at: new Date().toISOString(),
          payload: { type: 'assistant', uuid: `msg_${sequence}`, message: { content: [] } },
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`id: ${sequence}\nevent: client_event\ndata: ${JSON.stringify(frame)}\n\n`))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({})
    },
  })
  const codeBase = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_worker_refresh')}`
  try {
    const body = {
      bridge_remote: {
        base_url: 'https://remote.example',
        token: 'oauth-token',
      },
    }
    await fetch(`${codeBase}/credentials`, { method: 'POST', body: JSON.stringify(body) })
    await fetch(`${codeBase}/worker`, { method: 'POST', body: JSON.stringify({ heartbeat_interval_ms: 60000 }) })
    await waitFor(async () => {
      const status = await (await fetch(`${codeBase}/worker`)).json() as any
      return status.stream?.lastSequenceNum === 1 ? status : null
    })
    const refreshed = await (await fetch(`${codeBase}/worker/refresh`, {
      method: 'POST',
      body: JSON.stringify({ ...body, heartbeat_interval_ms: 60000 }),
    })).json() as any
    expect(refreshed).toMatchObject({ ok: true, sessionId: 'cse_worker_refresh', workerEpoch: 14, initialSequenceNum: 1 })
    await waitFor(async () => {
      const status = await (await fetch(`${codeBase}/worker`)).json() as any
      return status.stream?.lastSequenceNum === 2 ? status : null
    })
    expect(calls.some(call => call.url === 'https://session-ingress.example/v1/code/sessions/cse_worker_refresh/worker' && call.body.worker_epoch === 14 && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
    expect(calls.some(call => call.url.includes('/worker/events/stream?from_sequence_num=1') && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge worker stream projects SDK assistant events into conversation event stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-worker-projection-'))
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, _init) => {
      if (String(input).endsWith('/v1/code/sessions/cse_worker_projection/bridge')) {
        return Response.json({
          worker_jwt: 'worker.jwt.projection',
          api_base_url: 'https://session-ingress.example',
          expires_in: 3600,
          worker_epoch: 41,
        })
      }
      if (String(input).includes('/v1/code/sessions/cse_worker_projection/worker/events/stream')) {
        const frames = [
          {
            event_id: 'evt_projection_1',
            sequence_num: 1,
            event_type: 'stream_event',
            source: 'remote',
            created_at: new Date().toISOString(),
            payload: {
              type: 'stream_event',
              session_id: 'cse_worker_projection',
              parent_tool_use_id: null,
              event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '远端流式片段' } },
            },
          },
          {
            event_id: 'evt_projection_2',
            sequence_num: 2,
            event_type: 'assistant',
            source: 'remote',
            created_at: new Date().toISOString(),
            payload: {
              type: 'assistant',
              session_id: 'cse_worker_projection',
              parent_tool_use_id: null,
              message: {
                content: [
                  { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: { file_path: 'remote.ts' } },
                  { type: 'text', text: '远端回答完成' },
                ],
              },
            },
          },
        ]
        return new Response(new ReadableStream({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(new TextEncoder().encode(`id: ${frame.sequence_num}\nevent: client_event\ndata: ${JSON.stringify(frame)}\n\n`))
            }
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({})
    },
  })
  const codeBase = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_worker_projection')}`
  try {
    const body = {
      conversationId: 'bridge-projection-conv',
      workspaceRoot: root,
      bridge_remote: { base_url: 'https://remote.example', token: 'oauth-token' },
      heartbeat_interval_ms: 60000,
    }
    await fetch(`${codeBase}/credentials`, { method: 'POST', body: JSON.stringify(body) })
    await fetch(`${codeBase}/worker`, { method: 'POST', body: JSON.stringify(body) })
    const events = await waitFor(async () => {
      const body = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/sessions/${encodeURIComponent('bridge-projection-conv')}/events`)).json() as any
      return body.events?.length >= 3 ? body.events : null
    }, 1500)
    expect(events.map((record: any) => record.event.type)).toEqual(expect.arrayContaining(['commentary', 'tool_call', 'final']))
    expect(events.some((record: any) => record.event.type === 'commentary' && record.event.text === '远端流式片段')).toBe(true)
    expect(events.some((record: any) => record.event.type === 'tool_call' && record.event.tool === 'Read')).toBe(true)
    expect(events.some((record: any) => record.event.type === 'final' && record.event.text === '远端回答完成')).toBe(true)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge worker schedules proactive refresh from expires_in and rebuilds stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-worker-auto-refresh-'))
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  let bridgeCredentialCalls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (String(input).endsWith('/v1/code/sessions/cse_worker_auto_refresh/bridge')) {
        bridgeCredentialCalls++
        return Response.json({
          worker_jwt: `worker.jwt.${bridgeCredentialCalls}`,
          api_base_url: 'https://session-ingress.example',
          expires_in: bridgeCredentialCalls === 1 ? 1 : 3600,
          worker_epoch: bridgeCredentialCalls === 1 ? 21 : 22,
        })
      }
      if (String(input).includes('/v1/code/sessions/cse_worker_auto_refresh/worker/events/stream')) {
        const sequence = String(input).includes('from_sequence_num=1') ? 2 : 1
        const frame = {
          event_id: `evt_stream_${sequence}`,
          sequence_num: sequence,
          event_type: 'assistant',
          source: 'remote',
          created_at: new Date().toISOString(),
          payload: { type: 'assistant', uuid: `msg_auto_${sequence}`, message: { content: [] } },
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`id: ${sequence}\nevent: client_event\ndata: ${JSON.stringify(frame)}\n\n`))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({})
    },
  })
  const codeBase = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_worker_auto_refresh')}`
  try {
    const body = {
      bridge_remote: {
        base_url: 'https://remote.example',
        token: 'oauth-token',
      },
      heartbeat_interval_ms: 60000,
      bridge_refresh_buffer_ms: 0,
      bridge_refresh_min_delay_ms: 10,
      bridge_refresh_retry_delay_ms: 10,
    }
    await fetch(`${codeBase}/credentials`, { method: 'POST', body: JSON.stringify(body) })
    await fetch(`${codeBase}/worker`, { method: 'POST', body: JSON.stringify(body) })
    const refreshed = await waitFor(async () => {
      const status = await (await fetch(`${codeBase}/worker`)).json() as any
      return status.workerEpoch === 22 && status.stream?.lastSequenceNum === 2 ? status : null
    }, 1500)
    expect(refreshed.refresh).toMatchObject({ enabled: true, lastCause: 'proactive_refresh', lastError: null })
    expect(bridgeCredentialCalls).toBeGreaterThanOrEqual(2)
    expect(calls.some(call => call.url === 'https://session-ingress.example/v1/code/sessions/cse_worker_auto_refresh/worker' && call.body.worker_epoch === 22 && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
    expect(calls.some(call => /\/worker\/events\/stream\?from_sequence_num=\d+/.test(call.url) && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge worker stream auth close refreshes credentials instead of dropping worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-worker-auth-refresh-'))
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  let bridgeCredentialCalls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      if (String(input).endsWith('/v1/code/sessions/cse_worker_auth_refresh/bridge')) {
        bridgeCredentialCalls++
        return Response.json({
          worker_jwt: `worker.jwt.${bridgeCredentialCalls}`,
          api_base_url: 'https://session-ingress.example',
          expires_in: 3600,
          worker_epoch: bridgeCredentialCalls === 1 ? 31 : 32,
        })
      }
      if (String(input).includes('/v1/code/sessions/cse_worker_auth_refresh/worker/events/stream')) {
        if (String(input).includes('from_sequence_num=1')) {
          const frame = {
            event_id: 'evt_stream_2',
            sequence_num: 2,
            event_type: 'assistant',
            source: 'remote',
            created_at: new Date().toISOString(),
            payload: { type: 'assistant', uuid: 'msg_auth_2', message: { content: [] } },
          }
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`id: 2\nevent: client_event\ndata: ${JSON.stringify(frame)}\n\n`))
              controller.close()
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('expired worker jwt', { status: 401 })
      }
      return Response.json({})
    },
  })
  const codeBase = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/code-sessions/${encodeURIComponent('cse_worker_auth_refresh')}`
  try {
    const body = {
      bridge_remote: {
        base_url: 'https://remote.example',
        token: 'oauth-token',
      },
      heartbeat_interval_ms: 60000,
      initial_sequence_num: 1,
    }
    await fetch(`${codeBase}/credentials`, { method: 'POST', body: JSON.stringify(body) })
    await fetch(`${codeBase}/worker`, { method: 'POST', body: JSON.stringify(body) })
    const recovered = await waitFor(async () => {
      const status = await (await fetch(`${codeBase}/worker`)).json() as any
      return status.workerEpoch === 32 && status.stream?.lastSequenceNum === 2 ? status : null
    }, 1500)
    expect(recovered.refresh).toMatchObject({ enabled: true, lastCause: 'auth_401_recovery', lastError: null })
    expect(bridgeCredentialCalls).toBeGreaterThanOrEqual(2)
    expect(calls.some(call => call.url === 'https://session-ingress.example/v1/code/sessions/cse_worker_auth_refresh/worker' && call.body.worker_epoch === 32 && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
    expect(calls.some(call => call.url.includes('/worker/events/stream?from_sequence_num=1') && call.headers.authorization === 'Bearer worker.jwt.2')).toBe(true)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge Remote Control event API stores permission requests and response outbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-remote-events-'))
  const bridgeServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_remote_events')}`
  try {
    const ingested = await (await fetch(`${base}/events`, {
      method: 'POST',
      body: JSON.stringify({
        event: {
          type: 'control_request',
          request_id: 'req_remote_write',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Write',
            tool_use_id: 'toolu_remote_write',
            input: { file_path: '/remote/repo/app.ts', content: 'hello' },
            display_name: 'Write',
            description: 'Remote session wants to write app.ts',
          },
        },
      }),
    })).json() as any
    expect(ingested.event).toMatchObject({
      sessionId: 'session_remote_events',
      type: 'control_request',
      kind: 'control_request',
    })
    expect(ingested.permission).toMatchObject({
      requestId: 'req_remote_write',
      toolName: 'Write',
      toolUseId: 'toolu_remote_write',
      status: 'pending',
      input: { file_path: '/remote/repo/app.ts', content: 'hello' },
    })

    const permissions = await (await fetch(`${base}/permissions?status=pending`)).json() as any
    expect(permissions.permissions).toEqual([
      expect.objectContaining({ requestId: 'req_remote_write', status: 'pending' }),
    ])

    const responded = await (await fetch(`${base}/permissions/${encodeURIComponent('req_remote_write')}/respond`, {
      method: 'POST',
      body: JSON.stringify({
        behavior: 'allow',
        updated_input: { file_path: '/remote/repo/app.ts', content: 'hello', reviewed: true },
      }),
    })).json() as any
    expect(responded.permission).toMatchObject({
      requestId: 'req_remote_write',
      status: 'allowed',
      response: {
        behavior: 'allow',
        updatedInput: { file_path: '/remote/repo/app.ts', content: 'hello', reviewed: true },
      },
    })
    expect(responded.outbox).toMatchObject({
      requestId: 'req_remote_write',
      status: 'queued',
      payload: {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_remote_write',
          response: {
            behavior: 'allow',
            updatedInput: { file_path: '/remote/repo/app.ts', content: 'hello', reviewed: true },
          },
        },
      },
    })

    const outbox = await (await fetch(`${base}/outbox?status=queued`)).json() as any
    expect(outbox.outbox).toHaveLength(1)
    const sent = await (await fetch(`${base}/outbox/${encodeURIComponent(outbox.outbox[0].id)}/sent`, { method: 'POST' })).json() as any
    expect(sent.outbox).toMatchObject({ requestId: 'req_remote_write', status: 'sent' })
    const empty = await (await fetch(`${base}/outbox?status=queued`)).json() as any
    expect(empty.outbox).toEqual([])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge inbound resolve API downloads attachments and stores resolved user prompts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-inbound-resolve-'))
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
      return new Response('remote attachment')
    },
  })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_inbound_resolve')}`
  try {
    const resolved = await (await fetch(`${base}/inbound/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'oauth-token',
        },
        event: {
          type: 'user',
          uuid: 'uuid_server_inbound',
          message: { content: [{ type: 'text', text: '帮我读附件' }] },
          file_attachments: [{ file_uuid: 'attach-123456', file_name: '../报价 单.md' }],
        },
      }),
    })).json() as any
    expect(calls[0]).toMatchObject({
      url: 'https://remote.example/api/oauth/files/attach-123456/content',
      headers: { authorization: 'Bearer oauth-token' },
    })
    expect(resolved.resolved).toMatchObject({
      uuid: 'uuid_server_inbound',
      bridgeOrigin: true,
      skipSlashCommands: true,
      attachments: [{ file_uuid: 'attach-123456', file_name: '../报价 单.md' }],
    })
    expect(resolved.message).toMatchObject({
      sessionId: 'session_inbound_resolve',
      seq: 1,
      uuid: 'uuid_server_inbound',
    })
    expect(resolved.message.content.at(-1).text).toContain('帮我读附件')
    expect(resolved.message.content.at(-1).text).toContain('@')
    expect(existsSync(resolved.resolved.resolvedPaths[0])).toBe(true)

    const listed = await (await fetch(`${base}/inbound`)).json() as any
    expect(listed.messages).toEqual([
      expect.objectContaining({ uuid: 'uuid_server_inbound', seq: 1 }),
    ])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge inbound resolve can auto-run resolved prompt through the agent task stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-inbound-autorun-'))
  const sentBodies: any[] = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.includes('/api/oauth/files/auto-attach/content')) return new Response('auto attachment')
      sentBodies.push(JSON.parse(String(init?.body)))
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '自动处理完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_inbound_auto')}`
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')
    const started = await (await fetch(`${base}/inbound/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        auto_run: true,
        conversationId: 'bridge-auto-conv',
        working_dir: root,
        permissionMode: 'full',
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'oauth-token',
        },
        event: {
          type: 'user',
          uuid: 'uuid_auto_inbound',
          message: {
            content: [
              { type: 'image', source: { type: 'base64', data: png } },
              { type: 'text', text: '请分析这张图和附件' },
            ],
          },
          file_attachments: [{ file_uuid: 'auto-attach', file_name: 'note.txt' }],
        },
      }),
    })).json() as any
    expect(started.dispatch).toMatchObject({ mode: 'task', conversationId: 'bridge-auto-conv', status: 'running' })
    const taskId = started.dispatch.task_id
    const events = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks/${taskId}/events?after=-1`)
    const text = await events.text()
    expect(text).toContain('自动处理完成')
    expect(text).toContain('"type":"done"')
    expect(sentBodies).toHaveLength(1)
    const requestText = JSON.stringify(sentBodies[0].messages)
    expect(requestText).toContain('data:image/png;base64,')
    expect(requestText).toContain('请分析这张图和附件')
    expect(requestText).toContain('note.txt')
    expect(requestText).toContain('@')
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge inbound auto-run expands bridge-safe prompt slash commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-inbound-command-'))
  const commandsRoot = join(root, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  await Bun.write(join(commandsRoot, 'daily.md'), `---
name: daily-report
description: 写日报
---
按桥接资料生成日报。
`)
  let sentBody: any
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_input, init) => {
      sentBody = JSON.parse(String(init?.body))
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '桥接日报完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/session_bridge_command`
    const started = await (await fetch(`${base}/inbound/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        auto_run: true,
        conversationId: 'bridge-command-conv',
        working_dir: root,
        permissionMode: 'full',
        event: {
          type: 'user',
          uuid: 'uuid_bridge_command',
          message: { content: '/daily-report 今天' },
        },
      }),
    })).json() as any
    expect(started.dispatch).toMatchObject({ mode: 'task', conversationId: 'bridge-command-conv', status: 'running' })
    const events = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks/${started.dispatch.task_id}/events?after=-1`)
    const text = await events.text()
    expect(text).toContain('已展开命令 /daily-report 今天')
    expect(text).toContain('桥接日报完成')
    const requestText = JSON.stringify(sentBody.messages)
    expect(requestText).toContain('命令: /daily-report')
    expect(requestText).toContain('按桥接资料生成日报')
    expect(requestText).toContain('今天')
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge inbound auto-run blocks known unsafe local slash commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-inbound-unsafe-command-'))
  let fetchCalls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('model should not be called for unsafe bridge command')
    },
  })
  try {
    const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/session_bridge_unsafe`
    const started = await (await fetch(`${base}/inbound/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        auto_run: true,
        conversationId: 'bridge-unsafe-conv',
        working_dir: root,
        permissionMode: 'full',
        event: {
          type: 'user',
          uuid: 'uuid_bridge_unsafe',
          message: { content: '/goal clear' },
        },
      }),
    })).json() as any
    expect(started.dispatch).toMatchObject({ mode: 'task', conversationId: 'bridge-unsafe-conv', status: 'running' })
    const events = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks/${started.dispatch.task_id}/events?after=-1`)
    const text = await events.text()
    expect(text).toContain("/goal isn't available over Remote Control.")
    expect(text).toContain('"type":"done"')
    expect(fetchCalls).toBe(0)
    const transcript = await new SessionService(root).loadTranscript('bridge-unsafe-conv')
    expect(JSON.stringify(transcript)).not.toContain('<command-name>/goal</command-name>')
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge inbound resolve steers a running conversation instead of starting a duplicate turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-inbound-steer-'))
  let calls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_input, _init) => {
      calls++
      const enc = new TextEncoder()
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ask_bridge', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '等远端补充吗', options: [{ label: '继续' }] }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '收到远端补充' }, finish_reason: 'stop' }] }
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const running = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks`, {
      method: 'POST',
      body: JSON.stringify({ message: '先做主任务', conversation_id: 'bridge-steer-conv', working_dir: root, permission_mode: 'full' }),
    })
    const runningBody = await running.json() as any
    const eventStream = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks/${runningBody.task_id}/events?after=-1`)
    const reader = eventStream.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 200; i++) {
        if (text.includes(needle)) return
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      throw new Error(`SSE stream did not contain ${needle}; got ${text}`)
    }
    await readUntil('"type":"ask_question"')
    const inbound = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/session_inbound_steer/inbound/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        conversationId: 'bridge-steer-conv',
        event: {
          type: 'user',
          uuid: 'uuid_steer_inbound',
          message: { content: '远端补充:先查 tests' },
        },
      }),
    })).json() as any
    expect(inbound.dispatch).toMatchObject({ mode: 'steering', conversationId: 'bridge-steer-conv' })
    const answered = await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/tasks/${runningBody.task_id}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: '继续' }),
    })
    expect(answered.status).toBe(200)
    await readUntil('"type":"done"')
    expect(text).toContain('远端补充:先查 tests')
    expect(text).toContain('收到远端补充')
    expect(calls).toBe(2)
    await reader.cancel().catch(() => undefined)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge Remote Control outbox flush posts control responses to session events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-outbox-flush-'))
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return new Response('', { status: 204 })
    },
  })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_remote_flush')}`
  try {
    await fetch(`${base}/events`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'control_request',
        request_id: 'req_flush',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'toolu_flush',
          input: { command: 'pwd' },
        },
      }),
    })
    await fetch(`${base}/permissions/${encodeURIComponent('req_flush')}/respond`, {
      method: 'POST',
      body: JSON.stringify({ behavior: 'deny', message: 'not now' }),
    })
    const flushed = await (await fetch(`${base}/outbox/flush`, {
      method: 'POST',
      body: JSON.stringify({
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'worker-token',
          beta_header: '',
        },
      }),
    })).json() as any
    expect(flushed).toMatchObject({ ok: true, flushed: 1, total: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://remote.example/v1/sessions/session_remote_flush/events')
    expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer worker-token' })
    expect(calls[0]!.headers['anthropic-beta']).toBeUndefined()
    expect(calls[0]!.body).toEqual({
      events: [{
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_flush',
          response: { behavior: 'deny', message: 'not now' },
        },
      }],
    })
    const queued = await (await fetch(`${base}/outbox?status=queued`)).json() as any
    expect(queued.outbox).toEqual([])
    const sent = await (await fetch(`${base}/outbox?status=sent`)).json() as any
    expect(sent.outbox).toEqual([expect.objectContaining({ requestId: 'req_flush', status: 'sent' })])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge Remote Control subscribe API stores WebSocket SDK/control messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-subscribe-'))
  FakeBridgeWebSocket.instances = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    bridgeWebSocketCtor: FakeBridgeWebSocket as any,
  })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_subscribe')}`
  try {
    const started = await (await fetch(`${base}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'token',
          org_uuid: 'org_sub',
        },
      }),
    })).json() as any
    expect(started).toMatchObject({ ok: true, sessionId: 'session_subscribe' })
    expect(FakeBridgeWebSocket.instances).toHaveLength(1)
    const ws = FakeBridgeWebSocket.instances[0]!
    expect(ws.url).toBe('wss://remote.example/v1/sessions/ws/session_subscribe/subscribe?organization_uuid=org_sub')
    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({
      type: 'control_request',
      request_id: 'req_subscribe',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        tool_use_id: 'toolu_subscribe',
        input: { file_path: 'remote.ts' },
      },
    }) })

    const permissions = await waitFor(async () => {
      const body = await (await fetch(`${base}/permissions?status=pending`)).json() as any
      return body.permissions.length === 1 ? body : null
    })
    expect(permissions.permissions).toEqual([
      expect.objectContaining({ requestId: 'req_subscribe', toolName: 'Write', status: 'pending' }),
    ])
    const subscribers = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/subscribers`)).json() as any
    expect(subscribers.subscribers).toEqual([expect.objectContaining({ sessionId: 'session_subscribe', connected: true })])

    const stopped = await (await fetch(`${base}/subscribe`, { method: 'DELETE' })).json() as any
    expect(stopped).toMatchObject({ ok: true, sessionId: 'session_subscribe' })
    expect(ws.closed).toBe(true)
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('bridge Remote Control subscriber projects SDK assistant messages into conversation events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-subscribe-projection-'))
  FakeBridgeWebSocket.instances = []
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    bridgeWebSocketCtor: FakeBridgeWebSocket as any,
  })
  const base = `http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/sessions/${encodeURIComponent('session_subscribe_projection')}`
  try {
    await fetch(`${base}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({
        conversationId: 'bridge-subscribe-projection-conv',
        workspaceRoot: root,
        bridge_remote: {
          base_url: 'https://remote.example',
          token: 'token',
        },
      }),
    })
    const ws = FakeBridgeWebSocket.instances[0]!
    ws.emit('open')
    ws.emit('message', { data: JSON.stringify({
      type: 'assistant',
      session_id: 'session_subscribe_projection',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '订阅远端回答' }] },
    }) })

    const events = await waitFor(async () => {
      const body = await (await fetch(`http://127.0.0.1:${bridgeServer.port}/sessions/${encodeURIComponent('bridge-subscribe-projection-conv')}/events`)).json() as any
      return body.events?.length ? body.events : null
    })
    expect(events).toEqual([
      expect.objectContaining({ event: { type: 'final', text: '订阅远端回答' } }),
    ])
  } finally {
    bridgeServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes registered bridge peers through ListPeers', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-bridge-peers-'))
  let calls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_peers', function: { name: 'ListPeers', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '已看到 bridge peer' }, finish_reason: 'stop' }] }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'session_bridge_run', status: 'connected', inbound_enabled: true }),
    })
    const res = await fetch(`http://127.0.0.1:${bridgeServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '列出 bridge peer',
        conversationId: 'bridge-peer-list-run',
        permissionMode: 'full',
      }),
    })
    const text = await res.text()
    expect(text).toContain('event: tool_call')
    expect(text).toContain('ListPeers')
    expect(text).toContain('bridge_peer_count')
    expect(text).toContain('bridge_targets')
    expect(text).toContain('bridge:session_bridge_run')
    expect(text).toContain('已看到 bridge peer')
    expect(calls).toBe(2)
  } finally {
    bridgeServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run sends bridge messages without approval in full access mode', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-bridge-send-'))
  const remoteCalls: Array<{ url: string; body: any }> = []
  let modelCalls = 0
  const bridgeServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      DEEPSEEK_BASE_URL: 'https://model.example/v1',
      DEEPSEEK_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
      BRIDGE_REMOTE_BASE_URL: 'https://remote.example',
      BRIDGE_REMOTE_TOKEN: 'remote-token',
    },
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.includes('/v1/sessions/')) {
        remoteCalls.push({ url, body: JSON.parse(String(init?.body)) })
        return new Response('{}', { status: 201 })
      }
      modelCalls++
      const payload = modelCalls === 1
        ? {
            id: 'x',
            model: 'mimo-v2.5',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_send_bridge',
                  function: {
                    name: 'SendMessage',
                    arguments: JSON.stringify({ to: 'bridge:session_bridge_send', message: 'please inspect status' }),
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '已发送远端消息' }, finish_reason: 'stop' }] }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    await fetch(`http://127.0.0.1:${bridgeServer.port}/api/v1/agent/bridge/peers`, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'session_bridge_send', status: 'connected', inbound_enabled: true }),
    })
    const res = await fetch(`http://127.0.0.1:${bridgeServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '给远端会话发消息',
        conversationId: 'bridge-send-run',
        permissionMode: 'bypassPermissions',
      }),
    })
    const text = await res.text()
    expect(text).not.toContain('event: approval_request')
    expect(text).toContain('已发送远端消息')
    expect(remoteCalls).toHaveLength(1)
    expect(remoteCalls[0]!.url).toBe('https://remote.example/v1/sessions/session_bridge_send/events')
    expect(remoteCalls[0]!.body).toMatchObject({
      events: [{
        session_id: 'session_bridge_send',
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'please inspect status' },
      }],
    })
  } finally {
    bridgeServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run injects workspace project instructions into the model system prompt', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-instructions-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-instructions-working-'))
  writeFileSync(join(workingRoot, 'BILLIARDBUDDY.md'), 'Always run the nearest typecheck before final.')
  let systemPrompt = ''
  const instructionServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ role: string; content: string }> }
      systemPrompt = body.messages?.find(m => m.role === 'system')?.content ?? ''
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${instructionServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '看项目规约', working_dir: workingRoot, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    // 新注入格式 = cc getClaudeMds(四层记忆),不再是旧的 <project_instruction> XML。
    expect(systemPrompt).toContain('These instructions OVERRIDE any default behavior')
    expect(systemPrompt).toContain('(project instructions, checked into the codebase)')
    expect(systemPrompt).toContain('Always run the nearest typecheck before final.')
  } finally {
    instructionServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run injects AutoMem memdir MEMORY.md into the model system prompt', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-memory-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-memory-working-'))
  const configDir = mkdtempSync(join(tmpdir(), 'agent-memory-config-'))
  // 先把 memdir 根指到临时 configDir,再按 workspace.root(= working_dir)派生记忆目录并写索引,
  // 验证 /agent/run 会读回注入。顺序很重要:getAutoMemDir 依赖 BILLIARDBUDDY_CONFIG_DIR。
  const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = configDir
  const memoryDir = getAutoMemDir(workingRoot)
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# MEMORY\n\n- [黄金档台费](golden_pricing.md) — 黄金档台费 68 元一小时,会员充值满 1000 送 120。\n')
  let systemPrompt = ''
  const memoryServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ role: string; content: string }> }
      systemPrompt = body.messages?.find(m => m.role === 'system')?.content ?? ''
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const base = `http://127.0.0.1:${memoryServer.port}`
    const res = await fetch(`${base}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '黄金档台费多少', working_dir: workingRoot, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(systemPrompt).toContain("auto-memory, persists across conversations")
    expect(systemPrompt).toContain('黄金档台费 68 元')
  } finally {
    memoryServer.stop(true)
    if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('POST /agent/run 域包上下文每回合直接进系统提示(不再骑 SessionStart hook,对齐 cc:SessionStart 只首回合)', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-pack-transcript-'))
  let systemPrompt = ''
  const packServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { messages?: Array<{ role: string; content: string }> }
      systemPrompt = body.messages?.find(m => m.role === 'system')?.content ?? ''
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${packServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '写一份活动方案', knowledge_packs: ['billiards'], permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    // 域包上下文每回合直接进系统提示(extraContext),不再走 SessionStart hook_context 块(那会让 SessionStart 每回合重触发)
    expect(systemPrompt).toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(systemPrompt).not.toContain('<hook_context event="SessionStart">') // 域包不再骑 hook
    expect(systemPrompt).toContain('/台球')
    expect(systemPrompt).toContain('billiards_knowledge_search')
    expect(systemPrompt).not.toContain('/billiards:daily-ops')
  } finally {
    packServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes domain pack tools only when the pack is enabled', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-pack-tools-transcript-'))
  const toolsByCall: string[][] = []
  const packServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as { tools?: Array<{ function?: { name?: string } }> }
      toolsByCall.push((body.tools ?? []).map(tool => tool.function?.name || '').filter(Boolean))
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const generic = await fetch(`http://127.0.0.1:${packServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '普通 coding 问题', knowledge_packs: [], permissionMode: 'full' }),
    })
    expect(generic.status).toBe(200)
    await generic.text()

    const enabled = await fetch(`http://127.0.0.1:${packServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '台球周末活动怎么做', knowledge_packs: ['billiards'], permissionMode: 'full' }),
    })
    expect(enabled.status).toBe(200)
    await enabled.text()

    expect(toolsByCall[0]).not.toContain('billiards_knowledge_search')
    expect(toolsByCall[1]).toContain('billiards_knowledge_search')
  } finally {
    packServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run keeps domain packs isolated per session and removes all pack contributions after explicit disable', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-pack-session-state-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-pack-session-workspace-'))
  const calls = new Map<string, { systemPrompt: string; tools: string[] }>()
  const packServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ role: string; content: string }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const toolNames = (body.tools ?? []).map(tool => tool.function?.name ?? '').filter(Boolean)
      const userMessage = body.messages?.filter(message => message.role === 'user').at(-1)?.content ?? ''
      if (toolNames.includes('run_command') && userMessage.startsWith('PACK_STATE_')) {
        calls.set(userMessage, {
          systemPrompt: body.messages?.find(message => message.role === 'system')?.content ?? '',
          tools: toolNames,
        })
      }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const run = async (conversationId: string, message: string, enabledPacks?: string[]) => {
    const res = await fetch(`http://127.0.0.1:${packServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message,
        conversationId,
        working_dir: workspaceRoot,
        permissionMode: 'full',
        ...(enabledPacks === undefined ? {} : { enabled_packs: enabledPacks }),
      }),
    })
    expect(res.status).toBe(200)
    await res.text()
  }

  try {
    await run('pack-session-a', 'PACK_STATE_A_ENABLED', ['billiards'])
    await run('pack-session-b', 'PACK_STATE_B_DISABLED', [])
    await run('pack-session-a', 'PACK_STATE_A_INHERITED')
    await run('pack-session-a', 'PACK_STATE_A_DISABLED', [])

    const enabled = calls.get('PACK_STATE_A_ENABLED')!
    const isolated = calls.get('PACK_STATE_B_DISABLED')!
    const inherited = calls.get('PACK_STATE_A_INHERITED')!
    const disabled = calls.get('PACK_STATE_A_DISABLED')!
    expect(calls.size).toBe(4)
    expect(enabled.systemPrompt).toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(enabled.systemPrompt).toContain('\n- /台球')
    expect(enabled.tools).toContain('billiards_knowledge_search')

    expect(isolated.systemPrompt).not.toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(isolated.tools).not.toContain('billiards_knowledge_search')

    expect(inherited.systemPrompt).toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(inherited.tools).toContain('billiards_knowledge_search')

    expect(disabled.systemPrompt).not.toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(disabled.systemPrompt).not.toContain('\n- /台球')
    expect(disabled.tools).not.toContain('billiards_knowledge_search')
    expect(await new SessionService(transcriptRoot).get('pack-session-a')).toMatchObject({ enabledPacks: [] })
  } finally {
    packServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run does not prescribe skills from an enabled knowledge pack', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-pack-skills-transcript-'))
  const skillsRoot = join(transcriptRoot, 'skills')
  mkdirSync(join(skillsRoot, 'daily-report'), { recursive: true })
  writeFileSync(join(skillsRoot, 'daily-report', 'SKILL.md'), `---
name: daily-report
description: Write daily store reports
---
Daily report instructions.
`)
  mkdirSync(join(skillsRoot, 'generic'), { recursive: true })
  writeFileSync(join(skillsRoot, 'generic', 'SKILL.md'), `---
name: generic-helper
description: Generic helper
---
Generic instructions.
`)
  const sentBodies: any[] = []
  let calls = 0
  const packServer = startServer({
    port: 0,
    transcriptRoot,
    skillsRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(String(init?.body || '{}')))
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_skills', function: { name: 'list_skills', arguments: JSON.stringify({ recommended_only: true }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${packServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '找适合台球运营日报的技能', knowledge_packs: ['billiards'], permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('当前没有匹配技能')
    expect(text).not.toContain('daily-report [推荐]')
    expect(text).not.toContain('generic-helper')
    expect(calls).toBe(2)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'list_skills')).toBe(true)
    expect(JSON.stringify(sentBodies[1].messages)).not.toContain('已启用领域包推荐技能优先展示')
  } finally {
    packServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run executes context fork skills through use_skill as background workers', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-context-fork-skill-'))
  const skillsRoot = join(transcriptRoot, 'skills')
  mkdirSync(join(skillsRoot, 'poster-maker'), { recursive: true })
  writeFileSync(join(skillsRoot, 'poster-maker', 'SKILL.md'), `---
name: poster-maker
description: Make posters
context: fork
allowedTools: [read_file]
hooks:
  SubagentStart:
    - matcher: skill-poster-maker
      hooks:
        - decision:
            action: context
            additionalContext: skill fork start hook
---
Plan the poster production workflow.
`)
  await new SessionService(transcriptRoot).transcript('skill-fork-run', transcriptRoot).save([
    { role: 'user', content: [textBlock('父级上下文不应进入 skill worker')] },
  ])
  const sentBodies: any[] = []
  let outerCalls = 0
  const skillServer = startServer({
    port: 0,
    transcriptRoot,
    skillsRoot,
    agentsRoot: join(transcriptRoot, 'agents'),
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'))
      sentBodies.push(body)
      const system = String(body.messages?.[0]?.content ?? '')
      if (system.includes('<background_subagent name="skill-poster-maker">')) {
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'Skill worker complete' }, finish_reason: 'stop' }] })
      }
      const payload = outerCalls++ === 0
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_skill', function: { name: 'use_skill', arguments: JSON.stringify({ skill: 'poster-maker', args: '周末活动' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'skill launched' }, finish_reason: 'stop' }] }
      return sseResponse(payload)
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${skillServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '用海报技能规划活动',
        conversationId: 'skill-fork-run',
        workspaceRoot: transcriptRoot,
        permissionMode: 'full',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('use_skill')
    expect(text).toContain('background_task_started')
    expect(text).toContain('skill launched')

    const taskId = text.match(/id=\\?"([^"\\]+)\\?"/)?.[1]
    expect(taskId).toBeTruthy()
    if (!taskId) throw new Error('missing skill fork task id')
    const done = await waitFor(async () => {
      const detail = await fetch(`http://127.0.0.1:${skillServer.port}/tasks/${taskId}`)
      const body = await detail.json() as { task?: { status: string; result?: unknown; params?: Record<string, unknown> } }
      return body.task?.status === 'completed' ? body.task : null
    }, 2500)
    expect(done.params).toMatchObject({
      agent: 'skill-poster-maker',
      skill: 'poster-maker',
      skill_context: 'fork',
      task: expect.stringContaining('Plan the poster production workflow'),
    })
    expect(done.result).toBe('Skill worker complete')

    const outerRequest = sentBodies[0]
    expect(outerRequest.tools.some((tool: any) => tool.function.name === 'use_skill')).toBe(true)
    const workerRequest = sentBodies.find(body => String(body.messages?.[0]?.content ?? '').includes('<background_subagent name="skill-poster-maker">'))
    expect(workerRequest).toBeTruthy()
    const workerJson = JSON.stringify(workerRequest)
    expect(workerJson).toContain('技能: poster-maker')
    expect(workerJson).toContain('Plan the poster production workflow')
    expect(workerJson).toContain('用户给这个技能的参数')
    expect(workerJson).toContain('周末活动')
    expect(workerJson).toContain('skill fork start hook')
    expect(workerJson).not.toContain('父级上下文不应进入 skill worker')
    expect(workerRequest.tools.map((tool: any) => tool.function.name)).toEqual(['read_file'])
  } finally {
    skillServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run persists inline skill hooks across turns in one conversation', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-skill-hooks-persist-'))
  const skillsRoot = join(transcriptRoot, 'skills')
  mkdirSync(join(skillsRoot, 'guarded-writer'), { recursive: true })
  writeFileSync(join(skillsRoot, 'guarded-writer', 'SKILL.md'), `---
name: guarded-writer
description: Register persistent write guard
hooks:
  PreToolUse:
    - matcher: write_file
      hooks:
        - decision:
            action: deny
            message: persisted skill hook blocked write
---
Use this skill to guard writes.
`)
  const payloads = [
    { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_skill', function: { name: 'use_skill', arguments: JSON.stringify({ skill: 'guarded-writer' }) } }] }, finish_reason: 'tool_calls' }] },
    { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'guard armed' }, finish_reason: 'stop' }] },
    { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'write_1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'blocked.txt', content: 'bad' }) } }] }, finish_reason: 'tool_calls' }] },
    { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'write checked' }, finish_reason: 'stop' }] },
  ]
  const server = startServer({
    port: 0,
    transcriptRoot,
    skillsRoot,
    agentsRoot: join(transcriptRoot, 'agents'),
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => sseResponse(payloads.shift()!),
  })
  try {
    const first = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '启用写入保护技能',
        conversationId: 'skill-hooks-persist',
        workspaceRoot: transcriptRoot,
        permissionMode: 'full',
      }),
    })
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('guard armed')

    const second = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '现在写 blocked.txt',
        conversationId: 'skill-hooks-persist',
        workspaceRoot: transcriptRoot,
        permissionMode: 'full',
      }),
    })
    expect(second.status).toBe(200)
    const text = await second.text()
    expect(text).toContain('[hook 拦截] persisted skill hook blocked write')
    expect(existsSync(join(transcriptRoot, 'blocked.txt'))).toBe(false)
  } finally {
    server.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run lets tools read files explicitly selected outside the workspace', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-selected-file-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-selected-file-working-'))
  const externalRoot = mkdtempSync(join(tmpdir(), 'agent-selected-file-external-'))
  const picked = join(externalRoot, 'picked.txt')
  writeFileSync(picked, 'SELECTED_EXTERNAL_CONTENT')
  let calls = 0
  const selectedServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const enc = new TextEncoder()
      const lines = calls === 1
        ? [
            JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: JSON.stringify({ path: picked }) } }] }, finish_reason: 'tool_calls' }] }),
            '[DONE]',
          ]
        : [
            JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '读到了' }, finish_reason: 'stop' }] }),
            '[DONE]',
          ]
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          for (const line of lines) c.enqueue(enc.encode(`data: ${line}\n\n`))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${selectedServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '读取我选中的文件',
        working_dir: workingRoot,
        selected_files: [picked],
        permissionMode: 'full',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: tool_result')
    expect(text).toContain('SELECTED_EXTERNAL_CONTENT')
  } finally {
    selectedServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run keeps working_dir as command cwd while desktop full disk can read external absolute paths', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-full-disk-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-full-disk-working-'))
  const externalRoot = mkdtempSync(join(tmpdir(), 'agent-full-disk-external-'))
  const externalFile = join(externalRoot, 'outside.txt')
  writeFileSync(externalFile, 'FULL_DISK_EXTERNAL_CONTENT')
  let calls = 0
  const fullDiskServer = startServer({
    port: 0,
    transcriptRoot,
    mcpConfigPath: join(transcriptRoot, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const enc = new TextEncoder()
      const lines = calls === 1
        ? [
            JSON.stringify({
              id: 'x',
              model: 'mimo-v2.5',
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'pwd_1', function: { name: 'run_command', arguments: JSON.stringify({ command: 'pwd' }) } },
                    { index: 1, id: 'read_1', function: { name: 'read_file', arguments: JSON.stringify({ path: externalFile }) } },
                  ],
                },
                finish_reason: 'tool_calls',
              }],
            }),
            '[DONE]',
          ]
        : [
            JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '完成' }, finish_reason: 'stop' }] }),
            '[DONE]',
          ]
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          for (const line of lines) c.enqueue(enc.encode(`data: ${line}\n\n`))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${fullDiskServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '确认工作目录并读取外部文件',
        working_dir: workingRoot,
        full_disk_access: true,
        permissionMode: 'bypassPermissions',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: tool_result')
    expect(text).toContain(workingRoot)
    expect(text).toContain('FULL_DISK_EXTERNAL_CONTENT')
  } finally {
    fullDiskServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('POST /agent/prewarm resolves provider and loads local capabilities without calling the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-prewarm-'))
  const skillsRoot = join(root, 'skills')
  const commandsRoot = join(root, 'commands')
  const agentsRoot = join(root, 'agents')
  const hooksPath = join(root, 'hooks.json')
  await Bun.write(join(skillsRoot, 'daily', 'SKILL.md'), `---
description: Daily skill
---
Use daily skill.
`)
  await Bun.write(join(commandsRoot, 'daily.md'), `---
description: Daily command
---
Use daily command.
`)
  await Bun.write(join(agentsRoot, 'researcher.md'), `---
description: Researcher
---
Research.
`)
  writeFileSync(hooksPath, JSON.stringify({
    hooks: [{ event: 'SessionStart', decision: { action: 'context', additionalContext: 'warm' } }],
  }))
  const prewarmServer = startServer({
    port: 0,
    transcriptRoot: root,
    skillsRoot,
    commandsRoot,
    agentsRoot,
    hooksPath,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      throw new Error('prewarm should not call model provider')
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${prewarmServer.port}/agent/prewarm`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'prewarm-session', workspaceRoot: root }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    // 白标:出口摘要只给能力档代称,不外露真实 model。
    expect(body.provider.summary).toMatchObject({ hasApiKey: true })
    expect(body.provider.summary.model).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('mimo')
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(body.skills.count).toBe(1)
    expect(body.commands.count).toBe(1)
    expect(body.hooks.count).toBe(1)
    expect(body.agents.count).toBe(1)

    const session = await (await fetch(`http://127.0.0.1:${prewarmServer.port}/sessions/prewarm-session`)).json() as any
    expect(session.session).toMatchObject({ id: 'prewarm-session', status: 'idle', workspaceRoot: root })
  } finally {
    prewarmServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/prewarm returns 503 when provider is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-prewarm-missing-'))
  const prewarmServer = startServer({ port: 0, transcriptRoot: root, providerRoot: root, env: {} })
  try {
    const res = await fetch(`http://127.0.0.1:${prewarmServer.port}/agent/prewarm`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false, error: 'model provider not configured' })
  } finally {
    prewarmServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('WS /agent/ws runs a turn and replays persisted events after disconnect', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-ws-'))
  let calls = 0
  const wsServer = startServer({
    port: 0,
    transcriptRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_dir', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ws 完成' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const client = wsClient(`ws://127.0.0.1:${wsServer.port}/agent/ws?conversationId=ws-run`)
  try {
    await client.opened
    expect(await client.next()).toMatchObject({ type: 'ready', conversationId: 'ws-run' })
    client.ws.send(JSON.stringify({ type: 'run', message: '列目录', permissionMode: 'full' }))
    const events = await collectWsEvents(client)
    // content_delta 是实时 token 流(不持久化),从结构断言里过滤掉
    expect(events.map(e => e.event?.type).filter((t): t is string => Boolean(t) && t !== 'content_delta')).toEqual(['user_prompt', 'tool_call', 'tool_result', 'final', 'done'])
    expect(JSON.stringify(events)).toContain('ws 完成')
    expect(events.every(e => e.type !== 'event' || e.event?.type === 'content_delta' || e.seq > 0)).toBe(true)
    client.close()

    const replay = wsClient(`ws://127.0.0.1:${wsServer.port}/agent/ws?conversationId=ws-run&after=2`)
    await replay.opened
    expect(await replay.next()).toMatchObject({ type: 'ready', conversationId: 'ws-run' })
    const replayed = [await replay.next(), await replay.next(), await replay.next()]
    expect(replayed.map(e => e.event?.type)).toEqual(['tool_result', 'final', 'done'])
    expect(replayed.every(e => e.replay === true)).toBe(true)
    replay.close()
  } finally {
    wsServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('GET/POST /api/settings 读写 App 用户设置(默认权限档/主题)', async () => {
  const got = await (await fetch(`http://127.0.0.1:${server.port}/api/settings`)).json() as any
  expect(got.settings.defaultPermissionMode).toBe('default')
  const updated = await (await fetch(`http://127.0.0.1:${server.port}/api/settings`, { method: 'POST', body: JSON.stringify({ defaultPermissionMode: 'acceptEdits', theme: 'dark' }) })).json() as any
  expect(updated.settings.defaultPermissionMode).toBe('acceptEdits')
  expect(updated.settings.theme).toBe('dark')
  // 持久化:再 GET 读到更新后的
  const reread = await (await fetch(`http://127.0.0.1:${server.port}/api/settings`)).json() as any
  expect(reread.settings.defaultPermissionMode).toBe('acceptEdits')
})

test('sidecar 不再服务已删除的旧桌面前端', async () => {
  expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${server.port}/app.js`)).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${server.port}/nonexistent-asset.xyz`)).status).toBe(404)
})

test('GET /sessions/projects 聚合最近项目 + POST /sessions/:id/fork 拷贝会话', async () => {
  await fetch(`http://127.0.0.1:${server.port}/sessions`, { method: 'POST', body: JSON.stringify({ id: 'proj-s1', title: 'P1', workspaceRoot: '/ws/proj' }) })
  const projects = await (await fetch(`http://127.0.0.1:${server.port}/sessions/projects`)).json() as any
  expect(projects.projects.find((x: any) => x.workspaceRoot === '/ws/proj')?.sessionCount).toBe(1)
  const forked = await (await fetch(`http://127.0.0.1:${server.port}/sessions/proj-s1/fork`, { method: 'POST', body: JSON.stringify({ title: '副本' }) })).json() as any
  expect(forked.session.workspaceRoot).toBe('/ws/proj')
})

test('WS /agent/ws accepts steer over the same connection (aligns cc unified-WS transport)', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-ws-steer-'))
  // 关掉 OS 沙箱 + 隔离 MCP(missing.mcp.json):本用例验的是 WS approve/steer/ping 接线,
  // 不是命令沙箱/MCP 连接(默认开沙箱首次 seatbelt 初始化、或 MCP 尝试连接都会拖慢 approve 的 run_command)。
  const wsServer = startServer({ port: 0, transcriptRoot, sandboxEnabled: false, mcpConfigPath: join(transcriptRoot, 'missing.mcp.json') })
  const client = wsClient(`ws://127.0.0.1:${wsServer.port}/agent/ws?conversationId=ws-steer`)
  try {
    await client.opened
    expect(await client.next()).toMatchObject({ type: 'ready', conversationId: 'ws-steer' })
    // 心跳:ping → pong(对齐 cc,保活长连接)
    client.ws.send(JSON.stringify({ type: 'ping', ts: 42 }))
    expect(await client.next()).toMatchObject({ type: 'pong', ts: 42 })
    // 无运行中回合:steer 回 running:false(走同一条 WS,不报错不崩)
    client.ws.send(JSON.stringify({ type: 'steer', message: '换个思路' }))
    expect(await client.next()).toMatchObject({ type: 'steer_result', conversationId: 'ws-steer', running: false })
    // 审批放行走同一条 WS:approve → approve_result(复用 executeApproved 验签+执行)
    const approveArgs = { command: 'echo ws-approved' }
    client.ws.send(JSON.stringify({ type: 'approve', tool: 'run_command', args: approveArgs, token: signApproval('run_command', approveArgs), permissionMode: 'full', conversationId: 'ws-steer' }))
    expect(await client.next()).toMatchObject({ type: 'approve_result', ok: true, tool: 'run_command' })
    // 空 steer 消息:报错但连接不崩
    client.ws.send(JSON.stringify({ type: 'steer', message: '   ' }))
    expect(await client.next()).toMatchObject({ type: 'error' })
    client.close()
  } finally {
    wsServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('session interrupt aborts the in-flight model request and marks session interrupted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-interrupt-'))
  let capturedSignal: AbortSignal | undefined
  let releaseFetch: ((value: Response) => void) | undefined
  const interruptServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      capturedSignal = init?.signal ?? undefined
      return await new Promise<Response>((resolve, reject) => {
        releaseFetch = resolve
        capturedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  })
  try {
    const runPromise = fetch(`http://127.0.0.1:${interruptServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hang', conversationId: 'c-interrupt', permissionMode: 'full' }),
    }).then(res => res.text())

    for (let i = 0; i < 50 && !capturedSignal; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(capturedSignal).toBeTruthy()
    expect(capturedSignal?.aborted).toBe(false)

    const interrupt = await fetch(`http://127.0.0.1:${interruptServer.port}/sessions/c-interrupt/interrupt`, { method: 'POST' })
    expect(await interrupt.json()).toEqual({ ok: true, interrupted: true })
    expect(capturedSignal?.aborted).toBe(true)

    const text = await runPromise
    expect(text).toContain('任务已中断')
    const session = await (await fetch(`http://127.0.0.1:${interruptServer.port}/sessions/c-interrupt`)).json() as any
    expect(session.session.status).toBe('interrupted')
    const events = await (await fetch(`http://127.0.0.1:${interruptServer.port}/sessions/c-interrupt/events`)).json() as any
    expect(events.events.some((e: any) => e.event.text === '任务已请求中断')).toBe(true)
  } finally {
    releaseFetch?.(new Response('{}', { status: 499 }))
    interruptServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('provider routes are mounted and the active provider reaches the agent runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-api-'))
  let sentUrl = ''
  let sentBody: any
  const providerServer = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    },
    fetchImpl: async (url, init) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'saved-model', choices: [{ index: 0, delta: { content: 'saved ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const created = await fetch(`http://127.0.0.1:${providerServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'saved',
        name: 'Saved Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://saved.example/v1',
        apiKey: 'saved-secret',
        model: 'saved-model',
      }),
    })
    expect(created.status).toBe(201)

    const modelStatus = await fetch(`http://127.0.0.1:${providerServer.port}/model`)
    expect(modelStatus.status).toBe(200)
    const modelBody = await modelStatus.json() as any
    expect(modelBody.runtime).toMatchObject({ source: 'saved-provider', providerId: 'saved' })
    expect(JSON.stringify(modelBody)).not.toContain('saved-secret')
    expect(JSON.stringify(modelBody)).not.toContain('saved-model')

    const run = await fetch(`http://127.0.0.1:${providerServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-run', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    expect(await run.text()).toContain('saved ok')
    expect(sentUrl).toBe('https://saved.example/v1/chat/completions')
    expect(sentBody.model).toBe('saved-model')
  } finally {
    providerServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run falls back from failing active provider to env provider and streams the notice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-fallback-run-'))
  const requestedUrls: string[] = []
  const fallbackServer = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    },
    fetchImpl: async (url) => {
      requestedUrls.push(String(url))
      if (String(url).startsWith('https://saved.example')) {
        throw new Error('HTTP 502 Bearer sk-saved')
      }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'fallback-model', choices: [{ index: 0, delta: { content: 'fallback ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const created = await fetch(`http://127.0.0.1:${fallbackServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'saved',
        name: 'Saved Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://saved.example/v1',
        apiKey: 'saved-secret',
        model: 'saved-model',
      }),
    })
    expect(created.status).toBe(201)

    const modelStatus = await (await fetch(`http://127.0.0.1:${fallbackServer.port}/model`)).json() as any
    expect(modelStatus.fallbackCount).toBe(1)

    const run = await fetch(`http://127.0.0.1:${fallbackServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-fallback-run', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    const text = await run.text()
    expect(text).toContain('event: context_note')
    expect(text).toContain('模型出口「Saved Provider」请求失败')
    expect(text).toContain('Bearer [redacted]')
    // 白标:env/内置出口在失败旁白里也走中性代称,不再回显「环境变量:<真实模型>」。
    expect(text).toContain('已切换到备用模型出口「默认通道」继续')
    expect(text).not.toContain('环境变量:fallback-model')
    expect(text).not.toContain('fallback-model')
    expect(text).toContain('event: final')
    expect(text).toContain('fallback ok')
    expect(text).not.toContain('saved-secret')
    expect(text).not.toContain('fallback-secret')
    expect(text).not.toContain('sk-saved')
    expect(requestedUrls).toEqual([
      'https://saved.example/v1/chat/completions',
      'https://fallback.example/v1/chat/completions',
    ])
  } finally {
    fallbackServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run tries saved provider fallbacks before env fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-saved-fallback-run-'))
  const requestedUrls: string[] = []
  const fallbackServer = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      OPENAI_BASE_URL: 'https://env.example/v1',
      OPENAI_API_KEY: 'env-secret',
      TEXT_MODEL_NAME: 'env-model',
    },
    fetchImpl: async (url) => {
      requestedUrls.push(String(url))
      if (String(url).startsWith('https://primary.example')) {
        throw new Error('HTTP 502 Bearer sk-primary')
      }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'backup-model', choices: [{ index: 0, delta: { content: 'backup ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const primary = await fetch(`http://127.0.0.1:${fallbackServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'primary-secret',
        model: 'primary-model',
      }),
    })
    expect(primary.status).toBe(201)
    const backup = await fetch(`http://127.0.0.1:${fallbackServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'backup',
        name: 'Backup Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-secret',
        model: 'backup-model',
      }),
    })
    expect(backup.status).toBe(201)

    const modelStatus = await (await fetch(`http://127.0.0.1:${fallbackServer.port}/model`)).json() as any
    expect(modelStatus.runtime).toMatchObject({ providerId: 'primary' })
    expect(modelStatus.fallbackCount).toBe(2)

    const run = await fetch(`http://127.0.0.1:${fallbackServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-saved-fallback-run', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    const text = await run.text()
    expect(text).toContain('模型出口「Primary Provider」请求失败')
    expect(text).toContain('已切换到备用模型出口「Backup Provider」继续')
    expect(text).toContain('backup ok')
    expect(text).not.toContain('primary-secret')
    expect(text).not.toContain('backup-secret')
    expect(text).not.toContain('env-secret')
    expect(text).not.toContain('sk-primary')
    expect(requestedUrls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ])
  } finally {
    fallbackServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run cools down a recently failed primary provider for the next turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-health-cooldown-'))
  const requestedUrls: string[] = []
  const cooldownServer = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      OPENAI_BASE_URL: 'https://env.example/v1',
      OPENAI_API_KEY: 'env-secret',
      TEXT_MODEL_NAME: 'env-model',
    },
    fetchImpl: async (url) => {
      requestedUrls.push(String(url))
      if (String(url).startsWith('https://primary.example')) {
        throw new Error('HTTP 502 Bearer sk-primary')
      }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'backup-model', choices: [{ index: 0, delta: { content: 'backup ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    await fetch(`http://127.0.0.1:${cooldownServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'primary-secret',
        model: 'primary-model',
      }),
    })
    await fetch(`http://127.0.0.1:${cooldownServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'backup',
        name: 'Backup Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-secret',
        model: 'backup-model',
      }),
    })

    const first = await fetch(`http://127.0.0.1:${cooldownServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-health-first', permissionMode: 'full' }),
    })
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('已切换到备用模型出口「Backup Provider」继续')

    const modelStatus = await (await fetch(`http://127.0.0.1:${cooldownServer.port}/model`)).json() as any
    expect(modelStatus.runtime).toMatchObject({ providerId: 'backup', providerName: 'Backup Provider' })
    expect(modelStatus.coolingCount).toBe(1)
    expect(modelStatus.health.find((item: any) => item.providerId === 'primary')).toMatchObject({
      label: 'Primary Provider',
      state: 'cooling',
      failureCount: 1,
      lastError: 'HTTP 502 Bearer [redacted]',
    })
    expect(modelStatus.healthHistory[0]).toMatchObject({
      kind: 'failure',
      key: 'saved:primary',
      label: 'Primary Provider',
      failureCount: 1,
      error: 'HTTP 502 Bearer [redacted]',
    })
    expect(modelStatus.health.find((item: any) => item.providerId === 'primary').cooldownMsRemaining).toBeGreaterThan(0)
    expect(JSON.stringify(modelStatus)).not.toContain('primary-secret')
    expect(JSON.stringify(modelStatus)).not.toContain('sk-primary')

    const second = await fetch(`http://127.0.0.1:${cooldownServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping again', conversationId: 'provider-health-second', permissionMode: 'full' }),
    })
    expect(second.status).toBe(200)
    const secondText = await second.text()
    // 白标:冷却提示去掉真实模型名(label)与原始报错(lastError),只给一句中性提示。
    expect(secondText).toContain('上个 AI 通道最近失败已进入冷却，本轮已自动优先使用可用通道继续。')
    expect(secondText).not.toContain('Primary Provider」最近失败')
    expect(secondText).toContain('backup ok')
    expect(secondText).not.toContain('sk-primary')
    expect(requestedUrls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ])
  } finally {
    cooldownServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /api/model/health/clear manually clears provider cooldown without changing provider config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-health-clear-'))
  const providerRoot = join(root, 'providers')
  const requestedUrls: string[] = []
  const cooldownServer = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot,
    env: {},
    fetchImpl: async (url) => {
      requestedUrls.push(String(url))
      if (String(url).startsWith('https://primary.example')) {
        throw new Error('HTTP 502 Bearer sk-primary')
      }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'backup-model', choices: [{ index: 0, delta: { content: 'backup ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    await fetch(`http://127.0.0.1:${cooldownServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'primary-secret',
        model: 'primary-model',
      }),
    })
    await fetch(`http://127.0.0.1:${cooldownServer.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'backup',
        name: 'Backup Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-secret',
        model: 'backup-model',
      }),
    })

    const first = await fetch(`http://127.0.0.1:${cooldownServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-health-clear-first', permissionMode: 'full' }),
    })
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('已切换到备用模型出口「Backup Provider」继续')
    const coolingStatus = await (await fetch(`http://127.0.0.1:${cooldownServer.port}/model`)).json() as any
    expect(coolingStatus.runtime).toMatchObject({ providerId: 'backup' })

    const cleared = await fetch(`http://127.0.0.1:${cooldownServer.port}/api/model/health/clear`, {
      method: 'POST',
      body: JSON.stringify({ providerId: 'primary' }),
    })
    expect(cleared.status).toBe(200)
    const clearedBody = await cleared.json() as any
    expect(clearedBody.cleared).toBe(1)
    expect(clearedBody.status).toMatchObject({
      coolingCount: 0,
      runtime: { providerId: 'primary', providerName: 'Primary Provider' },
    })
    expect(readFileSync(join(providerRoot, 'providers.json'), 'utf8')).toContain('primary-secret')
    expect(JSON.stringify(clearedBody)).not.toContain('primary-secret')
    expect(JSON.stringify(clearedBody)).not.toContain('sk-primary')
  } finally {
    cooldownServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('provider health cooldown survives server restart without mutating provider config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-health-persist-'))
  const providerRoot = join(root, 'providers')
  const requestedUrls: string[] = []
  const fetchImpl = async (url: string | URL | Request) => {
    requestedUrls.push(String(url))
    if (String(url).startsWith('https://primary.example')) {
      throw new Error('HTTP 502 Bearer sk-primary')
    }
    const enc = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'backup-model', choices: [{ index: 0, delta: { content: 'backup ok' }, finish_reason: 'stop' }] })}\n\n`))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  let server = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions-1'),
    providerRoot,
    env: {},
    fetchImpl,
  })
  try {
    await fetch(`http://127.0.0.1:${server.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'primary-secret',
        model: 'primary-model',
      }),
    })
    await fetch(`http://127.0.0.1:${server.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'backup',
        name: 'Backup Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-secret',
        model: 'backup-model',
      }),
    })
    const first = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'provider-health-persist-first', permissionMode: 'full' }),
    })
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('已切换到备用模型出口「Backup Provider」继续')
    server.stop(true)

    const providerConfigJson = readFileSync(join(providerRoot, 'providers.json'), 'utf8')
    expect(providerConfigJson).toContain('primary-secret')
    expect(providerConfigJson).not.toContain('Bearer [redacted]')
    expect(readFileSync(join(providerRoot, 'provider-health.json'), 'utf8')).toContain('Bearer [redacted]')
    expect(readFileSync(join(providerRoot, 'provider-health.json'), 'utf8')).not.toContain('sk-primary')

    server = startServer({
      port: 0,
      transcriptRoot: join(root, 'sessions-2'),
      providerRoot,
      env: {},
      fetchImpl,
    })
    const status = await (await fetch(`http://127.0.0.1:${server.port}/model`)).json() as any
    expect(status.runtime).toMatchObject({ providerId: 'backup', providerName: 'Backup Provider' })
    expect(status.coolingCount).toBe(1)

    const prewarm = await fetch(`http://127.0.0.1:${server.port}/agent/prewarm`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'provider-health-prewarm', workspaceRoot: root }),
    })
    expect(prewarm.status).toBe(200)
    const prewarmBody = await prewarm.json() as any
    expect(prewarmBody.provider).toMatchObject({ providerId: 'backup', providerName: 'Backup Provider' })
    // 白标:冷却提示中性化,不带真实模型名/原始报错。
    expect(prewarmBody.notices?.[0]).toContain('上个 AI 通道最近失败已进入冷却')
    expect(prewarmBody.notices?.[0]).not.toContain('Backup Provider')
    expect(JSON.stringify(prewarmBody)).not.toContain('primary-secret')
    expect(JSON.stringify(prewarmBody)).not.toContain('sk-primary')
    expect(requestedUrls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ])

    const second = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping again', conversationId: 'provider-health-persist-second', permissionMode: 'full' }),
    })
    expect(second.status).toBe(200)
    const text = await second.text()
    // 白标:冷却提示中性化,不带真实模型名/原始报错。
    expect(text).toContain('上个 AI 通道最近失败已进入冷却')
    expect(text).not.toContain('Primary Provider」最近失败')
    expect(requestedUrls).toEqual([
      'https://primary.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ])
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy BYOK text config syncs into the active runtime provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-byok-provider-'))
  let sentUrl = ''
  let sentBody: any
  const byokServer = startServer({
    port: 0,
    transcriptRoot: root,
    providerRoot: root,
    env: {},
    fetchImpl: async (url, init) => {
      sentUrl = String(url)
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'byok-model', choices: [{ index: 0, delta: { content: 'byok ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const saved = await fetch(`http://127.0.0.1:${byokServer.port}/api/v1/stores/me/byok`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        base_url: 'https://byok.example/v1',
        api_key: 'byok-secret',
        model: 'byok-model',
      }),
    })
    expect(saved.status).toBe(200)
    const savedBody = await saved.json() as any
    expect(savedBody).toMatchObject({ enabled: true, base_url: 'https://byok.example/v1', model: 'byok-model', key_configured: true })
    expect(JSON.stringify(savedBody)).not.toContain('byok-secret')

    const modelStatus = await (await fetch(`http://127.0.0.1:${byokServer.port}/model`)).json() as any
    expect(modelStatus.runtime).toMatchObject({
      source: 'saved-provider',
      providerId: 'byok-text',
      providerName: '自带文字模型',
    })
    // 白标:出口摘要不外露真实 model,只给能力档代称。
    expect(modelStatus.runtime.summary.model).toBeUndefined()
    expect(JSON.stringify(modelStatus)).not.toContain('byok-model')

    const run = await fetch(`http://127.0.0.1:${byokServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'legacy-byok-run', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    expect(await run.text()).toContain('byok ok')
    expect(sentUrl).toBe('https://byok.example/v1/chat/completions')
    expect(sentBody.model).toBe('byok-model')
  } finally {
    byokServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes command tools when commands are configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-command-tools-'))
  const commandsRoot = join(root, 'commands')
  await Bun.write(join(commandsRoot, 'promo.md'), `---
description: Plan promo
---
Plan a promotion.
`)
  let sentBody: any
  const commandToolServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandToolServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi', conversationId: 'cmd-tools', permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    const toolNames = sentBody.tools.map((tool: any) => tool.function.name)
    expect(toolNames).toContain('list_commands')
    expect(toolNames).toContain('read_command')
  } finally {
    commandToolServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run expands slash commands and persists command invocation for replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-command-invoke-'))
  const commandsRoot = join(root, 'commands')
  await Bun.write(join(commandsRoot, 'daily.md'), `---
name: daily-report
description: 写日报
---
按门店数据生成日报。
`)
  let sentBody: any
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '日报完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/daily-report 今天', conversationId: 'cmd-invoke', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('日报完成')
    expect(JSON.stringify(sentBody.messages)).toContain('命令: /daily-report')
    expect(JSON.stringify(sentBody.messages)).toContain('按门店数据生成日报')
    expect(JSON.stringify(sentBody.messages)).toContain('今天')

    const replay = await fetch(`http://127.0.0.1:${commandRunServer.port}/sessions/cmd-invoke/events`)
    const replayBody = await replay.json() as any
    expect(replayBody.events[0].event.type).toBe('user_prompt')
    expect(replayBody.events[1].event).toMatchObject({
      type: 'command_invocation',
      name: 'daily-report',
      args: '今天',
      raw: '/daily-report 今天',
    })
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run slash command allowedTools grants tool approval in ask mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-command-allowed-tools-'))
  const commandsRoot = join(root, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  await Bun.write(join(commandsRoot, 'shell-edit.md'), `---
name: shell-edit
description: Shell edit
allowedTools: ["Bash(printf:*)"]
---
Use the shell for this command.
`)
  const sentBodies: any[] = []
  let calls = 0
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBodies.push(JSON.parse(init?.body as string))
      const payload = calls++ === 0
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'cmd_write', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf ok > command-allowed.txt' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }
      return sseResponse(payload)
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/shell-edit now', conversationId: 'cmd-allowed-tools', workspaceRoot: root, permissionMode: 'ask' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('approval_request')
    expect(readFileSync(join(root, 'command-allowed.txt'), 'utf8')).toBe('ok')
    expect(JSON.stringify(sentBodies[0].messages)).toContain('命令: /shell-edit')
    expect(sentBodies.length).toBe(2)
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run executes context fork slash commands in a background command worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-context-fork-command-'))
  const commandsRoot = join(root, 'commands')
  await Bun.write(join(commandsRoot, 'deep-audit.md'), `---
description: Deep audit
context: fork
allowedTools: [read_file]
---
Run a deep command audit.
`)
  await new SessionService(root).transcript('context-fork-command', root).save([
    { role: 'user', content: [textBlock('父级上下文不应进入命令 worker')] },
  ])
  const sentBodies: any[] = []
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    agentsRoot: join(root, 'agents'),
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      sentBodies.push(body)
      return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'Command audit complete' }, finish_reason: 'stop' }] })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '/deep-audit parser',
        conversationId: 'context-fork-command',
        workspaceRoot: root,
        permissionMode: 'full',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('background_task_started')
    expect(text).toContain('agent=\\"command-deep-audit\\"')
    expect(text).not.toContain('Run a deep command audit')

    const taskId = text.match(/id=\\?"([^"\\]+)\\?"/)?.[1]
    expect(taskId).toBeTruthy()
    if (!taskId) throw new Error('missing context fork command task id')
    const done = await waitFor(async () => {
      const detail = await fetch(`http://127.0.0.1:${commandRunServer.port}/tasks/${taskId}`)
      const body = await detail.json() as { task?: { status: string; result?: unknown; params?: Record<string, unknown> } }
      return body.task?.status === 'completed' ? body.task : null
    }, 2500)
    expect(done.params).toMatchObject({
      agent: 'command-deep-audit',
      command_context: 'fork',
      slash_command: 'deep-audit',
    })
    expect(done.result).toBe('Command audit complete')
    expect(sentBodies).toHaveLength(1)
    const request = JSON.stringify(sentBodies[0])
    expect(request).toContain('<background_subagent name=\\"command-deep-audit\\">')
    expect(request).toContain('Run a deep command audit')
    expect(request).toContain('命令参数')
    expect(sentBodies[0].tools.map((tool: any) => tool.function.name)).toEqual(['read_file'])
    expect(request).toContain('parser')
    expect(request).not.toContain('父级上下文不应进入命令 worker')

    const transcript = await new SessionService(root).loadTranscript('context-fork-command')
    expect(JSON.stringify(transcript)).toContain('/deep-audit parser')
    expect(JSON.stringify(transcript)).toContain('background_task_started')
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run applies context fork command allowedTools as worker session permissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-context-fork-command-allowed-'))
  const commandsRoot = join(root, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  await Bun.write(join(commandsRoot, 'shell-worker.md'), `---
description: Shell worker
context: fork
allowedTools: ["Bash(printf:*)"]
---
Write the requested file from the fork worker.
`)
  let workerCalls = 0
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    agentsRoot: join(root, 'agents'),
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      const payload = workerCalls++ === 0
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'run_1', function: { name: 'run_command', arguments: JSON.stringify({ command: 'printf ok > worker-allowed.txt' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'worker wrote file' }, finish_reason: 'stop' }] }
      return sseResponse(payload)
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '/shell-worker now',
        conversationId: 'context-fork-command-allowed',
        workspaceRoot: root,
        permissionMode: 'ask',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const taskId = text.match(/id=\\?"([^"\\]+)\\?"/)?.[1]
    expect(taskId).toBeTruthy()
    if (!taskId) throw new Error('missing context fork command task id')
    const done = await waitFor(async () => {
      const detail = await fetch(`http://127.0.0.1:${commandRunServer.port}/tasks/${taskId}`)
      const body = await detail.json() as { task?: { status: string; result?: unknown } }
      return body.task?.status === 'completed' ? body.task : null
    }, 2500)
    expect(done.result).toBe('worker wrote file')
    expect(readFileSync(join(root, 'worker-allowed.txt'), 'utf8')).toBe('ok')

    const eventsRes = await fetch(`http://127.0.0.1:${commandRunServer.port}/tasks/${taskId}/events?after=0`)
    const eventsText = await eventsRes.text()
    expect(eventsText).not.toContain('approval_request')
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run expands the billiards knowledge activation command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-domain-pack-command-invoke-'))
  const commandsRoot = join(root, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  let sentBody: any
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '内容计划完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '/台球 周末活动',
        conversationId: 'domain-pack-cmd-invoke',
        workspaceRoot: root,
        permissionMode: 'full',
        knowledge_packs: ['billiards'],
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('内容计划完成')
    expect(JSON.stringify(sentBody.messages)).toContain('命令: /台球')
    expect(JSON.stringify(sentBody.messages)).toContain('领域包: 台球运营知识库')
    expect(JSON.stringify(sentBody.messages)).toContain('继续按通用 Agent 的正常方式')
    expect(JSON.stringify(sentBody.messages)).toContain('周末活动')

    const replay = await fetch(`http://127.0.0.1:${commandRunServer.port}/sessions/domain-pack-cmd-invoke/events`)
    const replayBody = await replay.json() as any
    expect(replayBody.events[0].event.type).toBe('user_prompt')
    expect(replayBody.events[1].event).toMatchObject({
      type: 'command_invocation',
      name: '台球',
      args: '周末活动',
      raw: '/台球 周末活动',
    })
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run expands workspace slash commands from working_dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-workspace-command-invoke-'))
  const commandsRoot = join(root, 'commands')
  const workspaceRoot = join(root, 'workspace')
  const workspaceCommands = join(workspaceRoot, '.billiardbuddy', 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  mkdirSync(workspaceCommands, { recursive: true })
  writeFileSync(join(workspaceCommands, 'site-audit.md'), `---
description: 门店项目检查
---
检查当前项目里的运营自动化实现。
`)
  let sentBody: any
  const commandRunServer = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '项目检查完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${commandRunServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/site-audit 今天', conversationId: 'workspace-cmd-invoke', working_dir: workspaceRoot, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('项目检查完成')
    expect(JSON.stringify(sentBody.messages)).toContain('命令: /site-audit')
    expect(JSON.stringify(sentBody.messages)).toContain('检查当前项目里的运营自动化实现')
    expect(JSON.stringify(sentBody.messages)).toContain('今天')
  } finally {
    commandRunServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run handles builtin /goal set as local command before continuing model turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-goal-set-'))
  let sentBody: any
  const goalServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      const isHookEvaluation = JSON.stringify(body).includes('<cc-haha-goal-hook>')
      if (!isHookEvaluation) sentBody = body
      const content = isHookEvaluation ? '{"ok":true}' : '目标推进完成'
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${goalServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/goal 完成迁移并跑绿测试', conversationId: 'goal-set', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('Goal set: 完成迁移并跑绿测试')
    expect(text).toContain('目标推进完成')
    expect(JSON.stringify(sentBody.messages)).toContain('Goal set: 完成迁移并跑绿测试')
    expect(JSON.stringify(sentBody.messages)).toContain('Continue working until this goal is complete: 完成迁移并跑绿测试')

    const replay = await fetch(`http://127.0.0.1:${goalServer.port}/sessions/goal-set/events`)
    const replayBody = await replay.json() as any
    expect(replayBody.events.map((record: any) => record.event.type)).toEqual([
      'user_prompt',
      'command_invocation',
      'context_note',
      'final',
      'done',
    ])
    const transcript = await new SessionService(root).loadTranscript('goal-set')
    expect(JSON.stringify(transcript)).toContain('<command-name>/goal</command-name>')
    expect(JSON.stringify(transcript)).toContain('Goal set: 完成迁移并跑绿测试')
  } finally {
    goalServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run handles builtin /goal clear locally without calling model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-goal-clear-'))
  let fetchCalls = 0
  const goalServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('model should not be called for /goal clear')
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${goalServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/goal clear', conversationId: 'goal-clear', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('No active goal.')
    expect(text).toContain('event: final')
    expect(fetchCalls).toBe(0)
  } finally {
    goalServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run handles builtin /goal usage errors as local command output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-goal-usage-'))
  let fetchCalls = 0
  const goalServer = startServer({
    port: 0,
    transcriptRoot: root,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      fetchCalls += 1
      throw new Error('model should not be called for invalid /goal')
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${goalServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/goal status', conversationId: 'goal-usage', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('Usage: /goal <condition> | clear')
    expect(text).toContain('event: final')
    expect(fetchCalls).toBe(0)
  } finally {
    goalServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy /api/v1/agent/tasks starts a turn and streams frontend-compatible SSE events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-agent-task-'))
  const legacyServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '兼容完成' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${legacyServer.port}/api/v1/agent/tasks`, {
      method: 'POST',
      body: JSON.stringify({ message: '兼容任务', conversation_id: 'legacy-c1', permission_mode: 'full', working_dir: root }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    expect(startedBody.task_id).toBeTruthy()

    const events = await fetch(`http://127.0.0.1:${legacyServer.port}/api/v1/agent/tasks/${startedBody.task_id}/events?after=-1`)
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    const text = await events.text()
    expect(text).toContain('"type":"final"')
    expect(text).toContain('"content":"兼容完成"')
    expect(text).toContain('"type":"done"')
    expect(text).toContain('"conversation_id":"legacy-c1"')
  } finally {
    legacyServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('server mounts modern task routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-task-route-'))
  const seededTasks = new TaskService(root)
  try {
    const task = await seededTasks.create({ id: 'task_route_probe', title: 'route probe' })
    await seededTasks.appendEvent(task.id, { type: 'final', text: 'mounted' })

    const taskServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
    try {
      const events = await fetch(`http://127.0.0.1:${taskServer.port}/tasks/${task.id}/events?after=0&limit=1`)
      expect(events.status).toBe(200)
      const eventsBody = await events.json() as any
      expect(eventsBody).toMatchObject({ nextSeq: 1 })
      expect(eventsBody.events[0].event).toEqual({ type: 'final', text: 'mounted' })
    } finally {
      taskServer.stop(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio media endpoints create TS media jobs and expose media-job status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-media-'))
  const mediaServer = startServer({ port: 0, transcriptRoot: root })
  try {
    const started = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '做一张会员日海报', ratio: '1:1', count: 1, conversation_id: 'media-c1' }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    expect(startedBody.job_id).toBeTruthy()

    let status: any = null
    for (let i = 0; i < 500; i++) {
      const res = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)
      status = await res.json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(status).toMatchObject({ kind: 'generate', status: 'done', progress: 100 })
    expect(status.result.local_preview).toBe(true)
    expect(status.result.urls).toHaveLength(1)

    const asset = await fetch(`http://127.0.0.1:${mediaServer.port}${status.result.urls[0]}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('image/svg+xml')

    const localGenerationId = status.result.images[0].generation_id
    const generation = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/generation/${encodeURIComponent(localGenerationId)}`)
    expect(generation.status).toBe(200)
	    const generationBody = await generation.json() as any
	    expect(generationBody).toMatchObject({ url: status.result.urls[0], is_video: false, local_preview: true })

	    const projects = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/workbench/projects`)
	    expect(projects.status).toBe(200)
	    const projectsBody = await projects.json() as any
	    expect(projectsBody.projects).toHaveLength(0)

	    const storyboard = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/storyboard`, {
      method: 'POST',
      body: JSON.stringify({ theme: '会员日台球短片', shots: 4, subject: '年轻助教' }),
    })
    expect(storyboard.status).toBe(200)
    const storyboardBody = await storyboard.json() as any
    expect(storyboardBody.local_preview).toBe(true)
    expect(storyboardBody.shots).toHaveLength(4)
    expect(storyboardBody.caption).toContain('会员日台球短片')
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate uses TS image gateway when image env is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-image-gateway-'))
  const calls: string[] = []
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
      OPENAI_API_KEY: 'app-token',
      IMAGE_MODEL_NAME: 'gpt-image-2',
      QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步网关路径(默认已翻异步)
    },
    fetchImpl: async (url) => {
      calls.push(String(url))
      return Response.json({ data: [{ b64_json: Buffer.from('png-from-gateway').toString('base64') }] })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '做一张会员日海报', ratio: '1:1', count: 1, conversation_id: 'media-c2' }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 500; i++) {
      const res = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)
      status = await res.json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(calls).toEqual(['http://image-gateway.example/gw/v1/images/generations'])
    expect(status).toMatchObject({ kind: 'generate', status: 'done', progress: 100 })
    expect(status.result.local_preview).toBe(false)
    // 白标:生图结果只给能力档代称,不外露真实 provider/model。
    expect(status.result.image_engine).toBe('创意生图')
    expect(JSON.stringify(status.result)).not.toContain('openai')

    const asset = await fetch(`http://127.0.0.1:${mediaServer.port}${status.result.urls[0]}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('image/png')
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('image workbench routes enforce revision conflicts and explicit portrait confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-workbench-routes-'))
  const mediaServer = startServer({ port: 0, transcriptRoot: root })
  const base = `http://127.0.0.1:${mediaServer.port}`
  try {
    const createdResponse = await fetch(`${base}/api/v1/studio/workbench/projects`, {
      method: 'POST',
      body: JSON.stringify({
        title: '授权随拍优化',
        image_url: '/uploads/posters/portrait.png',
        width: 768,
        height: 768,
        intent: 'portrait',
        quality: 'standard',
        creative_brief: {
          user_request: '保留本人特征，只按本次要求更换背景',
          scene: 'portrait',
          portrait: { authorization_confirmed: true },
        },
      }),
    })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json() as any
    expect(created.project.autosave_revision).toBe(0)

    const save = () => fetch(`${base}/api/v1/studio/workbench/projects/${created.project.project_id}/canvas`, {
      method: 'PATCH',
      body: JSON.stringify({
        current_version_id: created.project.current_version_id,
        width: 768,
        height: 768,
        text_layers: [],
        image_layers: [],
        revision: 0,
      }),
    })
    expect((await save()).status).toBe(200)
    expect((await save()).status).toBe(409)

    const confirmedResponse = await fetch(`${base}/api/v1/studio/workbench/projects/${created.project.project_id}/portrait-confirm`, {
      method: 'POST',
      body: JSON.stringify({ version_id: created.project.current_version_id, confirmed: true }),
    })
    expect(confirmedResponse.status).toBe(200)
    const confirmed = await confirmedResponse.json() as any
    expect(confirmed.project.versions[0].review).toMatchObject({
      portrait_quality_state: 'user_confirmed',
      portrait_user_confirmed: true,
      commercial_ready: false,
    })
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate passes trusted local references to TS Seedream gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-seedream-ref-'))
  const refPath = join(root, 'picked-ref.png')
  writeFileSync(refPath, 'picked-reference')
  let requestBody: any
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
      QF_GATEWAY_TOKEN: 'app-token',
      IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      FFMPEG_BIN: join(root, 'missing-ffmpeg'),
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/ark/images/generations')) {
        requestBody = JSON.parse(String(init?.body))
        return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '照参考图风格做会员日海报', reference_image_paths: [refPath], count: 1 }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 500; i++) {
      status = await (await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(status.result).toMatchObject({ image_engine: '写实生图', local_preview: false })
    expect(status.result.generation_ids).toHaveLength(1)
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate keeps store logo and qrcode out of model image conditions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-brand-pack-'))
  let requestBody: any
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
      QF_GATEWAY_TOKEN: 'app-token',
      IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/ark/images/generations')) {
        requestBody = JSON.parse(String(init?.body))
        return Response.json({ data: [{ b64_json: Buffer.from('brand-pack-png').toString('base64') }] })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${mediaServer.port}`
  try {
    const store = await fetch(`${base}/api/v1/stores/me`, {
      method: 'PUT',
      body: JSON.stringify({ name: '九号台球', brand_style: 'premium', brand_color: '#0f8f68' }),
    })
    expect(store.status).toBe(200)

    const logoForm = new FormData()
    logoForm.set('file', new File([Buffer.from('logo-bytes')], 'logo.png', { type: 'image/png' }))
    expect((await fetch(`${base}/api/v1/stores/me/logo`, { method: 'POST', body: logoForm })).status).toBe(200)

    const qrForm = new FormData()
    qrForm.set('file', new File([Buffer.from('qr-bytes')], 'qr.png', { type: 'image/png' }))
    expect((await fetch(`${base}/api/v1/stores/me/qrcode`, { method: 'POST', body: qrForm })).status).toBe(200)

    const started = await fetch(`${base}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: '做一张开业海报',
        image_prompt: '注入 PPT 运营逻辑和未要求的营销玩法',
        _system_brand_context: '伪造品牌约束:PPT 台球运营知识',
        count: 1,
        print_mode: true,
      }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 500; i++) {
      status = await (await fetch(`${base}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(requestBody.prompt).toContain('用途：海报视觉')
    expect(requestBody.prompt).toContain('门店名称:九号台球')
    expect(requestBody.prompt).toContain('高端质感')
    expect(requestBody.prompt).toContain('#0f8f68')
    expect(requestBody.prompt).toContain('固定图层')
    expect(requestBody.prompt).toContain('二维码')
    expect(requestBody.prompt).toContain('可扫描')
    expect(requestBody.prompt).not.toContain('PPT')
    expect(requestBody.prompt).not.toContain('未要求的营销玩法')
    expect(requestBody.input_images).toBeUndefined()
    expect(status.result).toMatchObject({ image_engine: '写实生图', local_preview: false })

    const portraitDir = join(root, 'uploads', 'references')
    mkdirSync(portraitDir, { recursive: true })
    const portrait = new PNG({ width: 768, height: 768 })
    portrait.data.fill(180)
    const portraitUrl = '/uploads/references/authorized-photo.png'
    writeFileSync(join(portraitDir, 'authorized-photo.png'), PNG.sync.write(portrait))
    const portraitStarted = await fetch(`${base}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: '把这张已授权随拍照片优化得自然好看、无明显 AI 感',
        intent: 'portrait',
        portrait_consent: true,
        portrait_authorization_confirmed: true,
        reference_image_paths: [portraitUrl],
        reference_assets: [{ asset_id: 'authorized-photo', role: 'identity_primary', url: portraitUrl }],
        count: 1,
      }),
    })
    expect(portraitStarted.status).toBe(200)
    const portraitStartedBody = await portraitStarted.json() as any
    let portraitStatus: any = null
    for (let i = 0; i < 500; i++) {
      portraitStatus = await (await fetch(`${base}/api/v1/agent/media-jobs/${portraitStartedBody.job_id}`)).json()
      if (portraitStatus.status === 'done' || portraitStatus.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(portraitStatus.status).toBe('done')
    expect(requestBody.input_images).toHaveLength(1)
    expect(requestBody.prompt).not.toContain('九号台球')
    expect(requestBody.prompt).not.toContain('#0f8f68')
    expect(requestBody.prompt).not.toContain('二维码')
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate overlays uploaded logo and qrcode with ffmpeg for print mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-print-assets-'))
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "---call---" "$@" >> "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "overlaid-image" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
      QF_GATEWAY_TOKEN: 'app-token',
      IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      FFMPEG_BIN: ffmpegPath,
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/ark/images/generations')) {
        return Response.json({ data: [{ b64_json: Buffer.from('base-image').toString('base64') }] })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${mediaServer.port}`
  try {
    const logoForm = new FormData()
    logoForm.set('file', new File([Buffer.from('logo-bytes')], 'logo.png', { type: 'image/png' }))
    expect((await fetch(`${base}/api/v1/stores/me/logo`, { method: 'POST', body: logoForm })).status).toBe(200)

    const qrForm = new FormData()
    qrForm.set('file', new File([Buffer.from('qr-bytes')], 'qr.png', { type: 'image/png' }))
    expect((await fetch(`${base}/api/v1/stores/me/qrcode`, { method: 'POST', body: qrForm })).status).toBe(200)

    const started = await fetch(`${base}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '要拿去印刷的活动海报', count: 1, print_mode: true }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 200; i++) {
      status = await (await fetch(`${base}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done' || status.status === 'error') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(status.status).toBe('done')
    expect(status.result).toMatchObject({ print_mode: true, print_logo_overlay: 'ffmpeg', print_qr_overlay: 'ffmpeg' })
    expect(status.result.images[0]).toMatchObject({ print_mode: true, print_logo_overlay: 'ffmpeg', print_qr_overlay: 'ffmpeg' })
    const asset = await fetch(`${base}${status.result.urls[0]}`)
    expect(await asset.text()).toBe('overlaid-image')
    const ffmpegArgs = readFileSync(ffmpegArgsPath, 'utf8')
    expect(ffmpegArgs).toContain('-filter_complex')
    expect(ffmpegArgs).toContain('overlay=x=W*0.04:y=W*0.04')
    expect(ffmpegArgs).toContain('overlay=x=W-w-W*0.04')
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate regenerates print QR from saved store content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-print-qr-content-'))
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "content-qr-overlaid" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
      QF_GATEWAY_TOKEN: 'app-token',
      IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      FFMPEG_BIN: ffmpegPath,
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/ark/images/generations')) {
        return Response.json({ data: [{ b64_json: Buffer.from('base-image').toString('base64') }] })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  const base = `http://127.0.0.1:${mediaServer.port}`
  try {
    const store = await fetch(`${base}/api/v1/stores/me`, {
      method: 'PUT',
      body: JSON.stringify({ name: '九号台球', qrcode_text: 'https://example.com/store/qr' }),
    })
    expect(store.status).toBe(200)

    const started = await fetch(`${base}/api/v1/studio/generate`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '要拿去印刷的活动海报', count: 1, print_mode: true }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 200; i++) {
      status = await (await fetch(`${base}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done' || status.status === 'error') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(status.status).toBe('done')
    expect(status.result).toMatchObject({ print_mode: true, print_qr_overlay: 'ffmpeg', print_qr_regeneration: 'generated' })
    expect(status.result.images[0]).toMatchObject({ print_qr_regeneration: 'generated' })
    expect(readFileSync(ffmpegArgsPath, 'utf8')).toContain('/uploads/tmp/print-qr-')
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio edit uses TS image edits gateway with generated source image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-image-edit-'))
  const uploadDir = join(root, 'uploads', 'posters')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'source.png'), 'source-image')
  let form: any
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
      OPENAI_API_KEY: 'app-token',
      IMAGE_MODEL_NAME: 'gpt-image-2',
      QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步网关路径(默认已翻异步)
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/images/edits')) {
        form = init?.body
        return Response.json({ data: [{ b64_json: Buffer.from('edited-png').toString('base64') }] })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  try {
    const generation = await (await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/generation/direct-source`)).json() as any
    expect(generation).toMatchObject({ url: '/uploads/posters/source.png', is_video: false })

    const started = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/edit`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '把背景改成深绿色', source_generation_id: 'direct-source', count: 1 }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 500; i++) {
      status = await (await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(String(form.get('prompt'))).toContain('Change only:')
    expect(String(form.get('prompt'))).toContain('把背景改成深绿色')
    expect(form.get('input_fidelity')).toBe('high')
    expect(form.getAll('image')).toHaveLength(1)
    expect(status.result).toMatchObject({ image_engine: '创意生图', mode: 'edit', local_preview: false, input_fidelity_status: 'accepted' })
    expect(status.result.urls[0]).toMatch(/^\/uploads\/posters\/image_.*\.png$/)
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy video-edit sync endpoints use local timeline documents without media backend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-video-edit-'))
  const project = 'demo_project'
  const clipPath = join(root, 'clip.mp4')
  const editDir = join(root, 'uploads', 'edits', project)
  mkdirSync(editDir, { recursive: true })
  writeFileSync(clipPath, 'fake-video-bytes')
  writeFileSync(join(editDir, 'timeline.json'), JSON.stringify({
    version: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    media: { m1: { src: clipPath, duration: 12, kind: 'video' } },
    tracks: { v: { kind: 'video', order: 0 } },
    clips: { c1: { track: 'v', order: 0, media: 'm1', src_in: 1, src_out: 5 } },
    grade: null,
    music: null,
  }))

  const videoServer = startServer({ port: 0, transcriptRoot: root })
  try {
    const initial = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${project}`)
    expect(initial.status).toBe(200)
    const initialBody = await initial.json() as any
    expect(initialBody.doc.duration).toBe(4)
    expect(initialBody.doc.clips[0]).toMatchObject({ id: 'c1', src_in: 1, src_out: 5 })

    const edited = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${project}/ops`, {
      method: 'POST',
      body: JSON.stringify({ operations: [{ op: 'trim_clip', id: 'c1', src_out: 4 }] }),
    })
    expect(edited.status).toBe(200)
    const editedBody = await edited.json() as any
    expect(editedBody).toMatchObject({ ok: true, errors: [] })
    expect(editedBody.doc.duration).toBe(3)

    const invalid = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${project}/ops`, {
      method: 'POST',
      body: JSON.stringify({ operations: [{ op: 'trim_clip', id: 'c1', src_out: 50 }] }),
    })
    expect(invalid.status).toBe(200)
    const invalidBody = await invalid.json() as any
    expect(invalidBody.ok).toBe(false)
    expect(invalidBody.errors[0]).toContain('超出源素材范围')
    expect(invalidBody.doc.duration).toBe(3)

    const captions = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${project}/auto_caption`, {
      method: 'POST',
      body: JSON.stringify({ track: 'sub' }),
    })
    expect(captions.status).toBe(200)
    const captionsBody = await captions.json() as any
    expect(captionsBody).toMatchObject({ ok: true, added: 1, local_preview: true })
    expect(captionsBody.doc.captions[0]).toMatchObject({ text: '镜头 1', start: 0, end: 3 })

    const feedback = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${project}/edit_feedback`, {
      method: 'POST',
      body: JSON.stringify({ feedback: '文案甜一点' }),
    })
    expect(feedback.status).toBe(200)
    const feedbackBody = await feedback.json() as any
    expect(feedbackBody.local_preview).toBe(true)
    expect(feedbackBody.shots[0]).toMatchObject({ src: clipPath, start: 1, end: 4 })
    expect(feedbackBody.shots[0].caption).toContain('文案甜一点')

    const file = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/localfile?path=${encodeURIComponent(clipPath)}`, {
      headers: { range: 'bytes=1-4' },
    })
    expect(file.status).toBe(206)
    expect(file.headers.get('content-range')).toBe('bytes 1-4/16')
    expect(await file.text()).toBe('ake-')
  } finally {
    videoServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy video-edit aliases delegate to Scene Timeline v2 without timeline dual writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-video-edit-local-render-'))
  const clipPath = join(root, 'source.mp4')
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  const ffprobePath = join(root, 'fake-ffprobe.sh')
  writeFileSync(clipPath, 'fake-video-source')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "---call---" "$@" >> "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'if [ "$out" = "-" ]; then printf "fake-mp4-from-ffmpeg"; exit 0; fi',
    'mkdir -p "$(dirname "$out")"',
    'printf "fake-mp4-from-ffmpeg" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(ffprobePath, [
    '#!/bin/sh',
    'input=""',
    'for arg in "$@"; do input="$arg"; done',
    'duration="7.5"',
    'case "$input" in *.tmp.mp4) duration="4" ;; esac',
    'cat <<JSON',
    '{"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30/1","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"${duration}"}}',
    'JSON',
    'exit_code=$?',
    'exit "$exit_code"',
    '',
  ].join('\n'), { mode: 0o755 })
  const videoServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      FFMPEG_BIN: ffmpegPath,
      FFPROBE_BIN: ffprobePath,
      QF_BINARIES_DIR: join(root, 'empty-binaries'),
      PATH: '/nonexistent/bin',
    },
  })
  try {
    const startedPlan = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/auto_plan_v2`, {
      method: 'POST',
      body: JSON.stringify({ video_paths: [clipPath], ratio: '16:9', target_duration: 4, conversation_id: 'video-c1' }),
    })
    expect(startedPlan.status).toBe(200)
    const planStart = await startedPlan.json() as any

    const planStatus = await waitFor(async () => {
      const status = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${planStart.job_id}`)).json() as any
      return status.status === 'done' ? status : null
    }, 5000)
    expect(planStatus).toMatchObject({ kind: 'video_v2_drafts', status: 'done', progress: 100 })
    expect(planStatus.result.project_id).toBe(planStart.project)
    expect(planStatus.result.alternative_ids).toHaveLength(3)

    const project = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}`)).json() as any
    expect(project.project).toMatchObject({ schema_version: 2, project_id: planStart.project })
    expect(project.project.sources[0]).toMatchObject({ duration_ms: 7500, width: 1920, height: 1080, has_audio: true })
    expect(project.project.scenes.length).toBeGreaterThan(0)
    expect(project.project.alternatives).toHaveLength(3)
    expect(existsSync(join(root, 'uploads', 'edits', planStart.project, 'project.json'))).toBe(true)
    expect(existsSync(join(root, 'uploads', 'edits', planStart.project, 'timeline.json'))).toBe(false)

    const startedRender = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}/render_v2`, {
      method: 'POST',
      body: JSON.stringify({ output_name: '成片', conversation_id: 'video-c1' }),
    })
    expect(startedRender.status).toBe(202)
    const renderStart = await startedRender.json() as any

    let renderStatus: any = null
    for (let i = 0; i < 100; i++) {
      renderStatus = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${renderStart.job_id}`)).json()
      if (renderStatus.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(renderStatus).toMatchObject({ kind: 'video_v2_render', status: 'done', progress: 100 })
    expect(renderStatus.result).toMatchObject({
      project_id: planStart.project,
      preview: false,
    })
    expect(readFileSync(ffmpegArgsPath, 'utf8')).toContain('graphics.ass')
    expect(renderStatus.result.video_url).toMatch(/^\/api\/v1\/video-edit\/projects\/.+\/exports\/export-.*\.mp4$/)
    expect(renderStatus.result.manifest_url).toMatch(/\.manifest\.json$/)

    const asset = await fetch(`http://127.0.0.1:${videoServer.port}${renderStatus.result.video_url}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('video/mp4')
  } finally {
    videoServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy speech alias preserves no-audio evidence and fails closed without inventing dialogue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-video-edit-footage-health-'))
  const clipPath = join(root, 'silent.mp4')
  const ffprobePath = join(root, 'fake-ffprobe.sh')
  writeFileSync(clipPath, 'fake-silent-video')
  writeFileSync(ffprobePath, [
    '#!/bin/sh',
    'cat <<\'JSON\'',
    JSON.stringify({
      streams: [
        { codec_type: 'video', duration: '5.25', width: 1280, height: 720, avg_frame_rate: '25/1', codec_name: 'h264' },
      ],
      format: { duration: '5.25' },
    }),
    'JSON',
    '',
  ].join('\n'), { mode: 0o755 })
  const videoServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { FFPROBE_BIN: ffprobePath },
  })
  try {
    const startedPlan = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/auto_plan`, {
      method: 'POST',
      body: JSON.stringify({ video_paths: [clipPath], mode: 'speech', ratio: '16:9', target_duration: 6, conversation_id: 'video-c2' }),
    })
    expect(startedPlan.status).toBe(200)
    const planStart = await startedPlan.json() as any

    const planStatus = await waitFor(async () => {
      const status = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${planStart.job_id}`)).json() as any
      return status.status === 'done' || status.status === 'error' ? status : null
    }, 5000)
    expect(planStatus).toMatchObject({ kind: 'video_v2_drafts', status: 'error' })
    expect(planStatus.error).toContain('真实素材不足')

    const project = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}`)).json() as any
    expect(project.project.sources[0]).toMatchObject({ duration_ms: 5250, has_audio: false })
    expect(project.project.creative_brief).toMatchObject({ preferred_view: 'talking' })
    expect(project.project.scenes).toEqual([])
    expect(project.project.sources[0].warnings.some((item: string) => /无音轨|没有音轨/.test(item))).toBe(true)
    expect(existsSync(join(root, 'uploads', 'edits', planStart.project, 'timeline.json'))).toBe(false)
  } finally {
    videoServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run loads JSON hook config into the model request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-hooks-'))
  const hooksPath = join(root, 'hooks.json')
  writeFileSync(hooksPath, JSON.stringify({
    hooks: [
      { event: 'SessionStart', decision: { action: 'context', additionalContext: '门店画像:高峰期晚八点' } },
      { event: 'UserPromptSubmit', decision: { action: 'context', additionalContext: '用户偏好:简洁' } },
      { event: 'UserPromptSubmit', decision: { action: 'modify', updatedInput: '改写后的用户需求' } },
    ],
  }))
  let sentBody: any
  const hookServer = startServer({
    port: 0,
    transcriptRoot: root,
    hooksPath,
    // hooks.json = 工作区来源(local),受信任门约束;显式受信该工作区,验证受信后 local hook 正常注入。
    trustedWorkspaceRoots: [root],
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init?.body as string)
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${hookServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '原始需求', conversationId: 'hooked', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(sentBody.messages[0].role).toBe('system')
    expect(sentBody.messages[0].content).toContain('门店画像:高峰期晚八点')
    const userMessage = sentBody.messages.find((m: any) => m.role === 'user')
    expect(JSON.stringify(userMessage.content)).toContain('用户偏好:简洁')
    expect(JSON.stringify(userMessage.content)).toContain('改写后的用户需求')
    expect(JSON.stringify(userMessage.content)).not.toContain('原始需求')
  } finally {
    hookServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

// P0 回归:证明 hooks 信任门在 server 装配处被激活。工作区来源(local)的 hooks.json,在**未受信**工作区里
// 不执行(SessionStart context 不注入),**受信**后才注入。对齐 cc 交互会话"信任必需",堵住旧"门从没被激活"缺口。
test('POST /agent/run:hooks.json(工作区来源)未受信工作区被信任门挡下、受信后放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-hook-trust-'))
  const hooksPath = join(root, 'hooks.json')
  writeFileSync(hooksPath, JSON.stringify({
    hooks: [{ event: 'SessionStart', decision: { action: 'context', additionalContext: '仅受信工作区才应注入' } }],
  }))
  const runOnce = async (trusted: boolean, conversationId: string): Promise<string> => {
    let sentBody: any
    const server = startServer({
      port: 0,
      transcriptRoot: mkdtempSync(join(tmpdir(), 'server-hook-trust-state-')),
      hooksPath,
      ...(trusted ? { trustedWorkspaceRoots: [root] } : {}),
      env: {
        OPENAI_BASE_URL: 'https://model.example/v1',
        OPENAI_API_KEY: 'secret',
        TEXT_MODEL_NAME: 'mimo-v2.5',
      },
      fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(init?.body as string)
        const enc = new TextEncoder()
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`))
            c.enqueue(enc.encode('data: [DONE]\n\n'))
            c.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
        method: 'POST',
        body: JSON.stringify({ message: 'hi', conversationId, workspaceRoot: root, permissionMode: 'full' }),
      })
      expect(res.status).toBe(200)
      await res.text()
      return JSON.stringify(sentBody?.messages ?? [])
    } finally {
      server.stop(true)
    }
  }
  try {
    // 未受信:local SessionStart hook 被门挡,context 不注入
    expect(await runOnce(false, 'untrusted')).not.toContain('仅受信工作区才应注入')
    // 受信:local hook 正常执行,context 注入进 system prompt
    expect(await runOnce(true, 'trusted')).toContain('仅受信工作区才应注入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run exposes agent_task when agents are configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-agents-'))
  const agentsRoot = join(root, 'agents')
  await Bun.write(join(agentsRoot, 'researcher.md'), `---
name: researcher
description: 研究代理
tools: [list_dir]
---
你是研究代理。
`)
  let calls = 0
  const sentBodies: any[] = []
  const agentServer = startServer({
    port: 0,
    transcriptRoot: root,
    agentsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(init?.body as string))
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_agent', function: { name: 'agent_task', arguments: JSON.stringify({ agent: 'researcher', task: '列目录并总结' }) } }] }, finish_reason: 'tool_calls' }] }
        : calls === 2
          ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '子代理结果' }, finish_reason: 'stop' }] }
          : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '外层完成' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${agentServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '派子代理研究', conversationId: 'agent-run', permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('agent_task')
    expect(text).toContain('子代理结果')
    expect(text).toContain('外层完成')
    expect(calls).toBe(3)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'agent_task')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'list_agent_task_sidechains')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'read_agent_task_sidechain')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'read_agent_task_stored_result')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'start_background_agent_task')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'list_background_tasks')).toBe(true)
    expect(sentBodies[1].messages[0].content).toContain('<subagent name="researcher">')
    expect(sentBodies[1].tools.map((t: any) => t.function.name)).toEqual(['list_dir'])
    const listed = await fetch(`http://127.0.0.1:${agentServer.port}/tasks?conversationId=agent-run`)
    const listedBody = await listed.json() as { tasks: Array<{ status: string; kind?: string; params?: Record<string, unknown> }> }
    const foregroundTask = listedBody.tasks.find(task => task.kind === 'background_agent' && task.params?.agent === 'researcher')
    expect(foregroundTask).toBeTruthy()
    expect(foregroundTask).toMatchObject({
      status: 'completed',
      params: {
        agent: 'researcher',
        task: '列目录并总结',
        foreground: false,
      },
    })
    expect(typeof foregroundTask?.params?.agent_id).toBe('string')
  } finally {
    agentServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run notifies when a background subagent task finishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-background-agent-'))
  const agentsRoot = join(root, 'agents')
  await Bun.write(join(agentsRoot, 'researcher.md'), `---
name: researcher
description: 研究代理
tools: []
---
你是后台研究代理。
`)
  let outerCalls = 0
  const sentBodies: any[] = []
  const agentServer = startServer({
    port: 0,
    transcriptRoot: root,
    agentsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      sentBodies.push(body)
      const system = String(body.messages?.[0]?.content ?? '')
      const isBackground = system.includes('<background_subagent name="researcher">')
      const payload = isBackground
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '后台结论' }, finish_reason: 'stop' }] }
        : outerCalls++ === 0
          ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_background_agent', function: { name: 'start_background_agent_task', arguments: JSON.stringify({ agent: 'researcher', task: '后台分析数据', title: '后台分析' }) } }] }, finish_reason: 'tool_calls' }] }
          : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '后台任务已启动' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${agentServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '派后台子代理研究', conversationId: 'agent-run-bg', permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('start_background_agent_task')
    expect(text).toContain('background_task_started')

    const notifications = await waitFor(async () => {
      const body = await (await fetch(`http://127.0.0.1:${agentServer.port}/api/v1/notifications?after=0`)).json() as any
      const item = body.items.find((n: any) => n.kind === 'background_task')
      return item ?? null
    })
    expect(notifications).toMatchObject({
      title: '后台子代理已完成',
      body: '后台分析',
      meta: { status: 'completed', title: '后台分析', conversationId: 'agent-run-bg', agent: 'researcher' },
    })
    expect(typeof notifications.meta.taskId).toBe('string')
    expect(sentBodies.some(body => String(body.messages?.[0]?.content ?? '').includes('<background_subagent name="researcher">'))).toBe(true)
  } finally {
    agentServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run starts built-in /fork as an inherited background worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-builtin-fork-run-'))
  const agentsRoot = join(root, 'agents')
  mkdirSync(agentsRoot, { recursive: true })
  await new SessionService(root).transcript('fork-command-run', root).save([
    { role: 'user', content: [textBlock('父级已经读过 parser.ts')] },
    { role: 'assistant', content: [textBlock('父级结论: parser 入口在 parseCommandInvocation。')] },
  ])
  const sentBodies: any[] = []
  const forkServer = startServer({
    port: 0,
    transcriptRoot: root,
    agentsRoot,
    mcpConfigPath: join(root, 'missing.mcp.json'),
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
      DESKTOP_AGENT_FORK_SUBAGENT: '1',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      sentBodies.push(body)
      return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'Scope: 审计 parser 边界\nResult: ok' }, finish_reason: 'stop' }] })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${forkServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({
        message: '/fork 审计 parser 边界',
        conversationId: 'fork-command-run',
        workspaceRoot: root,
        permissionMode: 'full',
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: command_invocation')
    expect(text).toContain('background_task_started')
    expect(text).toContain('agent=\\"fork\\"')
    expect(text).not.toContain('Launch a background fork worker')

    const taskId = text.match(/id=\\?"([^"\\]+)\\?"/)?.[1]
    expect(taskId).toBeTruthy()
    if (!taskId) throw new Error('missing fork task id')
    const done = await waitFor(async () => {
      const detail = await fetch(`http://127.0.0.1:${forkServer.port}/tasks/${taskId}`)
      const body = await detail.json() as { task?: { status: string; result?: unknown; params?: Record<string, unknown> } }
      return body.task?.status === 'completed' ? body.task : null
    }, 2500)
    expect(done.params).toMatchObject({ agent: 'fork', fork_context: true, slash_command: 'fork', task: '审计 parser 边界' })
    expect(done.result).toContain('Scope: 审计 parser 边界')
    expect(sentBodies).toHaveLength(1)
    const forkRequest = JSON.stringify(sentBodies[0])
    expect(forkRequest).toContain('<fork-boilerplate>')
    expect(forkRequest).toContain('Your directive: 审计 parser 边界')
    expect(forkRequest).toContain('父级已经读过 parser.ts')
    expect(forkRequest).toContain('父级结论: parser 入口在 parseCommandInvocation。')

    const transcript = await new SessionService(root).loadTranscript('fork-command-run')
    expect(JSON.stringify(transcript)).toContain('/fork 审计 parser 边界')
    expect(JSON.stringify(transcript)).toContain('background_task_started')
  } finally {
    forkServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run can background a foreground agent_task through the task endpoint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-agent-foreground-handoff-'))
  const agentsRoot = join(root, 'agents')
  await Bun.write(join(agentsRoot, 'researcher.md'), `---
name: researcher
description: 研究代理
tools: [list_dir]
---
你是研究代理。
`)
  let call = 0
  let releaseSyncAgent!: () => void
  const sentBodies: any[] = []
  const agentServer = startServer({
    port: 0,
    transcriptRoot: root,
    agentsRoot,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init?.body as string)
      sentBodies.push(body)
      const system = String(body.messages?.[0]?.content ?? '')
      const isBackground = system.includes('<background_subagent name="researcher">')
      if (isBackground) {
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '后台接管完成' }, finish_reason: 'stop' }] })
      }
      call++
      if (call === 1) {
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_agent', function: { name: 'agent_task', arguments: JSON.stringify({ agent: 'researcher', task: '长任务转后台' }) } }] }, finish_reason: 'tool_calls' }] })
      }
      if (call === 2) {
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fg-list', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }] }, finish_reason: 'tool_calls' }] })
      }
      if (call === 3) {
        await new Promise<void>(resolve => { releaseSyncAgent = resolve })
        return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '同步结果不应返回' }, finish_reason: 'stop' }] })
      }
      return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '外层看到后台启动' }, finish_reason: 'stop' }] })
    },
  })
  try {
    const runPromise = fetch(`http://127.0.0.1:${agentServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '派子代理执行长任务', conversationId: 'agent-handoff-run', permissionMode: 'full' }),
    })
    const foreground = await waitFor(async () => {
      const listed = await fetch(`http://127.0.0.1:${agentServer.port}/tasks?conversationId=agent-handoff-run`)
      const body = await listed.json() as { tasks: Array<{ id: string; status: string; kind?: string; params?: Record<string, unknown> }> }
      return body.tasks.find(task => task.kind === 'background_agent' && task.params?.foreground === true) ?? null
    })
    await waitFor(async () => typeof releaseSyncAgent === 'function' ? { ready: true } : null)
    const backgrounded = await fetch(`http://127.0.0.1:${agentServer.port}/tasks/${foreground.id}/background`, { method: 'POST' })
    expect(backgrounded.status).toBe(200)
    const backgroundedBody = await backgrounded.json() as { ok: boolean; task: { id: string; status: string; params?: Record<string, unknown> } }
    expect(backgroundedBody).toMatchObject({
      ok: true,
      task: {
        id: foreground.id,
        status: 'running',
        params: { foreground: false, is_backgrounded: true, task: '长任务转后台' },
      },
    })

    const res = await runPromise
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('background_task_started')
    expect(text).toContain(foreground.id)
    expect(text).toMatch(/status=\\?"running\\?"/)
    expect(text).toContain('外层看到后台启动')

    const done = await waitFor(async () => {
      const detail = await fetch(`http://127.0.0.1:${agentServer.port}/tasks/${foreground.id}`)
      const body = await detail.json() as { task?: { status: string; result?: unknown; params?: Record<string, unknown> } }
      return body.task?.status === 'completed' ? body.task : null
    }, 2500)
    expect(done.result).toBe('后台接管完成')
    expect(done.params).toMatchObject({ foreground_handoff: true, is_backgrounded: true, handoff_tool_uses: 1, agent: 'researcher' })
    const backgroundBody = sentBodies.find(body => String(body.messages?.[0]?.content ?? '').includes('<background_subagent name="researcher">'))
    expect(backgroundBody).toBeTruthy()
    expect(backgroundBody.messages.some((message: any) =>
      message.role === 'assistant' &&
      message.tool_calls?.some((call: any) => call.id === 'fg-list' && call.function?.name === 'list_dir'),
    )).toBe(true)
    expect(backgroundBody.messages.some((message: any) =>
      message.role === 'tool' &&
      message.tool_call_id === 'fg-list' &&
      String(message.content).length > 0,
    )).toBe(true)
    releaseSyncAgent?.()
  } finally {
    agentServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run loads workspace MCP tools and executes them through SDK client', async () => {
  const root = mkdtempSync(join(process.cwd(), '.server-mcp-'))
  const fixturePath = join(root, 'fixture-mcp-server.ts')
  writeFileSync(fixturePath, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
server.registerTool('echo', {
  description: 'Echo text through MCP',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: 'mcp:' + text }],
}))

await server.connect(new StdioServerTransport())
`)
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: { command: process.execPath, args: [fixturePath] },
    },
  }))
  const sentBodies: any[] = []
  let calls = 0
  const mcpServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(init?.body as string))
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mcp', function: { name: 'mcp__fixture__echo', arguments: JSON.stringify({ text: 'hello' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'done after mcp' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${mcpServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'call mcp', conversationId: 'mcp-run', workspaceRoot: root, permissionMode: 'full', mcpConfigPath: join(root, '.mcp.json') }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('mcp__fixture__echo')
    expect(text).toContain('mcp:hello')
    expect(text).toContain('done after mcp')
    expect(calls).toBe(2)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'mcp__fixture__echo')).toBe(true)
    expect(JSON.stringify(sentBodies[1].messages)).toContain('mcp:hello')
  } finally {
    mcpServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run keeps large MCP tool sets lazy and reveals matches through tool_search', async () => {
  const root = mkdtempSync(join(process.cwd(), '.server-mcp-lazy-'))
  const fixturePath = join(root, 'fixture-mcp-lazy-server.ts')
  writeFileSync(fixturePath, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
for (let i = 0; i < 8; i++) {
  const name = i === 5 ? 'rare_invoice_import' : 'cold_' + i
  server.registerTool(name, {
    description: i === 5 ? 'Import rare invoices from an MCP accounting system.' : 'Cold MCP extension tool ' + i,
    inputSchema: { value: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ value }) => ({
    content: [{ type: 'text', text: name + ':' + (value ?? '') }],
  }))
}

await server.connect(new StdioServerTransport())
`)
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: { command: process.execPath, args: [fixturePath] },
    },
  }))
  const sentBodies: any[] = []
  let calls = 0
  const mcpServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(init?.body as string))
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_search', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'rare invoice accounting', limit: 4 }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'done after search' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${mcpServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'find invoice mcp tool', conversationId: 'mcp-lazy', workspaceRoot: root, permissionMode: 'full', mcpConfigPath: join(root, '.mcp.json') }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const firstToolNames = sentBodies[0].tools.map((t: any) => t.function.name)
    const secondToolNames = sentBodies[1].tools.map((t: any) => t.function.name)
    expect(text).toContain('mcp__fixture__rare_invoice_import')
    expect(calls).toBe(2)
    expect(firstToolNames).toContain('tool_search')
    expect(firstToolNames).not.toContain('mcp__fixture__rare_invoice_import')
    expect(firstToolNames.filter((name: string) => name.startsWith('mcp__'))).toEqual([])
    expect(secondToolNames).toContain('mcp__fixture__rare_invoice_import')
    expect(JSON.stringify(sentBodies[1].messages)).toContain('<tool_search')
  } finally {
    mcpServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy agent task surfaces MCP elicitation and resumes with user answer', async () => {
  const root = mkdtempSync(join(process.cwd(), '.server-mcp-elicit-'))
  const fixturePath = join(root, 'fixture-mcp-elicit-server.ts')
  writeFileSync(fixturePath, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'fixture', version: '1.0.0' })
server.registerTool('needs_form', {
  description: 'Ask the client for a required store name',
  inputSchema: {},
}, async () => {
  const result = await server.server.elicitInput({
    mode: 'form',
    message: 'Pick store',
    requestedSchema: {
      type: 'object',
      properties: {
        store: { type: 'string', title: '门店名' },
      },
      required: ['store'],
    },
  })
  return { content: [{ type: 'text', text: 'elicit:' + result.action + ':' + JSON.stringify(result.content ?? {}) }] }
})

await server.connect(new StdioServerTransport())
`)
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      fixture: { command: process.execPath, args: [fixturePath] },
    },
  }))
  let calls = 0
  const mcpServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async () => {
      calls++
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mcp_elicit', function: { name: 'mcp__fixture__needs_form', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'done after elicit' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${mcpServer.port}/api/v1/agent/tasks`, {
      method: 'POST',
      body: JSON.stringify({ message: 'call mcp elicit', conversation_id: 'mcp-elicit', working_dir: root, permission_mode: 'full', mcpConfigPath: join(root, '.mcp.json') }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    const events = await fetch(`http://127.0.0.1:${mcpServer.port}/api/v1/agent/tasks/${startedBody.task_id}/events?after=-1`)
    const reader = events.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 200; i++) {
        if (text.includes(needle)) return
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      throw new Error(`SSE stream did not contain ${needle}; got ${text}`)
    }

    await readUntil('"type":"ask_question"')
    expect(text).toContain('Pick store')
    expect(text).toContain('store')
    expect(text).toContain('"fields"')
    expect(text).toContain('"name":"store"')

    const answered = await fetch(`http://127.0.0.1:${mcpServer.port}/api/v1/agent/tasks/${startedBody.task_id}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: '{"store":"上海旗舰店"}' }),
    })
    expect(answered.status).toBe(200)
    await readUntil('"type":"done"')
    expect(text).toContain('elicit:accept')
    expect(text).toContain('上海旗舰店')
    expect(text).toContain('done after elicit')
    expect(calls).toBe(2)
    await reader.cancel().catch(() => undefined)
  } finally {
    mcpServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy agent task surfaces AskUserQuestion and feeds answer to the model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-ask-user-'))
  const sentBodies: any[] = []
  let calls = 0
  const askServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      OPENAI_BASE_URL: 'https://model.example/v1',
      OPENAI_API_KEY: 'secret',
      TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      calls++
      sentBodies.push(JSON.parse(init?.body as string))
      const payload = calls === 1
        ? { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_ask', function: { name: 'AskUserQuestion', arguments: JSON.stringify({ question: '选哪个方案', options: [{ label: 'A' }, { label: 'B' }] }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'answer received' }, finish_reason: 'stop' }] }
      const enc = new TextEncoder()
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${askServer.port}/api/v1/agent/tasks`, {
      method: 'POST',
      body: JSON.stringify({ message: 'need ask', conversation_id: 'ask-user-conv', working_dir: root, permission_mode: 'full' }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    const events = await fetch(`http://127.0.0.1:${askServer.port}/api/v1/agent/tasks/${startedBody.task_id}/events?after=-1`)
    const reader = events.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      for (let i = 0; i < 200; i++) {
        if (text.includes(needle)) return
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      throw new Error(`SSE stream did not contain ${needle}; got ${text}`)
    }

    await readUntil('"type":"ask_question"')
    expect(text).toContain('选哪个方案')

    const answered = await fetch(`http://127.0.0.1:${askServer.port}/api/v1/agent/tasks/${startedBody.task_id}/message`, {
      method: 'POST',
      body: JSON.stringify({ message: 'B' }),
    })
    expect(answered.status).toBe(200)
    await readUntil('"type":"done"')
    expect(text).toContain('answer received')
    expect(calls).toBe(2)
    expect(JSON.stringify(sentBodies[1].messages)).toContain('<user_answer>')
    expect(JSON.stringify(sentBodies[1].messages)).toContain('B')
    await reader.cancel().catch(() => undefined)
  } finally {
    askServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy task endpoints resolve stable background agent ids to the latest run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-legacy-task-alias-'))
  const seededTasks = new TaskService(root)
  try {
    const original = await seededTasks.create({
      id: 'legacy_alias_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'legacy-alias-conv',
      params: { agent_id: 'legacy_alias_agent', agent: 'researcher', name: 'legacy-alias', task: '初始任务' },
    })
    await seededTasks.touch(original.id, { status: 'completed', result: '旧结论' })
    const latest = await seededTasks.create({
      id: 'legacy_alias_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'legacy-alias-conv',
      params: { agent_id: 'legacy_alias_agent', agent: 'researcher', name: 'legacy-alias', task: '续跑任务', resumed_from: original.id },
    })
    await seededTasks.touch(latest.id, { status: 'running' })
    await seededTasks.appendEvent(latest.id, { type: 'thinking', text: '最新运行中' })

    const taskServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
    try {
      const events = await fetch(`http://127.0.0.1:${taskServer.port}/api/v1/agent/tasks/legacy_alias_agent/events?after=-1`)
      expect(events.status).toBe(200)
      const reader = events.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      for (let i = 0; i < 20 && !text.includes('最新运行中'); i++) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
      await reader.cancel().catch(() => undefined)
      expect(text).toContain('"task_id":"legacy_alias_latest"')
      expect(text).toContain('"requested_task_id":"legacy_alias_agent"')
      expect(text).toContain('"agent_id":"legacy_alias_agent"')
      expect(text).toContain('最新运行中')

      const sent = await fetch(`http://127.0.0.1:${taskServer.port}/api/v1/agent/tasks/legacy_alias_agent/message`, {
        method: 'POST',
        body: JSON.stringify({ message: '继续往最新任务插话' }),
      })
      expect(sent.status).toBe(200)
      const sentBody = await sent.json() as any
      expect(sentBody.task_id).toBe(latest.id)
      expect(sentBody.requested_task_id).toBe('legacy_alias_agent')
      expect(sentBody.agent_id).toBe('legacy_alias_agent')
      expect((await seededTasks.loadEvents(latest.id)).some(record => record.event.type === 'steering')).toBe(true)
    } finally {
      taskServer.stop(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('session API creates/lists/reads sessions and interrupt is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-api-'))
  const sessionServer = startServer({ port: 0, transcriptRoot: root })
  try {
    const created = await fetch(`http://127.0.0.1:${sessionServer.port}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ id: 'manual1', title: '手动会话', workspaceRoot: root }),
    })
    expect(created.status).toBe(200)
    const createdBody = await created.json() as any
    expect(createdBody.session).toMatchObject({ id: 'manual1', title: '手动会话' })

    const listed = await fetch(`http://127.0.0.1:${sessionServer.port}/sessions`)
    const listBody = await listed.json() as any
    expect(listBody.sessions.map((s: any) => s.id)).toContain('manual1')

    const read = await fetch(`http://127.0.0.1:${sessionServer.port}/sessions/manual1`)
    const readBody = await read.json() as any
    expect(readBody.session.id).toBe('manual1')
    expect(readBody.messages).toEqual([])

    const interrupt = await fetch(`http://127.0.0.1:${sessionServer.port}/sessions/manual1/interrupt`, { method: 'POST' })
    expect(await interrupt.json()).toEqual({ ok: true, interrupted: false })
  } finally {
    sessionServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('session archive route is wired through startServer and preserves provider setup errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-archive-'))
  const svc = new SessionService(root)
  await svc.create({ id: 'arch1', title: '归档会话', workspaceRoot: root })
  const archiveServer = startServer({
    port: 0,
    transcriptRoot: root,
    providerRoot: root,
    env: {},
  })
  try {
    const res = await fetch(`http://127.0.0.1:${archiveServer.port}/sessions/arch1/archive`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'model provider not configured' })
    expect((await fetch(`http://127.0.0.1:${archiveServer.port}/sessions/arch1/archive`)).status).toBe(404)
  } finally {
    archiveServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('session rewind routes are wired through startServer for both compatible prefixes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-rewind-route-'))
  const svc = new SessionService(root)
  await svc.create({ id: 'rw-route', title: '回退路由测试', workspaceRoot: root })
  const rewindRouteServer = startServer({ port: 0, transcriptRoot: root })
  try {
    const base = `http://127.0.0.1:${rewindRouteServer.port}`
    const checkpoints = await (await fetch(`${base}/sessions/rw-route/turn-checkpoints`)).json() as any
    expect(checkpoints.checkpoints).toEqual([])
    const checkpointsApi = await (await fetch(`${base}/api/sessions/rw-route/turn-checkpoints`)).json() as any
    expect(checkpointsApi.checkpoints).toEqual([])
    const missingSelector = await fetch(`${base}/sessions/rw-route/rewind`, { method: 'POST', body: JSON.stringify({ dryRun: true }) })
    expect(missingSelector.status).toBe(400)
  } finally {
    rewindRouteServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('POST /agent/run returns 503 when provider is not configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no-provider-'))
  const noProviderServer = startServer({ port: 0, env: {}, providerRoot: root, transcriptRoot: root })
  try {
    const res = await fetch(`http://127.0.0.1:${noProviderServer.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(503)
  } finally {
    noProviderServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('unknown route returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/nope`)
  expect(res.status).toBe(404)
})

test('UserPromptExpansion deny 拦截 context:fork 命令(回归:fork 路径曾绕过 blocked,危险原文进模型)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'upe-fork-deny-'))
  const commandsRoot = join(root, 'commands')
  mkdirSync(commandsRoot, { recursive: true })
  // context:fork 命令,正文含独特危险标记 —— 若绕过拦截,fork agent 会把它送进模型请求体
  writeFileSync(join(commandsRoot, 'dangerfork.md'), `---
description: fork 命令
context: fork
---
DANGER_FORK_MARKER_泄露密钥SECRET999
`)
  // hooksPath(source:local):UserPromptExpansion 对 dangerfork 命令 deny
  const hooksFile = join(root, 'hooks.json')
  writeFileSync(hooksFile, JSON.stringify({
    hooks: { UserPromptExpansion: [{ matcher: 'dangerfork', hooks: [{ decision: { action: 'deny', message: '禁止该命令' } }] }] },
  }))
  const sentBodies: any[] = []
  const server = startServer({
    port: 0,
    transcriptRoot: root,
    commandsRoot,
    hooksPath: hooksFile,
    trustedWorkspaceRoots: [root], // 让 local hook 过信任门
    env: {
      BILLIARDBUDDY_LOCAL: '1', BILLIARDBUDDY_LIBRARY_DIR: root,
      OPENAI_BASE_URL: 'https://model.example/v1', OPENAI_API_KEY: 'secret', TEXT_MODEL_NAME: 'mimo-v2.5',
    },
    fetchImpl: async (_url, init) => {
      sentBodies.push(JSON.parse(String(init?.body || '{}')))
      return sseResponse({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '/dangerfork', workspaceRoot: root, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // 危险原文绝不能出现在任何发给模型的请求体里(fork agent 被拦截、未派发)
    const allSent = JSON.stringify(sentBodies)
    expect(allSent).not.toContain('DANGER_FORK_MARKER')
    expect(allSent).not.toContain('SECRET999')
    // 回给用户的是拦截说明
    expect(text).toContain('已被 hook 阻止')
  } finally {
    server.stop?.()
    rmSync(root, { recursive: true, force: true })
  }
})
