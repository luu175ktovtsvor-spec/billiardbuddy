import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index'
import { SessionService } from './services/sessionService'
import { textBlock, userText } from '../types/message'
import { signApproval } from '../permissions/approval'

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

test('GET /health returns 200 ok', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; service: string }
  expect(body.ok).toBe(true)
  expect(body.service).toBe('ts-harness')
})

test('legacy frontend capability endpoints are served by TS server', async () => {
  const [skillsRes, stylesRes, commandsRes, pluginsRes, mcpRes] = await Promise.all([
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/skills`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/output-styles`),
    fetch(`http://127.0.0.1:${server.port}/commands`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/plugins`),
    fetch(`http://127.0.0.1:${server.port}/api/v1/agent/mcp`),
  ])
  expect(skillsRes.status).toBe(200)
  expect(stylesRes.status).toBe(200)
  expect(commandsRes.status).toBe(200)
  expect(pluginsRes.status).toBe(200)
  expect(mcpRes.status).toBe(200)

  const skills = await skillsRes.json() as any
  const styles = await stylesRes.json() as any
  const commands = await commandsRes.json() as any
  const plugins = await pluginsRes.json() as any
  const mcp = await mcpRes.json() as any
  expect(Array.isArray(skills.skills)).toBe(true)
  expect(Array.isArray(styles.output_styles)).toBe(true)
  expect(commands.commands.some((command: any) => command.name === 'doctor')).toBe(true)
  expect(Array.isArray(plugins.plugins)).toBe(true)
  expect(Array.isArray(mcp.servers)).toBe(true)
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

    const docs = await (await fetch(`${base}/api/v1/store-docs`, {
      method: 'PUT',
      body: JSON.stringify({ folder_path: root }),
    })).json() as any
    expect(docs).toMatchObject({ folder_path: root, status: 'ready' })

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
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'start_background_agent_task')).toBe(true)
    expect(sentBodies[0].tools.some((t: any) => t.function.name === 'list_background_tasks')).toBe(true)
    expect(sentBodies[1].messages[0].content).toContain('<subagent name="researcher">')
    expect(sentBodies[1].tools.map((t: any) => t.function.name)).toEqual(['list_dir'])
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
