import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index'
import { SessionService } from './services/sessionService'
import { TaskService } from '../tasks/taskService'
import { textBlock, userText } from '../types/message'
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

test('GET /health returns 200 ok', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; service: string }
  expect(body.ok).toBe(true)
  expect(body.service).toBe('ts-harness')
})

test('local dev CORS allows localhost frontend origins', async () => {
  const preflight = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/me`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:3100',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type',
    },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3100')

  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/auth/me`, {
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

test('workspace status endpoint returns compact git status for working_dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-status-'))
  try {
    execFileSync('git', ['init'], { cwd: root })
    writeFileSync(join(root, 'AGENTS.md'), '遵守项目规则\n')
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
      files: [{ file: 'AGENTS.md', truncated: false }],
      count: 1,
      truncated: false,
    })
    expect(body.tree).toMatchObject({
      root,
      truncated: false,
    })
    expect(body.tree.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'AGENTS.md', path: 'AGENTS.md', type: 'file' }),
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
  await svc.transcript('conv_legacy').save([
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
    const me = await (await fetch(`${base}/api/v1/auth/me`)).json() as any
    expect(me.id).toBe('local-user')

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

    const memory = await (await fetch(`${base}/api/v1/store-memory`, {
      method: 'POST',
      body: JSON.stringify({ content: '周五晚上客流最高', type: 'semantic' }),
    })).json() as any
    expect(memory).toMatchObject({ content: '周五晚上客流最高', source: 'manual' })
    const memories = await (await fetch(`${base}/api/v1/store-memory`)).json() as any
    expect(memories).toEqual([expect.objectContaining({ id: memory.id })])

    const scheduled = await (await fetch(`${base}/api/v1/scheduled-tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: '每日文案', instruction: '写一条朋友圈', schedule_kind: 'daily', schedule_spec: { hour: 9, minute: 0 } }),
    })).json() as any
    expect(scheduled).toMatchObject({ name: '每日文案', enabled: true })

    const docsDir = join(root, 'store-docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '价目表.txt'), '黄金档台费 68 元一小时，会员充值满 1000 送 120。')
    writeFileSync(join(docsDir, '排班.txt'), '周五晚班由小王负责。')
    const docs = await (await fetch(`${base}/api/v1/store-docs`, {
      method: 'PUT',
      body: JSON.stringify({ folder_path: docsDir }),
    })).json() as any
    expect(docs).toMatchObject({ folder_path: docsDir, status: 'ready', indexed_file_count: 2 })
    const docHits = await (await fetch(`${base}/api/v1/store-docs/search`, {
      method: 'POST',
      body: JSON.stringify({ query: '黄金档台费', top: 3 }),
    })).json() as any
    expect(docHits.hits[0]).toMatchObject({ file_name: '价目表.txt' })
    expect(docHits.hits[0].excerpt).toContain('68')
    const scopedDocHits = await (await fetch(`${base}/api/v1/store-docs/search`, {
      method: 'POST',
      body: JSON.stringify({ query: '黄金档台费', top: 3, path: '排班.txt' }),
    })).json() as any
    expect(scopedDocHits.hits).toEqual([])

    const dashboard = await (await fetch(`${base}/api/v1/dashboard/today`)).json() as any
    expect(dashboard.greeting).toContain('九号台球')
    expect(Array.isArray(dashboard.recommendations)).toBe(true)

    const notifications = await (await fetch(`${base}/api/v1/notifications?after=0`)).json() as any
    expect(notifications).toMatchObject({ items: [], cursor: 0 })

    const cost = await (await fetch(`${base}/api/v1/quota/cost`)).json() as any
    expect(cost).toMatchObject({ est_cost_yuan: 0 })

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

test('legacy MCP management endpoints write desktop library config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-mcp-config-'))
  const cfgServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { DESKTOP_LOCAL: '1', DESKTOP_LIBRARY_DIR: root },
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

test('legacy plugin endpoints list and toggle desktop plugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugins-'))
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true })
  writeFileSync(join(root, 'plugins', 'demo', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'Demo plugin' }))
  const pluginServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { DESKTOP_LOCAL: '1', DESKTOP_LIBRARY_DIR: root },
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
    const relisted = await (await fetch(`http://127.0.0.1:${pluginServer.port}/api/v1/agent/plugins`)).json() as any
    expect(relisted.plugins[0]).toMatchObject({ name: 'demo', enabled: false })
  } finally {
    pluginServer.stop(true)
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

    const metaOnly = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1?includeMessages=0`)
    const metaOnlyBody = await metaOnly.json() as any
    expect(metaOnlyBody.session.id).toBe('c1')
    expect('messages' in metaOnlyBody).toBe(false)

    const page1 = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/messages?limit=2`)
    const page1Body = await page1.json() as any
    expect(page1Body.messages).toHaveLength(2)
    expect(page1Body.nextSeq).toBe(2)
    expect(page1Body.hasMore).toBe(true)
    const page2 = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/messages?after=2&limit=10`)
    const page2Body = await page2.json() as any
    expect(page2Body.messages.length).toBeGreaterThan(0)
    expect(page2Body.messages[0].seq).toBe(3)

    const eventsRes = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/events`)
    const eventsBody = await eventsRes.json() as any
    expect(eventsBody.events.map((e: any) => e.event.type)).toEqual(['tool_call', 'tool_result', 'final', 'done'])
    expect(eventsBody.nextSeq).toBe(4)

    const afterRes = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/events?after=2`)
    const afterBody = await afterRes.json() as any
    expect(afterBody.events.map((e: any) => e.event.type)).toEqual(['final', 'done'])

    const replay = await fetch(`http://127.0.0.1:${realServer.port}/sessions/c1/events?format=sse`)
    const replayText = await replay.text()
    expect(replayText).toContain('id: 1')
    expect(replayText).toContain('event: tool_call')
    expect(replayText).toContain('event: done')
  } finally {
    realServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run starts a UDS inbox and injects cross-session steering', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-run-uds-inbox-'))
  let calls = 0
  let releaseSecondStep: (() => void) | undefined
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

