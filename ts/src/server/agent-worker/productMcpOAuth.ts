import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type OAuthClientProvider, type OAuthDiscoveryState, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { getProductConfigDir } from '../product/productPaths.js'
import { lock } from '../../utils/lockfile.js'
import type { ScopedProductMcpServerConfig } from './productMcpConfig.js'
import { resolveProductMcpHeaders } from './productMcpHeaders.js'

export const PRODUCT_MCP_OAUTH_KEY_ENV = 'BILLIARDBUDDY_MCP_OAUTH_KEY'
const DEFAULT_CALLBACK_PORT = 31_997
const FLOW_TIMEOUT_MS = 5 * 60_000
const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024

type RemoteConfig = Extract<ScopedProductMcpServerConfig, { url: string }>
type StoredCredential = {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

type AuthorizationFlow = {
  id: string
  serverName: string
  state: string
  status: 'pending' | 'connected' | 'failed' | 'expired'
  authorizationUrl?: string
  error?: 'MCP_OAUTH_FAILED' | 'MCP_OAUTH_EXPIRED'
  expiresAt: number
  callbackServer: Server
  timeout: ReturnType<typeof setTimeout>
}

let processMasterKey: string | undefined
const authorizationFlows = new Map<string, AuthorizationFlow>()

function validMasterKey(value: string | undefined): value is string {
  if (!value) return false
  try { return Buffer.from(value, 'base64url').length === 32 } catch { return false }
}

/** A server process creates one ephemeral key when Electron has not injected its persisted key. */
export function getProductMcpOAuthMasterKey(): string {
  const inherited = process.env[PRODUCT_MCP_OAUTH_KEY_ENV]
  if (validMasterKey(inherited)) return inherited
  processMasterKey ??= randomBytes(32).toString('base64url')
  return processMasterKey
}

function credentialId(serverName: string, config: RemoteConfig): string {
  return createHash('sha256').update(`${serverName}\0${config.url}\0${config.oauth?.clientId ?? ''}`).digest('hex')
}

function credentialPath(serverName: string, config: RemoteConfig): string {
  return path.join(getProductConfigDir(), 'mcp-oauth', `${credentialId(serverName, config)}.bin`)
}

function encryptCredential(value: StoredCredential): Buffer {
  const key = Buffer.from(getProductMcpOAuthMasterKey(), 'base64url')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('BBMO1'), iv, cipher.getAuthTag(), encrypted])
}

