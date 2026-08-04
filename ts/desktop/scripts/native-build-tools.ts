import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function resolveCargoCommand(errorMessage: string): string {
  const configured = process.env.CARGO?.trim()
  if (configured && existsSync(configured)) return configured
  const onPath = Bun.which('cargo')
  if (onPath) return onPath
  const cargoHome = process.env.CARGO_HOME?.trim() || join(homedir(), '.cargo')
  const rustupProxy = process.platform === 'win32'
    ? join(cargoHome, 'bin', 'cargo.exe')
    : join(cargoHome, 'bin', 'cargo')
  if (existsSync(rustupProxy)) return rustupProxy
  throw new Error(errorMessage)
}

function commandFailureDetail(result: ReturnType<typeof spawnSync>): string {
  return [result.error?.message, result.stdout, result.stderr]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .join('\n')
}

/**
 * Initialize MSVC in cmd, then invoke cl.exe directly with structured argv.
 * Keeping the compiler invocation out of the cmd command string avoids Bun's
 * Windows quote escaping turning valid compiler switches into file names.
 */
export function runMsvcCompiler(vcvarsPath: string, compilerArguments: string[], errorMessage: string): void {
  const initialized = spawnSync(process.env.ComSpec || 'cmd.exe', [
    '/d', '/c', 'call vcvars64.bat >nul && set',
  ], {
    cwd: dirname(vcvarsPath),
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (initialized.error || initialized.status !== 0) {
    const detail = commandFailureDetail(initialized)
    throw new Error(`${errorMessage}：无法初始化 MSVC${detail ? `\n${detail}` : ''}`)
  }

  const environment: NodeJS.ProcessEnv = {}
  for (const line of initialized.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    environment[line.slice(0, separator)] = line.slice(separator + 1)
  }
  const environmentKeys = Object.keys(environment).map(key => key.toLowerCase())
  if (!environmentKeys.includes('path') || !environmentKeys.includes('vctoolsinstalldir')) {
    throw new Error(`${errorMessage}：MSVC 初始化结果缺少 PATH 或 VCToolsInstallDir`)
  }

  const compiled = spawnSync('cl.exe', compilerArguments, {
    env: environment,
    encoding: 'utf8',
    timeout: 20 * 60_000,
  })
  if (compiled.error || compiled.status !== 0) {
    const detail = commandFailureDetail(compiled)
    throw new Error(`${errorMessage}${detail ? `\n${detail}` : ''}`)
  }
}

/**
 * Skills are shipped product instructions, not build notes. Keep internal
 * ownership and unfinished-roadmap language in source comments and contracts.
 */
export function verifyProductContent(contentPath: string): void {
  const source = readFileSync(contentPath, 'utf8')
  const forbidden = [
    /\bCodex\b.{0,80}\bapproval\b/i,
    /Rust Core/i,
    /current source/i,
    /under development/i,
    /not yet (?:available|implemented|supported)/i,
    /当前源码/,
    /尚未(?:开发|实现|支持|开放)/,
    /开发中/,
    /以后补/,
  ]
  const match = forbidden.find(pattern => pattern.test(source))
  if (match) throw new Error(`随包产品内容混入开发说明: ${contentPath} (${match.source})`)
}

export function verifyProductSkill(skillPath: string): void {
  verifyProductContent(skillPath)
}

function nativeRustTarget(): string | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin'
  if (process.platform === 'win32' && process.arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc'
  return undefined
}

/**
 * Execute only a native-target staged MCP binary. This proves that the file is
 * more than a large artifact: it must parse JSON-RPC, initialize and publish a
 * non-empty tool catalog before packaging proceeds.
 */
export function verifyStdioMcpHandshake(binary: string, target: string, expectedName: string): void {
  if (target !== nativeRustTarget()) return
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n')
  const result = spawnSync(binary, [], { input, encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
    throw new Error(`MCP 本机握手失败: ${expectedName}${detail ? `\n${detail}` : ''}`)
  }
  const messages = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  const initialized = messages.find(message => message.id === 1)?.result as Record<string, unknown> | undefined
  const serverInfo = initialized?.serverInfo as Record<string, unknown> | undefined
  const listed = messages.find(message => message.id === 2)?.result as Record<string, unknown> | undefined
  if (serverInfo?.name !== expectedName || !Array.isArray(listed?.tools) || listed.tools.length === 0) {
    throw new Error(`MCP 本机握手返回无效: ${expectedName}`)
  }
}
