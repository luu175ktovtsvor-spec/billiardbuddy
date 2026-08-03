import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import {
  codexEngineManifestName,
  codexRipgrepBinaryName,
  isSupportedCodexEngineTarget,
  stagedCodexEngineBinaryName,
  verifyStagedCodexEngine,
} from './stage-codex-engine'

type JsonObject = Record<string, unknown>

function parseOptions(argv: string[]): { target: string; destinationDir: string } {
  let target: string | undefined
  let destinationDir = resolve(import.meta.dir, '..', 'runtime-assets', 'binaries')
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`${name ?? '参数'} 需要一个值`)
    if (name === '--target') target = value
    else if (name === '--destination') destinationDir = resolve(value)
    else throw new Error(`未知引擎 smoke 参数: ${name}`)
  }
  const requestedTarget = target ?? process.env.CODEX_ENGINE_TARGET
  if (!requestedTarget || !isSupportedCodexEngineTarget(requestedTarget)) {
    throw new Error('引擎 smoke 需要受支持的 --target 或 CODEX_ENGINE_TARGET')
  }
  return { target: requestedTarget, destinationDir }
}

async function verifyRuntimeSearch(target: string, destinationDir: string): Promise<void> {
  const supportedTarget = target as Parameters<typeof stagedCodexEngineBinaryName>[0]
  verifyStagedCodexEngine({ destinationDir, target: supportedTarget, verifyOnly: true })

  const engineHome = mkdtempSync(join(tmpdir(), 'billiardbuddy-engine-smoke-'))
  const resolvedHome = realpathSync(engineHome)
  const command = join(destinationDir, stagedCodexEngineBinaryName(supportedTarget))
  const managedRipgrep = join(destinationDir, codexRipgrepBinaryName(supportedTarget))
  let stderr = ''

  try {
    await new Promise<void>((resolveSmoke, rejectSmoke) => {
      const child = spawn(command, ['--listen', 'stdio://'], {
        cwd: resolvedHome,
        env: {
          ...process.env,
          CODEX_HOME: resolvedHome,
          PATH: `${destinationDir}${delimiter}${process.env.PATH ?? ''}`,
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdoutBuffer = ''
      let searchPassed = false
      let failure: Error | undefined
      const timer = setTimeout(() => {
        failure = new Error('受管 App Server/ripgrep smoke 超时')
        child.kill()
      }, 15_000)

      const fail = (error: unknown): void => {
        failure = error instanceof Error ? error : new Error(String(error))
        child.kill()
      }
      const write = (message: JsonObject): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      }

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
      })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        try {
          stdoutBuffer += String(chunk)
          for (;;) {
            const newline = stdoutBuffer.indexOf('\n')
            if (newline < 0) break
            const line = stdoutBuffer.slice(0, newline)
            stdoutBuffer = stdoutBuffer.slice(newline + 1)
            if (!line) continue
            const message = JSON.parse(line) as JsonObject
            if (message.id === 1) {
              if (message.error) throw new Error(`App Server 初始化失败: ${JSON.stringify(message.error)}`)
              const result = message.result as JsonObject | undefined
              if (result?.codexHome !== resolvedHome) throw new Error('App Server 未使用隔离的 BilliardBuddy smoke HOME')
              write({ jsonrpc: '2.0', method: 'initialized', params: {} })
              write({
                jsonrpc: '2.0',
                id: 2,
                method: 'thread/search',
                params: { searchTerm: 'billiardbuddy-managed-ripgrep-smoke', limit: 5 },
              })
            } else if (message.id === 2) {
              if (message.error) throw new Error(`thread/search 失败: ${JSON.stringify(message.error)}`)
              const result = message.result as JsonObject | undefined
              if (!Array.isArray(result?.data)) throw new Error('thread/search 未返回原生结果列表')
              searchPassed = true
              child.stdin.end()
            }
          }
        } catch (error) {
          fail(error)
        }
      })
      child.once('error', fail)
      child.once('close', code => {
        clearTimeout(timer)
        if (failure) {
          rejectSmoke(new Error(`${failure.message}${stderr ? `\n${stderr}` : ''}`))
        } else if (code !== 0 || !searchPassed) {
          rejectSmoke(new Error(`受管 App Server/ripgrep smoke 未完成: exit=${code ?? 'null'}${stderr ? `\n${stderr}` : ''}`))
        } else {
          resolveSmoke()
        }
      })

      write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'billiardbuddy-audit', title: 'BilliardBuddy Audit', version: '1.0.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })
    })
  } finally {
    rmSync(engineHome, { recursive: true, force: true })
  }

  console.log(`[codex-engine-smoke] ${target} initialized and thread/search used managed ${managedRipgrep}; ${codexEngineManifestName(supportedTarget)} verified`)
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2))
  await verifyRuntimeSearch(options.target, options.destinationDir)
}
