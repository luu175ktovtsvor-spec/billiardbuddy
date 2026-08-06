import { dirname, resolve } from 'node:path'

const relayBase = (process.env.VIDEO_MEDIA_JOURNEY_BASE_URL ?? 'https://zzyppz.cn/video-media').replace(/\/+$/, '')
const gatewayBase = (process.env.VIDEO_MEDIA_JOURNEY_GATEWAY_BASE_URL ?? 'https://zzyppz.cn/gw').replace(/\/+$/, '')
const suppliedToken = process.env.VIDEO_MEDIA_JOURNEY_ACCESS_TOKEN?.trim()
const rounds = Number(process.env.VIDEO_MEDIA_JOURNEY_ROUNDS ?? '1')
const parallelism = Number(process.env.VIDEO_MEDIA_JOURNEY_PARALLELISM ?? '1')
const confirmation = process.env.VIDEO_MEDIA_JOURNEY_CONFIRMATION
const reportPath = process.env.VIDEO_MEDIA_JOURNEY_REPORT_PATH?.trim()

if (new URL(relayBase).protocol !== 'https:') throw new Error('VIDEO_MEDIA_JOURNEY_BASE_URL must use HTTPS')
if (new URL(gatewayBase).protocol !== 'https:') throw new Error('VIDEO_MEDIA_JOURNEY_GATEWAY_BASE_URL must use HTTPS')
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('VIDEO_MEDIA_JOURNEY_ROUNDS must be a positive integer')
if (!Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > rounds) throw new Error('VIDEO_MEDIA_JOURNEY_PARALLELISM must be from 1 to VIDEO_MEDIA_JOURNEY_ROUNDS')
if (confirmation !== `REAL_VIDEO_USER_JOURNEY_${rounds}_ROUNDS`) {
  throw new Error(`VIDEO_MEDIA_JOURNEY_CONFIRMATION must be REAL_VIDEO_USER_JOURNEY_${rounds}_ROUNDS`)
}
if (rounds * 4 > Number.MAX_SAFE_INTEGER) throw new Error('VIDEO_MEDIA_JOURNEY_ROUNDS is too large')

type Session = { access_token?: unknown; refresh_token?: unknown }
type JourneyResult = Readonly<{
  round: number
  status: 'passed' | 'failed'
  duration_ms: number
  provider_operations: 4
  error?: string
}>

const smokePath = resolve(dirname(new URL(import.meta.url).pathname), 'video-media-smoke.ts')
const safeError = (value: unknown): string => {
  const message = value instanceof Error ? value.message : String(value)
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(/https?:\/\/[^\s)]+/gi, '<url>')
    .slice(0, 500)
}

async function bootstrapSession(): Promise<{ accessToken: string; refreshToken?: string }> {
  if (suppliedToken) return { accessToken: suppliedToken }
  const installationId = `deployment-video-user-journey-${process.env.VIDEO_MEDIA_JOURNEY_INSTALLATION_SUFFIX?.trim() || 'shared'}`
  const response = await fetch(`${gatewayBase}/v1/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: installationId }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`video journey session bootstrap failed with ${response.status}`)
  const session = await response.json() as Session
  if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
    throw new Error('video journey session bootstrap omitted credentials')
  }
  return { accessToken: session.access_token, refreshToken: session.refresh_token }
}

async function logoutSession(accessToken: string, refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return
  const response = await fetch(`${gatewayBase}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 204) throw new Error(`video journey session logout failed with ${response.status}`)
}

async function runRound(round: number, accessToken: string): Promise<JourneyResult> {
  const startedAt = Date.now()
  const child = Bun.spawn([process.execPath, smokePath], {
    env: {
      ...process.env,
      VIDEO_MEDIA_SMOKE_BASE_URL: relayBase,
      VIDEO_MEDIA_SMOKE_ACCESS_TOKEN: accessToken,
      VIDEO_MEDIA_SMOKE_CONFIRMATION: 'FOUR_BILLED_VIDEO_OPERATIONS',
      VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS: '4',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const exitCode = await child.exited
  if (exitCode !== 0) {
    const diagnostic = safeError(stderr.trim() || stdout.trim() || `exit ${exitCode}`)
    return { round, status: 'failed', duration_ms: Date.now() - startedAt, provider_operations: 4, error: diagnostic }
  }
  if (!stdout.includes('VIDEO_MEDIA_SMOKE_OK')) {
    return { round, status: 'failed', duration_ms: Date.now() - startedAt, provider_operations: 4, error: 'smoke exited without success marker' }
  }
  return { round, status: 'passed', duration_ms: Date.now() - startedAt, provider_operations: 4 }
}

async function runAll(accessToken: string): Promise<readonly JourneyResult[]> {
  const results: JourneyResult[] = []
  let nextRound = 1
  while (nextRound <= rounds) {
    const batch = Array.from({ length: Math.min(parallelism, rounds - nextRound + 1) }, () => nextRound++)
    results.push(...await Promise.all(batch.map(round => runRound(round, accessToken))))
  }
  return results.sort((left, right) => left.round - right.round)
}

async function writeReport(results: readonly JourneyResult[], cleanup: 'passed' | 'failed'): Promise<void> {
  if (!reportPath) return
  const passed = results.filter(item => item.status === 'passed').length
  const failed = results.length - passed
  await Bun.write(reportPath, [
    '# Video Media Relay 真实用户旅程',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- Relay：${relayBase}`,
    `- 轮数：${rounds}`,
    `- 并发度：${parallelism}`,
    `- Provider 调用数：${rounds * 4}`,
    `- 通过：${passed}`,
    `- 失败：${failed}`,
    `- 会话清理：${cleanup}`,
    '',
    '## 每轮结果',
    '',
    '| 轮次 | 结果 | Provider 操作 | 耗时 | 错误 |',
    '| ---: | --- | ---: | ---: | --- |',
    ...results.map(item => `| ${item.round} | ${item.status} | ${item.provider_operations} | ${item.duration_ms} ms | ${item.error ?? ''} |`),
    '',
    '## 说明',
    '',
    '- 每轮复用同一真实 Video Media Relay API 路径，覆盖视觉、Embedding、规划、Fun-ASR、OSS multipart、幂等回放、ACK 和清理。',
    '- 轮数和并发度是本次测试编排参数，不是生产服务额度；正式 Provider/OSS 额度、权限、超时和恢复边界仍必须生效。',
    '- 报告不保存 bearer、DashScope Key、OSS AccessKey、签名 URL 或完整 Provider 回执。',
  ].join('\n'))
}

const session = await bootstrapSession()
let results: readonly JourneyResult[] = []
let primaryError: unknown
try {
  results = await runAll(session.accessToken)
  if (results.some(item => item.status === 'failed')) throw new Error(`video user journey failed: ${results.filter(item => item.status === 'failed').length}/${rounds}`)
} catch (error) {
  primaryError = error
}

let cleanup: 'passed' | 'failed' = 'passed'
try {
  await logoutSession(session.accessToken, session.refreshToken)
} catch (error) {
  cleanup = 'failed'
  primaryError = primaryError ? new AggregateError([primaryError, error], 'video journey and session cleanup failed') : error
}
await writeReport(results, cleanup)
if (primaryError) throw primaryError
console.log(`VIDEO_MEDIA_USER_JOURNEY_OK rounds=${rounds} provider_operations=${rounds * 4} parallelism=${parallelism}`)