test('POST /agent/run injects workspace project instructions into the model system prompt', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-instructions-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-instructions-working-'))
  writeFileSync(join(workingRoot, 'AGENTS.md'), 'Always run the nearest typecheck before final.')
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
    expect(systemPrompt).toContain('# 项目指令')
    expect(systemPrompt).toContain('<project_instruction file="AGENTS.md" truncated="false">')
    expect(systemPrompt).toContain('Always run the nearest typecheck before final.')
  } finally {
    instructionServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run injects relevant store memories into the model system prompt', async () => {
  const transcriptRoot = mkdtempSync(join(tmpdir(), 'agent-memory-transcript-'))
  const workingRoot = mkdtempSync(join(tmpdir(), 'agent-memory-working-'))
  const otherRoot = mkdtempSync(join(tmpdir(), 'agent-memory-other-'))
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
    await fetch(`${base}/api/v1/store-memory`, {
      method: 'POST',
      body: JSON.stringify({ content: '黄金档台费 68 元一小时,会员充值满 1000 送 120。', type: 'pricing', working_dir: workingRoot }),
    })
    await fetch(`${base}/api/v1/store-memory/candidates`, {
      method: 'POST',
      body: JSON.stringify({ content: '黄金档台费 pending secret', type: 'pricing' }),
    })
    await fetch(`${base}/api/v1/store-memory`, {
      method: 'POST',
      body: JSON.stringify({ content: '黄金档台费 other workspace 99', type: 'pricing', working_dir: otherRoot }),
    })

    const res = await fetch(`${base}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: '黄金档台费多少', working_dir: workingRoot, permissionMode: 'full' }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(systemPrompt).toContain('<store_memory_context')
    expect(systemPrompt).toContain('黄金档台费 68 元')
    expect(systemPrompt).not.toContain('pending secret')
    expect(systemPrompt).not.toContain('other workspace 99')
  } finally {
    memoryServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
    rmSync(workingRoot, { recursive: true, force: true })
    rmSync(otherRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run mounts enabled packs through SessionStart context', async () => {
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
    const text = await res.text()
    expect(text).toContain('event: context_note')
    expect(systemPrompt).toContain('<hook_context event="SessionStart">')
    expect(systemPrompt).toContain('<domain_context id="billiards" source="enabled_pack">')
    expect(systemPrompt).toContain('list_skills({recommended_only:true})')
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

    expect(toolsByCall[0]).not.toContain('billiards_ops_checklist')
    expect(toolsByCall[1]).toContain('billiards_ops_checklist')
  } finally {
    packServer.stop(true)
    rmSync(transcriptRoot, { recursive: true, force: true })
  }
})

test('POST /agent/run uses enabled pack recommendations for list_skills filtering', async () => {
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
    expect(text).toContain('daily-report [推荐]: Write daily store reports')
    expect(text).not.toContain('generic-helper')
    expect(calls).toBe(2)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'list_skills')).toBe(true)
    expect(JSON.stringify(sentBodies[1].messages)).toContain('已启用领域包推荐技能优先展示')
  } finally {
    packServer.stop(true)
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
    expect(body.provider.summary).toMatchObject({ model: 'mimo-v2.5', hasApiKey: true })
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
    expect(events.map(e => e.event?.type).filter(Boolean)).toEqual(['tool_call', 'tool_result', 'final', 'done'])
    expect(JSON.stringify(events)).toContain('ws 完成')
    expect(events.every(e => e.type !== 'event' || e.seq > 0)).toBe(true)
    client.close()

    const replay = wsClient(`ws://127.0.0.1:${wsServer.port}/agent/ws?conversationId=ws-run&after=1`)
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

test('provider API persists active provider and /agent/run uses it before env fallback', async () => {
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
    const createdBody = await created.json() as any
    expect(createdBody.provider).toMatchObject({ id: 'saved', hasApiKey: true })
    expect(JSON.stringify(createdBody)).not.toContain('saved-secret')

    const listed = await fetch(`http://127.0.0.1:${providerServer.port}/api/providers`)
    const listBody = await listed.json() as any
    expect(listBody.activeId).toBe('saved')
    expect(JSON.stringify(listBody)).not.toContain('saved-secret')

    const modelStatus = await fetch(`http://127.0.0.1:${providerServer.port}/model`)
    expect(modelStatus.status).toBe(200)
    const modelBody = await modelStatus.json() as any
    expect(modelBody.runtime).toMatchObject({ source: 'saved-provider', providerId: 'saved' })
    expect(modelBody.runtime.summary.model).toBe('saved-model')
    expect(JSON.stringify(modelBody)).not.toContain('saved-secret')

    const switchedToEnv = await fetch(`http://127.0.0.1:${providerServer.port}/api/model`, {
      method: 'POST',
      body: JSON.stringify({ providerId: 'env' }),
    })
    const envBody = await switchedToEnv.json() as any
    expect(envBody.activeId).toBe(null)
    expect(envBody.runtime).toMatchObject({ source: 'env' })
    expect(envBody.runtime.summary.model).toBe('fallback-model')

    const switchedBack = await fetch(`http://127.0.0.1:${providerServer.port}/model`, {
      method: 'POST',
      body: JSON.stringify({ providerId: 'saved' }),
    })
    const savedAgain = await switchedBack.json() as any
    expect(savedAgain.runtime).toMatchObject({ source: 'saved-provider', providerId: 'saved' })

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

test('provider API disables candidates and reorders saved fallback priority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-api-order-'))
  const server = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      OPENAI_BASE_URL: 'https://env.example/v1',
      OPENAI_API_KEY: 'env-secret',
      TEXT_MODEL_NAME: 'env-model',
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  async function createProvider(id: string, url: string, model: string) {
    const res = await fetch(`${base}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id,
        name: id,
        apiFormat: 'openai_chat',
        baseUrl: url,
        apiKey: `${id}-secret`,
        model,
      }),
    })
    expect(res.status).toBe(201)
  }
  try {
    await createProvider('primary', 'https://primary.example/v1', 'primary-model')
    await createProvider('backup', 'https://backup.example/v1', 'backup-model')
    await createProvider('slow', 'https://slow.example/v1', 'slow-model')

    const reordered = await fetch(`${base}/providers/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids: ['primary', 'slow', 'backup'] }),
    })
    expect(reordered.status).toBe(200)
    const reorderBody = await reordered.json() as any
    expect(reorderBody.providers.map((provider: any) => provider.id)).toEqual(['primary', 'slow', 'backup'])
    expect(JSON.stringify(reorderBody)).not.toContain('slow-secret')

    const disabled = await fetch(`${base}/providers/primary/disable`, { method: 'POST' })
    expect(disabled.status).toBe(200)
    const disabledBody = await disabled.json() as any
    expect(disabledBody.provider).toMatchObject({ id: 'primary', enabled: false })
    expect(JSON.stringify(disabledBody)).not.toContain('primary-secret')

    const cannotActivate = await fetch(`${base}/providers/primary/activate`, { method: 'POST' })
    expect(cannotActivate.status).toBe(409)

    const status = await (await fetch(`${base}/api/model`)).json() as any
    expect(status.activeId).toBe('slow')
    expect(status.runtime).toMatchObject({ source: 'saved-provider', providerId: 'slow' })
    expect(status.providers.map((provider: any) => [provider.id, provider.enabled])).toEqual([
      ['primary', false],
      ['slow', true],
      ['backup', true],
    ])
    expect(status.health.map((item: any) => item.providerId ?? item.source)).toEqual(['slow', 'backup', 'env'])
    expect(JSON.stringify(status)).not.toContain('primary-secret')
    expect(JSON.stringify(status)).not.toContain('env-secret')
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('commands API lists and expands markdown prompt commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-commands-'))
  const commandsRoot = join(root, 'commands')
  await Bun.write(join(commandsRoot, 'daily.md'), `---
name: daily-report
description: 写日报
---
按门店数据生成日报。
`)
  const commandServer = startServer({ port: 0, transcriptRoot: root, commandsRoot })
  try {
    const listed = await fetch(`http://127.0.0.1:${commandServer.port}/commands`)
    const listBody = await listed.json() as any
    expect(listBody.commands).toHaveLength(1)
    expect(listBody.commands[0]).toMatchObject({ name: 'daily-report', description: '写日报' })

    const expanded = await fetch(`http://127.0.0.1:${commandServer.port}/api/commands/expand`, {
      method: 'POST',
      body: JSON.stringify({ name: '/daily-report', args: '今天', workspaceRoot: root }),
    })
    expect(expanded.status).toBe(200)
    const expandBody = await expanded.json() as any
    expect(expandBody.prompt).toContain('命令: /daily-report')
    expect(expandBody.prompt).toContain('按门店数据生成日报')
    expect(expandBody.prompt).toContain('今天')
  } finally {
    commandServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('commands API lists workspace slash commands when working_dir is provided', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-workspace-commands-'))
  const commandsRoot = join(root, 'commands')
  const workspaceRoot = join(root, 'workspace')
  const claudeCommands = join(workspaceRoot, '.claude', 'commands')
  const codexCommands = join(workspaceRoot, '.codex', 'commands')
  try {
    mkdirSync(commandsRoot, { recursive: true })
    mkdirSync(claudeCommands, { recursive: true })
    mkdirSync(codexCommands, { recursive: true })
    writeFileSync(join(commandsRoot, 'review.md'), `---
description: Builtin review
---
Use builtin review.
`)
    writeFileSync(join(claudeCommands, 'review.md'), `---
description: Workspace review
---
Use workspace review.
`)
    writeFileSync(join(codexCommands, 'fix.md'), `---
description: Workspace fix
---
Use workspace fix.
`)
    const commandServer = startServer({
      port: 0,
      transcriptRoot: root,
      commandsRoot,
      mcpConfigPath: join(root, 'missing.mcp.json'),
    })
    try {
      const listed = await fetch(`http://127.0.0.1:${commandServer.port}/commands?working_dir=${encodeURIComponent(workspaceRoot)}`)
      expect(listed.status).toBe(200)
      const listBody = await listed.json() as any
      expect(listBody.commands.map((command: any) => command.name).sort()).toEqual(['fix', 'review'])
      expect(listBody.commands.find((command: any) => command.name === 'review')).toMatchObject({
        description: 'Workspace review',
      })
    } finally {
      commandServer.stop(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('commands API merges enabled domain pack commands and lets workspace override them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-domain-pack-commands-'))
  const commandsRoot = join(root, 'commands')
  const workspaceRoot = join(root, 'workspace')
  const workspaceCommands = join(workspaceRoot, '.codex', 'commands')
  try {
    mkdirSync(commandsRoot, { recursive: true })
    mkdirSync(workspaceCommands, { recursive: true })
    writeFileSync(join(workspaceCommands, 'daily.md'), `---
name: billiards:daily-ops
description: Workspace daily override
---
Use workspace-specific daily ops.
`)
    const commandServer = startServer({
      port: 0,
      transcriptRoot: root,
      commandsRoot,
      mcpConfigPath: join(root, 'missing.mcp.json'),
    })
    try {
      const listed = await fetch(`http://127.0.0.1:${commandServer.port}/commands?working_dir=${encodeURIComponent(workspaceRoot)}&knowledge_packs=billiards`)
      expect(listed.status).toBe(200)
      const listBody = await listed.json() as any
      const names = listBody.commands.map((command: any) => command.name)
      expect(names).toContain('billiards:content-plan')
      expect(names).toContain('billiards:daily-ops')
      expect(listBody.commands.find((command: any) => command.name === 'billiards:daily-ops')).toMatchObject({
        description: 'Workspace daily override',
      })

      const expanded = await fetch(`http://127.0.0.1:${commandServer.port}/api/commands/expand`, {
        method: 'POST',
        body: JSON.stringify({
          name: '/billiards:content-plan',
          args: '周末活动',
          workspaceRoot,
          knowledge_packs: ['billiards'],
        }),
      })
      expect(expanded.status).toBe(200)
      const expandBody = await expanded.json() as any
      expect(expandBody.prompt).toContain('领域包: 台球运营专家')
      expect(expandBody.prompt).toContain('周末活动')
    } finally {
      commandServer.stop(true)
    }
  } finally {
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
    expect(text).toContain('已切换到备用模型出口「环境变量:fallback-model」继续')
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
    expect(secondText).toContain('模型出口「Primary Provider」最近失败')
    expect(secondText).toContain('本轮先尝试「Backup Provider」')
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
    expect(prewarmBody.notices?.[0]).toContain('模型出口「Primary Provider」最近失败')
    expect(prewarmBody.notices?.[0]).toContain('本轮先尝试「Backup Provider」')
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
    expect(text).toContain('模型出口「Primary Provider」最近失败')
    expect(text).toContain('本轮先尝试「Backup Provider」')
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
    expect(modelStatus.runtime.summary.model).toBe('byok-model')

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
    expect(replayBody.events[0].event).toMatchObject({
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

test('POST /agent/run expands enabled domain pack slash commands', async () => {
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
        message: '/billiards:content-plan 周末活动',
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
    expect(JSON.stringify(sentBody.messages)).toContain('命令: /billiards:content-plan')
    expect(JSON.stringify(sentBody.messages)).toContain('领域包: 台球运营专家')
    expect(JSON.stringify(sentBody.messages)).toContain('周末活动')

    const replay = await fetch(`http://127.0.0.1:${commandRunServer.port}/sessions/domain-pack-cmd-invoke/events`)
    const replayBody = await replay.json() as any
    expect(replayBody.events[0].event).toMatchObject({
      type: 'command_invocation',
      name: 'billiards:content-plan',
      args: '周末活动',
      raw: '/billiards:content-plan 周末活动',
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
  const workspaceCommands = join(workspaceRoot, '.claude', 'commands')
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

test('/tasks endpoints resolve old background agent ids to the latest resumed descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'server-task-chain-'))
  const seededTasks = new TaskService(root)
  try {
    const original = await seededTasks.create({
      id: 'api_chain_root',
      title: 'researcher: root',
      kind: 'background_agent',
      conversationId: 'api-chain',
      params: { agent: 'researcher', name: 'api-chain', task: '初始任务' },
    })
    await seededTasks.touch(original.id, { status: 'completed', result: '旧结论' })
    await seededTasks.appendEvent(original.id, { type: 'final', text: '旧结论' })
    const latest = await seededTasks.create({
      id: 'api_chain_latest',
      title: 'researcher: latest',
      kind: 'background_agent',
      conversationId: 'api-chain',
      params: { agent_id: 'api_chain_agent', agent: 'researcher', name: 'api-chain', task: '续跑任务', resumed_from: original.id },
    })
    await seededTasks.touch(latest.id, { status: 'completed', result: '最新结论' })
    await seededTasks.appendEvent(latest.id, { type: 'final', text: '最新结论' })

    const taskServer = startServer({ port: 0, transcriptRoot: root, mcpConfigPath: join(root, 'missing.mcp.json') })
    try {
      const listed = await fetch(`http://127.0.0.1:${taskServer.port}/tasks?conversationId=api-chain`)
      expect(listed.status).toBe(200)
      const listedBody = await listed.json() as any
      expect(listedBody.tasks.map((task: { id: string }) => task.id)).toEqual([latest.id])

      const detail = await fetch(`http://127.0.0.1:${taskServer.port}/tasks/${original.id}?includeEvents=1`)
      expect(detail.status).toBe(200)
      const detailBody = await detail.json() as any
      expect(detailBody.requestedTaskId).toBe(original.id)
      expect(detailBody.resolvedTaskId).toBe(latest.id)
      expect(detailBody.agentId).toBe('api_chain_agent')
      expect(detailBody.task.id).toBe(latest.id)
      expect(JSON.stringify(detailBody.events)).toContain('最新结论')
      expect(JSON.stringify(detailBody.events)).not.toContain('旧结论')

      const events = await fetch(`http://127.0.0.1:${taskServer.port}/tasks/${original.id}/events?after=0`)
      expect(events.status).toBe(200)
      const eventsBody = await events.json() as any
      expect(eventsBody.requestedTaskId).toBe(original.id)
      expect(eventsBody.resolvedTaskId).toBe(latest.id)
      expect(eventsBody.agentId).toBe('api_chain_agent')
      expect(JSON.stringify(eventsBody.events)).toContain('最新结论')
      expect(JSON.stringify(eventsBody.events)).not.toContain('旧结论')

      const byStableAgentId = await fetch(`http://127.0.0.1:${taskServer.port}/tasks/api_chain_agent?includeEvents=1`)
      expect(byStableAgentId.status).toBe(200)
      const stableBody = await byStableAgentId.json() as any
      expect(stableBody.requestedTaskId).toBe('api_chain_agent')
      expect(stableBody.resolvedTaskId).toBe(latest.id)
      expect(stableBody.agentId).toBe('api_chain_agent')
      expect(JSON.stringify(stableBody.events)).toContain('最新结论')
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
    for (let i = 0; i < 50; i++) {
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
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)
      status = await res.json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(calls).toEqual(['http://image-gateway.example/gw/v1/images/generations'])
    expect(status).toMatchObject({ kind: 'generate', status: 'done', progress: 100 })
    expect(status.result.local_preview).toBe(false)
    expect(status.result.provider).toBe('openai-compatible')

    const asset = await fetch(`http://127.0.0.1:${mediaServer.port}${status.result.urls[0]}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('image/png')
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
    for (let i = 0; i < 50; i++) {
      status = await (await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(status.result).toMatchObject({ provider: 'seedream-gateway', local_preview: false })
    expect(status.result.generation_ids).toHaveLength(1)
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio generate attaches uploaded store brand assets to TS Seedream gateway', async () => {
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
      body: JSON.stringify({ prompt: '做一张开业海报', count: 1, print_mode: true }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    let status: any = null
    for (let i = 0; i < 50; i++) {
      status = await (await fetch(`${base}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    expect(requestBody.prompt).toContain('做一张开业海报')
    expect(requestBody.prompt).toContain('门店名称:九号台球')
    expect(requestBody.prompt).toContain('高端质感')
    expect(requestBody.prompt).toContain('#0f8f68')
    expect(requestBody.prompt).toContain('二维码')
    expect(requestBody.prompt).toContain('可扫描')
    expect(requestBody.input_images).toHaveLength(2)
    expect(requestBody.input_images.every((item: string) => item.startsWith('data:image/png;base64,'))).toBe(true)
    const decoded = requestBody.input_images.map((item: string) => Buffer.from(item.split(',')[1]!, 'base64').toString('utf8'))
    expect(decoded).toEqual(['logo-bytes', 'qr-bytes'])
    expect(status.result).toMatchObject({ provider: 'seedream-gateway', local_preview: false })
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
    for (let i = 0; i < 50; i++) {
      status = await (await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)).json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(form.get('prompt')).toBe('把背景改成深绿色')
    expect(form.getAll('image')).toHaveLength(1)
    expect(status.result).toMatchObject({ provider: 'openai-compatible', mode: 'edit', local_preview: false })
    expect(status.result.urls[0]).toMatch(/^\/uploads\/posters\/image_.*\.png$/)
  } finally {
    mediaServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy studio i2v uses TS Seedance gateway when video env is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-studio-video-gateway-'))
  const calls: Array<{ url: string; body: any }> = []
  const mediaServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: {
      VIDEO_BASE_URL: 'http://video-gateway.example/gw/v1',
      ARK_API_KEY: 'app-token',
      VIDEO_MODEL_NAME: 'doubao-seedance-2-0-260128',
    },
    fetchImpl: async (url, init) => {
      const href = String(url)
      calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (href.endsWith('/contents/generations/tasks')) {
        return Response.json({ id: 'cgt-http-1' })
      }
      if (href.endsWith('/contents/generations/tasks/cgt-http-1')) {
        return Response.json({ status: 'succeeded', content: { video_url: 'http://video.example/http-out.mp4' } })
      }
      if (href === 'http://video.example/http-out.mp4') {
        return new Response(Buffer.from('mp4-from-gateway'), { headers: { 'content-type': 'video/mp4' } })
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    },
  })
  try {
    const started = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/studio/i2v`, {
      method: 'POST',
      body: JSON.stringify({ prompt: '台球房开业短片，镜头推向球桌', ratio: '16:9', duration: 5, conversation_id: 'media-c3' }),
    })
    expect(started.status).toBe(200)
    const startedBody = await started.json() as any
    expect(startedBody.job_id).toBeTruthy()

    let status: any = null
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`http://127.0.0.1:${mediaServer.port}/api/v1/agent/media-jobs/${startedBody.job_id}`)
      status = await res.json()
      if (status.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const submit = calls.find(call => call.url.endsWith('/contents/generations/tasks'))!
    expect(submit.url).toBe('http://video-gateway.example/gw/v1/contents/generations/tasks')
    expect(submit.body).toMatchObject({
      model: 'doubao-seedance-2-0-260128',
      ratio: '16:9',
      duration: 5,
      content: [{ type: 'text', text: '台球房开业短片，镜头推向球桌' }],
    })
    expect(status).toMatchObject({ kind: 'i2v', status: 'done', progress: 100 })
    expect(status.result).toMatchObject({
      local_preview: false,
      provider: 'seedance-gateway',
      source_url: 'http://video.example/http-out.mp4',
    })
    expect(status.result.video_url).toMatch(/^\/uploads\/videos\/video_.*\.mp4$/)

    const asset = await fetch(`http://127.0.0.1:${mediaServer.port}${status.result.video_url}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('video/mp4')
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

test('legacy video-edit auto plan and render use TS local ffmpeg fallback without media backend', async () => {
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
    'mkdir -p "$(dirname "$out")"',
    'printf "fake-mp4-from-ffmpeg" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(ffprobePath, [
    '#!/bin/sh',
    'cat <<\'JSON\'',
    JSON.stringify({
      streams: [
        { codec_type: 'video', duration: '7.5', width: 1920, height: 1080, avg_frame_rate: '30/1', codec_name: 'h264' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '7.5' },
    }),
    'JSON',
    '',
  ].join('\n'), { mode: 0o755 })
  const videoServer = startServer({
    port: 0,
    transcriptRoot: root,
    env: { FFMPEG_BIN: ffmpegPath, FFPROBE_BIN: ffprobePath },
  })
  try {
    const startedPlan = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/auto_plan_v2`, {
      method: 'POST',
      body: JSON.stringify({ video_paths: [clipPath], ratio: '16:9', target_duration: 4, conversation_id: 'video-c1' }),
    })
    expect(startedPlan.status).toBe(200)
    const planStart = await startedPlan.json() as any

    let planStatus: any = null
    for (let i = 0; i < 50; i++) {
      planStatus = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${planStart.job_id}`)).json()
      if (planStatus.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(planStatus).toMatchObject({ kind: 'video_auto_plan', status: 'done', progress: 100 })
    expect(planStatus.result).toMatchObject({ local_preview: true, used_vlm: false, brand: '本地预览' })
    expect(planStatus.result.project).toBe(planStart.project)
    expect(planStatus.result.footage_health.m1).toMatchObject({
      ok: true,
      duration_s: 7.5,
      width: 1920,
      height: 1080,
      has_audio: true,
    })

    const project = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}`)).json() as any
    expect(project.doc.media.m1.duration).toBe(7.5)
    expect(project.doc.clips).toHaveLength(1)
    expect(project.doc.clips[0]).toMatchObject({ src_in: 0, src_out: 4 })
    expect(project.doc.captions).toHaveLength(1)
    expect(project.doc.captions[0]).toMatchObject({ start: 0, end: 4 })

    const startedRender = await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}/render_v2`, {
      method: 'POST',
      body: JSON.stringify({ output_name: '成片', conversation_id: 'video-c1' }),
    })
    expect(startedRender.status).toBe(200)
    const renderStart = await startedRender.json() as any

    let renderStatus: any = null
    for (let i = 0; i < 100; i++) {
      renderStatus = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${renderStart.job_id}`)).json()
      if (renderStatus.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(renderStatus).toMatchObject({ kind: 'video_render', status: 'done', progress: 100 })
    expect(renderStatus.result).toMatchObject({
      provider: 'ts-ffmpeg',
      render_engine: 'ffmpeg',
      audio_loudness_normalized: true,
      audio_loudness_filter: 'loudnorm=I=-16:TP=-1.5:LRA=11',
      local_preview: false,
    })
    expect(readFileSync(ffmpegArgsPath, 'utf8')).toContain('loudnorm=I=-16:TP=-1.5:LRA=11')
    expect(renderStatus.result.urls[0]).toMatch(/^\/uploads\/videos\/video_edit_.*\.mp4$/)
    expect(renderStatus.result.caption_url).toMatch(/^\/uploads\/videos\/video_edit_.*\.srt$/)

    const asset = await fetch(`http://127.0.0.1:${videoServer.port}${renderStatus.result.urls[0]}`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('video/mp4')
  } finally {
    videoServer.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy video-edit local plan reports footage health warnings for speech clips without audio', async () => {
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

    let planStatus: any = null
    for (let i = 0; i < 50; i++) {
      planStatus = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/agent/media-jobs/${planStart.job_id}`)).json()
      if (planStatus.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(planStatus).toMatchObject({ kind: 'video_auto_plan', status: 'done', progress: 100 })
    expect(planStatus.result.has_speech).toBe(false)
    expect(planStatus.result.footage_health.m1).toMatchObject({
      is_bad: true,
      duration_s: 5.25,
      has_audio: false,
    })
    expect(planStatus.result.warnings.some((item: string) => item.includes('口播模式需要音轨'))).toBe(true)

    const project = await (await fetch(`http://127.0.0.1:${videoServer.port}/api/v1/video-edit/projects/${encodeURIComponent(planStart.project)}`)).json() as any
    expect(project.doc.media.m1.duration).toBe(5.25)
    expect(project.doc.clips[0]).toMatchObject({ src_in: 0, src_out: 5.25 })
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
      body: JSON.stringify({ message: '原始需求', conversationId: 'hooked', permissionMode: 'full' }),
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
      body: JSON.stringify({ message: 'call mcp', conversationId: 'mcp-run', workspaceRoot: root, permissionMode: 'full' }),
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
      body: JSON.stringify({ message: 'find invoice mcp tool', conversationId: 'mcp-lazy', workspaceRoot: root, permissionMode: 'full' }),
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
      body: JSON.stringify({ message: 'call mcp elicit', conversation_id: 'mcp-elicit', working_dir: root, permission_mode: 'full' }),
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

test('POST /sessions/:id/archive summarizes old transcript and archives original JSONL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-archive-'))
  const svc = new SessionService(root)
  await svc.create({ id: 'arch1', title: '归档会话', workspaceRoot: root })
  await svc.transcript('arch1').save([
    userText('旧消息 1'),
    userText('旧消息 2'),
    userText('旧消息 3'),
    userText('旧消息 4'),
    userText('最近消息'),
  ])
  const archiveServer = startServer({
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
          c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: '旧对话摘要' }, finish_reason: 'stop' }] })}\n\n`))
          c.enqueue(enc.encode('data: [DONE]\n\n'))
          c.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const res = await fetch(`http://127.0.0.1:${archiveServer.port}/sessions/arch1/archive`, {
      method: 'POST',
      body: JSON.stringify({ keepRecentMessages: 1 }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body).toMatchObject({ ok: true, archived: true, beforeMessages: 5, afterMessages: 2 })
    expect(existsSync(body.archivePath)).toBe(true)
    const messages = await svc.loadTranscript('arch1')
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages[0])).toContain('旧对话摘要')
    expect(JSON.stringify(messages[1])).toContain('最近消息')
  } finally {
    archiveServer.stop(true)
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
