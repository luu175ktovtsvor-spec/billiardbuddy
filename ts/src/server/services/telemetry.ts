import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'

/**
 * 诊断遥测上传器(task#16 重接,对接已部署的 dataeye receiver):
 * - 契约对齐 dataeye/receiver/app.ts:`POST /ingest`、`Authorization: Bearer`、可 gzip、
 *   body=`{machine_id, batch:[{kind, ref_id, payload}]}`,服务端按 (machine_id,kind,ref_id) 幂等。
 * - v1 只做**开机上传**两类:①app_boot 心跳(kind:'event',进看板活跃模块)②上次运行留下的
 *   崩溃日志(kind:'diag',落 raw_inbox)。崩溃文件名当 ref_id → 服务端幂等去重,本地零记账。
 *   不挂运行时热路径、不起常驻定时器——够试用期"店主机器崩了我们看得见",再多是鸡肋。
 * - 静默(owner 拍板:不告知/不加开关,数据只回自有服务器);失败静默吞,下次开机自然重试。
 * - 脱敏:home 目录→~、常见密钥形态→[redacted]、内容截断;只传白名单字段,绝不传对话/门店资料。
 */

/** 只用到 (url, init) → Response 这一段签名;放宽类型让测试传裸函数(不必实现 fetch.preconnect)。 */
export type TelemetryFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface TelemetryOptions {
  stateRoot: string
  env?: Record<string, string | undefined>
  fetchImpl?: TelemetryFetch
  /** 单次开机最多上传的崩溃文件数(防日志堆积撑爆请求)。 */
  maxCrashFiles?: number
}

export interface TelemetryBatchItem {
  kind: string
  ref_id: string
  payload: Record<string, unknown>
}

const MAX_CRASH_CONTENT_CHARS = 4000
const UPLOAD_TIMEOUT_MS = 10_000

/** 脱敏:home 路径归一 + 密钥形态遮蔽 + 截断。白名单字段之外的内容不进 payload。 */
export function sanitizeDiagnosticText(text: string): string {
  let out = text.slice(0, MAX_CRASH_CONTENT_CHARS)
  const home = homedir()
  if (home && home !== '/') out = out.split(home).join('~')
  // 常见密钥形态:sk-/rl_/Bearer xxx/长 hex·base64 串;宁可多遮不可漏遮(这是发出去的数据)。
  out = out
    .replace(/\b(sk|rl|ak|pk)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, '[redacted]')
  return out
}

function stableMachineId(stateRoot: string): string {
  const file = join(stateRoot, 'machine-id')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  } catch {
    // 首次运行,落新 id
  }
  const id = randomUUID()
  try {
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(file, `${id}\n`, 'utf8')
  } catch {
    // 写不进也不崩:本次用内存 id(下次开机会换,幂等键随之变,最坏是重复一条心跳)
  }
  return id
}

export function createTelemetryService(opts: TelemetryOptions) {
  const env = opts.env ?? process.env
  const baseUrl = (env.QF_DATAEYE_URL ?? '').trim().replace(/\/$/, '')
  const token = (env.QF_DATAEYE_TOKEN ?? '').trim()
  const enabled = !!baseUrl && !!token
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const maxCrashFiles = opts.maxCrashFiles ?? 20

  async function postBatch(batch: TelemetryBatchItem[]): Promise<boolean> {
    if (!enabled || batch.length === 0) return false
    const body = gzipSync(Buffer.from(JSON.stringify({ machine_id: stableMachineId(opts.stateRoot), batch }), 'utf8'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body,
        signal: controller.signal,
      })
      return res.ok
    } catch {
      return false // 静默:诊断通道绝不影响主流程,失败下次开机重试(崩溃文件幂等)
    } finally {
      clearTimeout(timer)
    }
  }

  function collectCrashItems(appVersion: string): TelemetryBatchItem[] {
    const logDir = join(opts.stateRoot, 'logs')
    let names: string[] = []
    try {
      names = readdirSync(logDir).filter(name => name.startsWith('crash-') && name.endsWith('.log'))
    } catch {
      return []
    }
    return names.sort().slice(-maxCrashFiles).map(name => {
      let content = ''
      try {
        content = sanitizeDiagnosticText(readFileSync(join(logDir, name), 'utf8'))
      } catch {
        content = '(crash log unreadable)'
      }
      return {
        kind: 'diag',
        ref_id: name, // 文件名含时间戳+序号,天然幂等键:服务端 raw_inbox 冲突即去重,跨次开机不重复入库
        payload: { source: 'crash_log', file: name, content, app_version: appVersion, platform: process.platform },
      }
    })
  }

  return {
    enabled,
    /** 开机上传:心跳 + 上次运行的崩溃日志。fire-and-forget,任何失败都静默。 */
    async uploadOnBoot(appVersion: string): Promise<{ sent: number }> {
      if (!enabled) return { sent: 0 }
      const bootId = `boot-${randomUUID()}`
      const batch: TelemetryBatchItem[] = [
        {
          kind: 'event',
          ref_id: bootId,
          payload: {
            event_id: bootId,
            event: 'app_boot',
            props: { app_version: appVersion, platform: process.platform, arch: process.arch },
            created_at: new Date().toISOString(),
          },
        },
        ...collectCrashItems(appVersion),
      ]
      const ok = await postBatch(batch)
      return { sent: ok ? batch.length : 0 }
    },
  }
}
