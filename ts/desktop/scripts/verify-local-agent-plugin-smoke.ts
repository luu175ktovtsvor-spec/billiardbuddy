import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Target = 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc'
type Json = Record<string, unknown>
const desktopRoot = resolve(import.meta.dir, '..')

function record(value: unknown, message: string): Json {
  assert.equal(typeof value, 'object', message)
  assert.notEqual(value, null, message)
  assert.equal(Array.isArray(value), false, message)
  return value as Json
}

function target(value: string | undefined): Target {
  if (value === 'aarch64-apple-darwin' || value === 'x86_64-apple-darwin' || value === 'x86_64-pc-windows-msvc' || value === 'aarch64-pc-windows-msvc') return value
  throw new Error('本地 Agent 插件冒烟验证需要受支持的 --target')
}

class McpClient {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (value: Json) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.read(chunk))
    child.once('error', error => this.close(error))
    child.once('exit', () => this.close(new Error('插件 MCP 在响应前退出')))
  }

  async request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++
    const pending = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件 MCP 对 ${method} 没有响应`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    return await pending
  }

  private read(chunk: string) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      const response = record(JSON.parse(line), '插件 MCP 输出了无效 JSON')
      const id = response.id
      if (typeof id !== 'number') continue
      const pending = this.pending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(response)
    }
  }

  private close(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function result(response: Json) {
  assert.equal('error' in response, false, `插件返回协议错误: ${JSON.stringify(response)}`)
  return record(response.result, '插件 MCP 缺少结果')
}

async function stop(child: ChildProcessWithoutNullStreams) {
  child.stdin.end()
  if (child.exitCode === null) child.kill()
  await once(child, 'exit').catch(() => undefined)
}

async function verifyPlugin(options: {
  name: string
  executable: string
  root: string
  expectedServer: string
  tool: string
  expectError?: boolean
  verifyExtra?: (client: McpClient) => Promise<void>
}) {
  const child = spawn(options.executable, [], { env: { ...process.env, CODEX_HOME: options.root }, stdio: 'pipe' })
  try {
    const client = new McpClient(child)
    const initialized = result(await client.request('initialize'))
    assert.equal(record(initialized.serverInfo, `${options.name} 缺少 serverInfo`).name, options.expectedServer)
    const listed = result(await client.request('tools/list'))
    assert.ok(Array.isArray(listed.tools) && listed.tools.some(tool => record(tool, `${options.name} 工具无效`).name === options.tool), `${options.name} 没有声明 ${options.tool}`)
    const toolCall = result(await client.request('tools/call', { name: options.tool, arguments: {} }))
    assert.equal(toolCall.isError, options.expectError ?? false, `${options.name} 的 ${options.tool} 安全状态不正确`)
    await options.verifyExtra?.(client)
  } finally {
    await stop(child)
  }
}

const args = process.argv.slice(2)
const valueFor = (flag: string) => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
const platformTarget = target(valueFor('--target'))
const extension = platformTarget.includes('windows') ? '.exe' : ''
const plugin = (name: string) => join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins', name, 'bin', `${name}${extension}`)
const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-local-plugin-smoke-'))
try {
  await verifyPlugin({
    name: 'Computer Use', executable: plugin('billiardbuddy-computer-use'), root,
    expectedServer: 'billiardbuddy-computer-use', tool: 'status',
  })
  await verifyPlugin({
    name: 'Chrome Control', executable: plugin('billiardbuddy-chrome'), root,
    expectedServer: 'billiardbuddy-chrome', tool: 'status', expectError: true,
  })
  const recordReplayRoot = join(root, 'record-replay')
  await mkdir(recordReplayRoot, { recursive: true })
  await writeFile(join(recordReplayRoot, 'trace.json'), '{"version":1,"events":[]}\n')
  await verifyPlugin({
    name: 'Record and Replay', executable: plugin('billiardbuddy-record-replay'), root,
    expectedServer: 'billiardbuddy-record-replay', tool: 'recording_status',
    verifyExtra: async client => {
      const stopped = result(await client.request('tools/call', { name: 'stop_recording', arguments: {} }))
      assert.equal(stopped.isError, false, 'Record and Replay 自动到期后的轨迹无法取回')
      const content = stopped.content
      assert.ok(Array.isArray(content) && content.length > 0, 'Record and Replay 自动到期轨迹为空')
      assert.match(String(record(content[0], 'Record and Replay 轨迹结果无效').text), /\"version\":1/)
    },
  })
  console.log('[local-agent-plugin-smoke] verified MCP boot, tool declarations, and safe default behavior')
} finally {
  await rm(root, { recursive: true, force: true })
}
