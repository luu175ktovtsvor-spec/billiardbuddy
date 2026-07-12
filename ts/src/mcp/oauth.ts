// MCP 远程 server 的 OAuth 授权(行为对齐 cc services/mcp/auth.ts:动态注册/PKCE/刷新/401 step-up/令牌落盘;
// 实现走官方 SDK 的 OAuthClientProvider 契约——SSE/StreamableHTTP transport 原生消费 authProvider:
// 有令牌自动附带、过期自动刷新、需要授权时由 SDK auth() 完成发现(RFC 9728/8414)+动态注册(RFC 7591)+
// PKCE 授权码流,我们只补"cc 里属于宿主的那一半":令牌持久化、本地回调端口、拉起浏览器、state 防伪。
// claude.ai/XAA 专有分支为 cc 产品私货,不移植(本产品 N/A)。

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

export interface McpOAuthProviderOptions {
  serverName: string
  /** 凭据落盘目录;缺省 ~/.billiardbuddy/state/mcp-oauth(server 侧应显式传 resolveStateRoot 派生目录)。 */
  storageDir?: string
  scopes?: string[]
  /** 动态注册时展示给授权页的应用名(白标)。 */
  clientName?: string
  /** 拉起浏览器(测试注入;默认按平台 open/start/xdg-open,失败静默——URL 另经 lastAuthorizationUrl 暴露)。 */
  openAuthUrl?: (url: string) => void | Promise<void>
  /** 等用户在浏览器完成授权的上限;超时判授权失败(默认 5 分钟)。 */
  callbackTimeoutMs?: number
}

interface PersistedOAuth {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  state?: string
}

export function defaultOAuthStorageDir(): string {
  return join(homedir(), '.billiardbuddy', 'state', 'mcp-oauth')
}

/** 按平台拉起系统浏览器;spawn 失败不抛(无头环境),调用方可用 lastAuthorizationUrl 把链接展示给用户。 */
export function defaultOpenAuthUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    const child = platform === 'darwin'
      ? spawn('open', [url], { stdio: 'ignore', detached: true })
      : platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', () => undefined)
  } catch {
    // 静默:authorization URL 已存 lastAuthorizationUrl,由上层提示用户手动打开。
  }
}

function fileSlug(name: string): string {
  const replaced = name.replace(/[^A-Za-z0-9_-]/g, '_')
  if (/[A-Za-z0-9]/.test(replaced)) return replaced
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0
  return `srv-${h.toString(36).slice(0, 6)}`
}

const CALLBACK_DONE_HTML = '<!doctype html><meta charset="utf-8"><title>授权完成</title><body style="font-family:system-ui;padding:40px">✅ 授权完成,可以关闭本页回到应用。</body>'

export class McpOAuthProvider implements OAuthClientProvider {
  private readonly opts: McpOAuthProviderOptions
  private readonly filePath: string
  private data: PersistedOAuth
  /** 最近一次要求用户打开的授权链接(浏览器拉不起来时供上层展示)。 */
  lastAuthorizationUrl?: string
  private callback?: {
    server: Server
    port: number
    promise: Promise<string>
    resolve: (code: string) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }

  constructor(opts: McpOAuthProviderOptions) {
    this.opts = opts
    const dir = opts.storageDir ?? defaultOAuthStorageDir()
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, `${fileSlug(opts.serverName)}.json`)
    this.data = this.load()
  }

  private load(): PersistedOAuth {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedOAuth
    } catch {
      return {}
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 })
  }

  // —— SDK OAuthClientProvider 契约 ——

  get redirectUrl(): string | undefined {
    return this.callback ? `http://127.0.0.1:${this.callback.port}/callback` : undefined
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'BilliardBuddy',
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    }
  }

  state(): string {
    // 每轮授权流一个 state(CSRF 防伪):SDK 在构造授权 URL 时调用;回调端校验一致才收 code。
    if (!this.data.state) {
      this.data.state = randomUUID()
      this.save()
    }
    return this.data.state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.data.clientInformation = clientInformation
    this.save()
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens
    // 授权流收尾:state/codeVerifier 一次性,用完即清。
    delete this.data.state
    delete this.data.codeVerifier
    this.save()
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.lastAuthorizationUrl = authorizationUrl.toString()
    await (this.opts.openAuthUrl ?? defaultOpenAuthUrl)(this.lastAuthorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.data.codeVerifier = codeVerifier
    this.save()
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error(`MCP server ${this.opts.serverName}: 授权流缺 codeVerifier(流程未从头开始?)`)
    return this.data.codeVerifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.data = {}
      try {
        rmSync(this.filePath, { force: true })
      } catch {
        // 尽力而为
      }
      return
    }
    if (scope === 'client') delete this.data.clientInformation
    if (scope === 'tokens') delete this.data.tokens
    if (scope === 'verifier') delete this.data.codeVerifier
    this.save()
  }

  // —— 宿主侧:本地回调 + 等码 ——

  /** 是否已持有令牌(粗判:有 access_token 即真;有效性由 transport 附带后服务端裁决,401 再走 step-up)。 */
  hasTokens(): boolean {
    return !!this.data.tokens?.access_token
  }

  /**
   * 交互授权前置:起 127.0.0.1 临时回调端口(port 0 随机),让 redirectUrl/clientMetadata.redirect_uris
   * 在 SDK 动态注册前就绪。幂等:已在听则复用。
   */
  async prepareInteractive(): Promise<void> {
    if (this.callback) return
    // 新授权流:旧 state 作废,强制生成新的(防上一轮残留被重放)。
    delete this.data.state
    let resolveCode!: (code: string) => void
    let rejectCode!: (err: Error) => void
    const promise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    // 提前挂 catch:超时/失败时若上层尚未 await(如 tryConnect 先抛了别的错),不产生 unhandled rejection。
    promise.catch(() => undefined)
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (!code || !state || state !== this.data.state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state 校验失败或缺参数,请回到应用重试授权。')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CALLBACK_DONE_HTML)
      resolveCode(code)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const timer = setTimeout(() => {
      rejectCode(new Error(`MCP server ${this.opts.serverName}: 等待浏览器授权超时(${Math.round((this.opts.callbackTimeoutMs ?? 300_000) / 1000)}s)`))
    }, this.opts.callbackTimeoutMs ?? 300_000)
    this.callback = { server, port, promise, resolve: resolveCode, reject: rejectCode, timer }
  }

  async waitForAuthorizationCode(): Promise<string> {
    if (!this.callback) throw new Error(`MCP server ${this.opts.serverName}: 回调服务未启动(先 prepareInteractive)`)
    return this.callback.promise
  }

  closeCallback(): void {
    if (!this.callback) return
    clearTimeout(this.callback.timer)
    this.callback.reject(new Error('授权流已关闭'))
    this.callback.server.close()
    this.callback = undefined
  }
}
