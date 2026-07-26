import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import * as os from 'node:os'
import * as path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { productSubprocessEnvironment } from './productSubprocessEnvironment.js'

const OUTPUT_LIMIT_BYTES = 512 * 1024
let sandboxQueue: Promise<void> = Promise.resolve()

export type ProductShellResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

async function boundedText(stream: ReadableStream<Uint8Array> | null): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let kept = 0
  let truncated = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (kept >= OUTPUT_LIMIT_BYTES) { truncated = true; continue }
      const remaining = OUTPUT_LIMIT_BYTES - kept
      const value = next.value.byteLength <= remaining ? next.value : next.value.slice(0, remaining)
      chunks.push(value)
      kept += value.byteLength
      if (value.byteLength !== next.value.byteLength) truncated = true
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(kept)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return { text: new TextDecoder().decode(merged), truncated }
}

function runtimeConfig(workDir: string, envelope: PermissionExecutionEnvelope): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: envelope.network_scope === 'denied' ? [] : ['*'],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: [os.homedir()],
      allowRead: [workDir],
      allowWrite: [workDir, os.tmpdir()],
      denyWrite: [],
      allowGitConfig: false,
    },
  }
}

async function spawnCommand(command: string, cwd: string, signal: AbortSignal, timeoutMs: number, wrapped = false, stdin?: string, env?: Record<string, string>): Promise<ProductShellResult> {
  const isWindows = process.platform === 'win32'
  const executable = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
  const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command]
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env: productSubprocessEnvironment(env),
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const stop = () => { try { child.kill() } catch {} }
  const onAbort = () => stop()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  try {
    if (stdin !== undefined) {
      if (!child.stdin || typeof child.stdin === 'number') throw new Error('PRODUCT_SHELL_STDIN_UNAVAILABLE')
      child.stdin.write(stdin)
      child.stdin.end()
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedText(child.stdout),
      boundedText(child.stderr),
      child.exited,
    ])
    if (signal.aborted) throw new Error('PRODUCT_SHELL_ABORTED')
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (wrapped) SandboxManager.cleanupAfterCommand()
  }
}

async function withSandboxLock<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = sandboxQueue
  sandboxQueue = new Promise<void>(resolve => { release = resolve })
  await previous
  try { return await operation() } finally { release() }
}

export async function runProductShell(input: {
  command: string
  workDir: string
  timeoutMs: number
  signal: AbortSignal
  envelope: PermissionExecutionEnvelope
  stdin?: string
  env?: Record<string, string>
}): Promise<ProductShellResult> {
  const cwd = await realpath(path.resolve(input.workDir))
  if (input.envelope.sandbox_profile === 'unrestricted') {
    return spawnCommand(input.command, cwd, input.signal, input.timeoutMs, false, input.stdin, input.env)
  }
  return withSandboxLock(async () => {
    if (input.signal.aborted) throw new Error('PRODUCT_SHELL_ABORTED')
    if (!SandboxManager.isSupportedPlatform()) throw new Error('PRODUCT_SHELL_SANDBOX_UNAVAILABLE')
    await SandboxManager.reset().catch(() => undefined)
    try {
      await SandboxManager.initialize(runtimeConfig(cwd, input.envelope))
      const wrapped = await SandboxManager.wrapWithSandbox(input.command, '/bin/sh', undefined, input.signal)
      return await spawnCommand(wrapped, cwd, input.signal, input.timeoutMs, true, input.stdin, input.env)
    } finally {
      await SandboxManager.reset().catch(() => undefined)
    }
  })
}