function decryptCredential(value: Buffer): StoredCredential {
  if (value.length < 34 || value.subarray(0, 5).toString() !== 'BBMO1') throw new Error('MCP_OAUTH_CREDENTIAL_INVALID')
  const key = Buffer.from(getProductMcpOAuthMasterKey(), 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(5, 17))
  decipher.setAuthTag(value.subarray(17, 33))
  const parsed = JSON.parse(Buffer.concat([decipher.update(value.subarray(33)), decipher.final()]).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP_OAUTH_CREDENTIAL_INVALID')
  return parsed as StoredCredential
}

async function readCredential(serverName: string, config: RemoteConfig): Promise<StoredCredential> {
  const file = credentialPath(serverName, config)
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CREDENTIAL_BYTES) throw new Error('MCP_OAUTH_CREDENTIAL_INVALID')
    return decryptCredential(await fs.readFile(file))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeCredential(serverName: string, config: RemoteConfig, value: StoredCredential): Promise<void> {
  const file = credentialPath(serverName, config)
  const directory = path.dirname(file)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await fs.lstat(file).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('MCP_OAUTH_CREDENTIAL_INVALID')
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(encryptCredential(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600).catch(() => undefined)
    const directoryHandle = await fs.open(directory, fsConstants.O_RDONLY)
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

async function withCredentialLock<T>(serverName: string, config: RemoteConfig, operation: () => Promise<T>): Promise<T> {
  const file = credentialPath(serverName, config)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const guard = `${file}.guard`
  await fs.open(guard, 'a', 0o600).then(handle => handle.close())
  const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
  try { return await operation() } finally { await release() }
}

async function updateCredential(serverName: string, config: RemoteConfig, update: (value: StoredCredential) => StoredCredential): Promise<void> {
  await withCredentialLock(serverName, config, async () => writeCredential(serverName, config, update(await readCredential(serverName, config))))
}

export async function deleteProductMcpOAuthCredential(serverName: string, config: ScopedProductMcpServerConfig): Promise<void> {
  if ((config.type !== 'http' && config.type !== 'sse') || !config.oauth) return
  const remote = config as RemoteConfig
  await withCredentialLock(serverName, remote, () => fs.rm(credentialPath(serverName, remote), { force: true }))
}

export class ProductMcpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata
  constructor(
    private readonly serverName: string,
    private readonly config: RemoteConfig,
    readonly redirectUrl: string,
    private readonly authorizationState: string,
    private readonly onAuthorization: (url: URL) => void = () => undefined,
  ) {
    this.clientMetadata = {
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'BilliardBuddy',
      software_id: 'billiardbuddy',
      software_version: '1',
    }
  }
  state(): string { return this.authorizationState }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.oauth?.clientId) return { client_id: this.config.oauth.clientId }
    return (await readCredential(this.serverName, this.config)).clientInformation
  }
  saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    return updateCredential(this.serverName, this.config, value => ({ ...value, clientInformation }))
  }
  async tokens(): Promise<OAuthTokens | undefined> { return (await readCredential(this.serverName, this.config)).tokens }
  saveTokens(tokens: OAuthTokens): Promise<void> {
    return updateCredential(this.serverName, this.config, value => ({ ...value, tokens, codeVerifier: undefined }))
  }
  redirectToAuthorization(authorizationUrl: URL): void { this.onAuthorization(authorizationUrl) }
  saveCodeVerifier(codeVerifier: string): Promise<void> {
    return updateCredential(this.serverName, this.config, value => ({ ...value, codeVerifier }))
  }
  async codeVerifier(): Promise<string> {
    const verifier = (await readCredential(this.serverName, this.config)).codeVerifier
    if (!verifier) throw new Error('MCP_OAUTH_CODE_VERIFIER_MISSING')
    return verifier
  }
  saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    return updateCredential(this.serverName, this.config, value => ({ ...value, discoveryState }))
  }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await readCredential(this.serverName, this.config)).discoveryState }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') return updateCredential(this.serverName, this.config, () => ({}))
    await updateCredential(this.serverName, this.config, value => {
      const next = { ...value }
      if (scope === 'client') delete next.clientInformation
      if (scope === 'tokens') delete next.tokens
      if (scope === 'verifier') delete next.codeVerifier
      if (scope === 'discovery') delete next.discoveryState
      return next
    })
  }
}

async function remoteTransport(config: RemoteConfig, provider: OAuthClientProvider) {
  const headers = await resolveProductMcpHeaders(config.headers, config.headersHelper)
  const requestInit = { headers: { 'User-Agent': 'BilliardBuddy', ...headers } }
  return config.type === 'sse'
    ? new SSEClientTransport(new URL(config.url), { requestInit, authProvider: provider })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit, authProvider: provider })
}

export function productMcpOAuthProvider(serverName: string, config: RemoteConfig, redirectUrl?: string): ProductMcpOAuthProvider {
  const port = config.oauth?.callbackPort ?? DEFAULT_CALLBACK_PORT
  return new ProductMcpOAuthProvider(serverName, config, redirectUrl ?? `http://127.0.0.1:${port}/oauth/callback`, randomBytes(24).toString('base64url'))
}

function closeServer(server: Server): void { server.closeAllConnections?.(); server.close() }

function safeAuthorizationUrl(value: URL): boolean {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(value.hostname)
  return !value.username && !value.password && (value.protocol === 'https:' || (value.protocol === 'http:' && loopback))
}

