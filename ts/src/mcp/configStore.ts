import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopLibraryBase } from '../harness/desktopEnvNames'
import type { McpTransport } from './config'

/**
 * MCP 预设目录(owner 要的"先把壳子搭好"):前端 MCP 展示读 /api/v1/agent/mcp/presets 列出这些,
 * 用户一键启用(需 key 的填 key、需资产的后台下载)。支持两种传输:
 * - stdio:本机进程(command+args),如 Playwright(需 node 运行时);
 * - sse/http:远程服务器(url),如高德(需 key)。
 */
export interface McpPreset {
  id: string
  name: string
  desc: string
  transport: McpTransport
  /** stdio 传输:本机命令 + 参数。 */
  command?: string
  args?: string[]
  /** sse/http 传输:远程 url(可含 <占位> 提示用户填 key)+ 可选鉴权头。 */
  url?: string
  headers?: Record<string, string>
  /** 需要用户填 key 才能用(url 里有占位或 headers 需鉴权)。 */
  needsKey?: boolean
  /** key 从哪申请 / 填哪的人话提示。 */
  keyHint?: string
  /** 需要的本机资产(如 'node';走资产下载器,未就绪时前端提示"正在准备")。 */
  needsAsset?: string
  /** 接入注意(安全/门槛),前端展示。 */
  note?: string
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'playwright',
    name: '浏览器自动化(Playwright)',
    desc: '让 AI 打开网页、点击、填表、截图——帮你在网页后台代操作。',
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    needsAsset: 'node',
    note: '需 Node 运行时(首次启用后台准备);属对外操作,每步走审批确认。',
  },
  {
    id: 'amap',
    name: '高德地图',
    desc: '查周边商圈/竞对、天气、路线规划——门店选址与活动排期用。',
    transport: 'sse',
    url: 'https://mcp.amap.com/sse?key=<在高德开放平台申请的KEY>',
    needsKey: true,
    keyHint: '高德开放平台(lbs.amap.com)申请 Web 服务 key 后填入。',
    note: '⚠️ 安全:客户端直连会把 key 写进本地配置(可被解压读取)。推荐由网关代理高德(key 藏服务端);壳子先备好,owner 给 key/定网关代理后接入。',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function defaultWritableMcpConfigPath(env: Record<string, string | undefined> = process.env): string {
  return join(desktopLibraryBase(env), '.mcp.json')
}

async function readDoc(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (isRecord(parsed)) {
      if (!isRecord(parsed.mcpServers)) parsed.mcpServers = {}
      return parsed
    }
  } catch {
    // Missing or broken config is treated as empty, matching the Python desktop path.
  }
  return { mcpServers: {} }
}

async function atomicWriteJson(path: string, doc: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map(x => x.trim()).filter(Boolean) : []
}

function serverMap(doc: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(doc.mcpServers)) doc.mcpServers = {}
  return doc.mcpServers as Record<string, unknown>
}

export async function addMcpServer(
  input: { name?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown; transport?: unknown; headers?: unknown },
  path = defaultWritableMcpConfigPath(),
): Promise<{ ok: boolean; message: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) return { ok: false, message: '请先给这个 MCP 起个名字。' }
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  const doc = await readDoc(path)
  const servers = serverMap(doc)
  const existed = Object.prototype.hasOwnProperty.call(servers, name)
  // 远程(url)MCP:SSE/HTTP 服务器(如高德)。type:'sse' 走旧式长连,否则 streamable http(对齐 normalizeMcpConfig)。
  if (url) {
    if (url.includes('<') && url.includes('>')) return { ok: false, message: '这个服务需要先把 url 里的 <…> 占位(如 API key)替换成真实值再添加。' }
    const cfg: Record<string, unknown> = { url }
    const transport = input.transport === 'sse' ? 'sse' : input.transport === 'http' ? 'http' : (url.includes('/sse') ? 'sse' : 'http')
    if (transport === 'sse') cfg.type = 'sse'
    if (isRecord(input.headers)) {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(input.headers)) if (typeof value === 'string') headers[key] = value
      if (Object.keys(headers).length > 0) cfg.headers = headers
    }
    servers[name] = cfg
    await atomicWriteJson(path, doc)
    return { ok: true, message: existed ? `已更新「${name}」。` : `已加上「${name}」，下次对话就能用了。` }
  }
  // 本机(command)MCP:stdio 进程(如 Playwright)。
  if (!command) return { ok: false, message: '命令或 url 至少要填一个。' }
  const cfg: Record<string, unknown> = { command, args: stringArray(input.args) }
  if (isRecord(input.env)) {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string') env[key] = value
    }
    if (Object.keys(env).length > 0) cfg.env = env
  }
  servers[name] = cfg
  await atomicWriteJson(path, doc)
  return { ok: true, message: existed ? `已更新「${name}」。` : `已加上「${name}」，下次对话就能用了。` }
}

export async function removeMcpServer(nameValue: unknown, path = defaultWritableMcpConfigPath()): Promise<{ ok: boolean; message: string }> {
  const name = typeof nameValue === 'string' ? nameValue.trim() : ''
  if (!name) return { ok: false, message: '没说要删哪个。' }
  const doc = await readDoc(path)
  const servers = serverMap(doc)
  if (!Object.prototype.hasOwnProperty.call(servers, name)) return { ok: false, message: `没找到「${name}」。` }
  delete servers[name]
  await atomicWriteJson(path, doc)
  return { ok: true, message: `已删掉「${name}」。` }
}

export async function setMcpServerDisabled(
  nameValue: unknown,
  disabled: unknown,
  path = defaultWritableMcpConfigPath(),
): Promise<{ ok: boolean; message: string }> {
  const name = typeof nameValue === 'string' ? nameValue.trim() : ''
  if (!name) return { ok: false, message: '没说要操作哪个。' }
  const doc = await readDoc(path)
  const servers = serverMap(doc)
  const raw = servers[name]
  if (!isRecord(raw)) return { ok: false, message: `没找到「${name}」。` }
  if (disabled === true) raw.disabled = true
  else delete raw.disabled
  await atomicWriteJson(path, doc)
  return { ok: true, message: disabled === true ? `已停用「${name}」。` : `已启用「${name}」。` }
}
