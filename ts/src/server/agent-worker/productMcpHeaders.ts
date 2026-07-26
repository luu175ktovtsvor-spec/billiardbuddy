import { lstat } from 'node:fs/promises'
import { productSubprocessEnvironment } from './productSubprocessEnvironment.js'

const MAX_OUTPUT_BYTES = 128 * 1024
const HELPER_TIMEOUT_MS = 10_000
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

async function boundedOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_OUTPUT_BYTES) throw new Error('MCP_HEADERS_HELPER_OUTPUT_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(output)
}

function parseHeaders(value: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('MCP_HEADERS_HELPER_OUTPUT_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP_HEADERS_HELPER_OUTPUT_INVALID')
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length > 128 || entries.some(([name, header]) => (
    !HEADER_NAME.test(name)
    || typeof header !== 'string'
    || header.length > 8_192
    || /[\r\n\0]/.test(header)
  ))) throw new Error('MCP_HEADERS_HELPER_OUTPUT_INVALID')
  return Object.fromEntries(entries) as Record<string, string>
}

export async function resolveProductMcpHeaders(
  staticHeaders: Record<string, string> | undefined,
  helper: string | undefined,
): Promise<Record<string, string>> {
  if (!helper) return staticHeaders ?? {}
  const stat = await lstat(helper).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('MCP_HEADERS_HELPER_UNAVAILABLE')
  const child = Bun.spawn([helper], {
    env: productSubprocessEnvironment(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => { try { child.kill() } catch {} }, HELPER_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedOutput(child.stdout),
      boundedOutput(child.stderr).catch(() => ''),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`MCP_HEADERS_HELPER_FAILED:${stderr.slice(0, 512)}`)
    return { ...(staticHeaders ?? {}), ...parseHeaders(stdout) }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) { try { child.kill() } catch {} }
  }
}
