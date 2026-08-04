import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type WindowsNativeTarget = 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc'

const WINDOWS_PE_MACHINE = {
  x64: 0x8664,
  arm64: 0xaa64,
} as const

export function windowsTargetForArch(arch: string): WindowsNativeTarget {
  if (arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 Windows 原生架构: ${arch}`)
}

export function windowsPeMachineForTarget(target: WindowsNativeTarget): number {
  return target === 'x86_64-pc-windows-msvc' ? WINDOWS_PE_MACHINE.x64 : WINDOWS_PE_MACHINE.arm64
}

export function windowsPeMachineName(machine: number): string {
  if (machine === WINDOWS_PE_MACHINE.x64) return 'x64'
  if (machine === WINDOWS_PE_MACHINE.arm64) return 'ARM64'
  return `未知 PE machine 0x${machine.toString(16)}`
}

/** Read the COFF machine from a PE image without executing untrusted package files. */
export function readWindowsPeMachine(bytes: Uint8Array, label = 'PE 文件'): number {
  const source = Buffer.from(bytes)
  if (source.length < 0x40 || source.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${label} 不是有效的 Windows PE 文件`)
  }
  const headerOffset = source.readUInt32LE(0x3c)
  if (headerOffset > source.length - 6 || source.readUInt32LE(headerOffset) !== 0x00004550) {
    throw new Error(`${label} 的 PE 头无效`)
  }
  return source.readUInt16LE(headerOffset + 4)
}

export function verifyWindowsPeMachine(path: string, target: WindowsNativeTarget): void {
  const machine = readWindowsPeMachine(readFileSync(path), path)
  const expected = windowsPeMachineForTarget(target)
  if (machine !== expected) {
    throw new Error(`${path} 的 PE 架构为 ${windowsPeMachineName(machine)}，预期 ${windowsPeMachineName(expected)}`)
  }
}

/**
 * All native runtime resources must match the Electron package target.
 * This catches a cross-build that stages host x64 helpers into an ARM64 app
 * before an installer is published.
 */
export function verifyWindowsExecutableTree(root: string, target: WindowsNativeTarget): void {
  const executables: string[] = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(?:exe|dll|node)$/i.test(entry.name)) executables.push(path)
    }
  }
  if (!existsSync(root)) throw new Error(`安装包缺少 Windows 原生资源目录: ${root}`)
  visit(root)
  if (executables.length === 0) throw new Error(`安装包没有可审计的 Windows 原生资源: ${root}`)
  for (const executable of executables) verifyWindowsPeMachine(executable, target)
}

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
  const vcvarsFile = basename(vcvarsPath)
  if (!/^vcvars[a-z0-9_]+\.bat$/i.test(vcvarsFile) || !existsSync(vcvarsPath)) {
    throw new Error(`${errorMessage}：MSVC 初始化脚本无效`)
  }
  const initialized = spawnSync(process.env.ComSpec || 'cmd.exe', [
    '/d', '/s', '/c', `call "${vcvarsFile}" >nul && set`,
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
