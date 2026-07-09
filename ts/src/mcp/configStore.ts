import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopLibraryBase } from '../harness/desktopEnvNames'

export const MCP_PRESETS: Array<{ id: string; name: string; desc: string; command: string; args: string[] }> = []

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
  input: { name?: unknown; command?: unknown; args?: unknown; env?: unknown },
  path = defaultWritableMcpConfigPath(),
): Promise<{ ok: boolean; message: string }> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!name) return { ok: false, message: '请先给这个 MCP 起个名字。' }
  if (!command) return { ok: false, message: '命令不能为空。' }
  const doc = await readDoc(path)
  const servers = serverMap(doc)
  const existed = Object.prototype.hasOwnProperty.call(servers, name)
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
