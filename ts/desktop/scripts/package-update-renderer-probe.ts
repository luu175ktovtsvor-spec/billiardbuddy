import {
  evaluateInPackagedRenderer,
  waitForPackagedRenderer,
  type PackagedRendererTarget,
} from './packaged-renderer-driver'

export type PackageUpdateAttempt = {
  hasUpdate?: unknown
  version?: unknown
  failed?: unknown
  error?: unknown
  events?: Array<{ event?: unknown }>
}

function updateExpression(): string {
  return `(async () => {
    const events = []
    const update = await window.desktopHost.updates.check()
    if (!update) return { hasUpdate: false, events }
    try {
      await update.download(event => events.push(event))
      return { hasUpdate: true, version: update.version, failed: false, events }
    } catch (error) {
      return { hasUpdate: true, version: update.version, failed: true, error: String(error), events }
    }
  })()`
}

export async function attemptPackageUpdate(target: PackagedRendererTarget): Promise<PackageUpdateAttempt> {
  return await evaluateInPackagedRenderer<PackageUpdateAttempt>(target, updateExpression(), 120_000)
}

export function requireFailedPackageUpdate(attempt: PackageUpdateAttempt, expectedVersion: string): void {
  if (attempt.hasUpdate !== true || attempt.version !== expectedVersion || attempt.failed !== true) {
    throw new Error(`更新下载中断未显式失败: ${JSON.stringify(attempt)}`)
  }
  if (typeof attempt.error !== 'string' || attempt.error.length === 0) {
    throw new Error('更新下载中断没有返回失败原因')
  }
}

export function requireRecoveredPackageUpdate(attempt: PackageUpdateAttempt, expectedVersion: string): void {
  if (attempt.hasUpdate !== true || attempt.version !== expectedVersion || attempt.failed !== false) {
    throw new Error(`重启后更新下载未恢复: ${JSON.stringify(attempt)}`)
  }
  const eventNames = attempt.events?.map(event => event.event)
  if (!eventNames?.includes('Started') || !eventNames.includes('Finished')) {
    throw new Error(`重启后更新进度不完整: ${JSON.stringify(eventNames)}`)
  }
}

function parseCli(argv: string[]): { port: number, expectedVersion: string, expectation: 'failed' | 'recovered' } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--port', '--expected-version', '--expect'].includes(name)) {
      throw new Error('用法: bun run package-update-renderer-probe.ts --port <port> --expected-version <version> --expect <failed|recovered>')
    }
    values.set(name, value)
  }
  const port = Number(values.get('--port'))
  const expectedVersion = values.get('--expected-version')
  const expectation = values.get('--expect')
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535 || !expectedVersion
    || (expectation !== 'failed' && expectation !== 'recovered')) {
    throw new Error('更新 renderer 验收参数不完整')
  }
  return { port, expectedVersion, expectation }
}

if (import.meta.main) {
  const input = parseCli(process.argv.slice(2))
  const target = await waitForPackagedRenderer(input.port, null)
  const attempt = await attemptPackageUpdate(target)
  if (input.expectation === 'failed') requireFailedPackageUpdate(attempt, input.expectedVersion)
  else requireRecoveredPackageUpdate(attempt, input.expectedVersion)
  console.log(JSON.stringify({ accepted: true, expectation: input.expectation, attempt }))
}