function html(success: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>BilliardBuddy</title></head><body><h1>${success ? 'Authorization complete' : 'Authorization failed'}</h1><p>${success ? 'You can close this window and return to BilliardBuddy.' : 'Return to BilliardBuddy and try again.'}</p></body></html>`
}

export type ProductMcpAuthorizationStart = { flowId?: string; authorizationUrl?: string; expiresAt?: number; connected: boolean }
export type ProductMcpAuthorizationStatus = { status: 'pending' | 'connected' | 'failed' | 'expired'; error?: 'MCP_OAUTH_FAILED' | 'MCP_OAUTH_EXPIRED' }

export async function beginProductMcpAuthorization(serverName: string, config: ScopedProductMcpServerConfig): Promise<ProductMcpAuthorizationStart> {
  if ((config.type !== 'http' && config.type !== 'sse') || !config.oauth) throw new Error('MCP_OAUTH_NOT_CONFIGURED')
  const remote = config as RemoteConfig
  const oauth = config.oauth
  const id = randomUUID()
  const state = randomBytes(24).toString('base64url')
  let flow: AuthorizationFlow | undefined
  let transport: Awaited<ReturnType<typeof remoteTransport>> | undefined
  let client: Client | undefined
  const callbackServer = createServer((request, response) => {
    void (async () => {
      if (!flow || request.method !== 'GET') { response.writeHead(404).end(); return }
      const url = new URL(request.url ?? '/', `http://127.0.0.1`)
      if (url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(html(false)); return
      }
      const code = url.searchParams.get('code')
      if (!code || url.searchParams.has('error') || !transport) throw new Error('MCP_OAUTH_CALLBACK_INVALID')
      await transport.finishAuth(code)
      await client?.close().catch(() => undefined)
      const verifyProvider = productMcpOAuthProvider(serverName, remote, `http://127.0.0.1:${remote.oauth?.callbackPort ?? DEFAULT_CALLBACK_PORT}/oauth/callback`)
      const verifyTransport = await remoteTransport(remote, verifyProvider)
      const verifyClient = new Client({ name: 'billiardbuddy', title: 'BilliardBuddy', version: '1.0.0' }, { capabilities: {} })
      try { await verifyClient.connect(verifyTransport) } finally { await verifyClient.close().catch(() => undefined) }
      flow.status = 'connected'
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html(true))
      clearTimeout(flow.timeout)
      closeServer(callbackServer)
    })().catch(() => {
      if (flow) { flow.status = 'failed'; flow.error = 'MCP_OAUTH_FAILED'; clearTimeout(flow.timeout) }
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(html(false))
      closeServer(callbackServer)
    })
  })
  const port = await new Promise<number>((resolve, reject) => {
    callbackServer.once('error', reject)
    callbackServer.listen(oauth.callbackPort ?? DEFAULT_CALLBACK_PORT, '127.0.0.1', () => {
      const address = callbackServer.address()
      if (!address || typeof address === 'string') return reject(new Error('MCP_OAUTH_CALLBACK_UNAVAILABLE'))
      resolve(address.port)
    })
  })
  let authorizationUrl: URL | undefined
  const provider = new ProductMcpOAuthProvider(serverName, remote, `http://127.0.0.1:${port}/oauth/callback`, state, url => { authorizationUrl = url })
  transport = await remoteTransport(remote, provider)
  client = new Client({ name: 'billiardbuddy', title: 'BilliardBuddy', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await client.close().catch(() => undefined)
    closeServer(callbackServer)
    return { connected: true }
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !authorizationUrl || !safeAuthorizationUrl(authorizationUrl)) {
      await client.close().catch(() => undefined)
      closeServer(callbackServer)
      throw new Error('MCP_OAUTH_FAILED')
    }
  }
  const expiresAt = Date.now() + FLOW_TIMEOUT_MS
  const timeout = setTimeout(() => {
    if (!flow || flow.status !== 'pending') return
    flow.status = 'expired'; flow.error = 'MCP_OAUTH_EXPIRED'; closeServer(callbackServer)
  }, FLOW_TIMEOUT_MS)
  timeout.unref?.()
  flow = { id, serverName, state, status: 'pending', authorizationUrl: authorizationUrl.toString(), expiresAt, callbackServer, timeout }
  authorizationFlows.set(id, flow)
  return { connected: false, flowId: id, authorizationUrl: flow.authorizationUrl, expiresAt }
}

export function productMcpAuthorizationStatus(serverName: string, flowId: string): ProductMcpAuthorizationStatus {
  const flow = authorizationFlows.get(flowId)
  if (!flow || flow.serverName !== serverName) throw new Error('MCP_OAUTH_FLOW_NOT_FOUND')
  return { status: flow.status, ...(flow.error ? { error: flow.error } : {}) }
}
