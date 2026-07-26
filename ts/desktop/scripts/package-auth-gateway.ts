import { createServer, type Server } from 'node:https'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ACCEPTANCE_BOOTSTRAP = 'package-acceptance-bootstrap'
export const PACKAGE_ACCEPTANCE_LICENSE = 'package-acceptance-license'

export type PackageAuthGateway = {
  url: string
  bootstrapCredential: string
  licenseKey: string
  caPath: string
  close(): Promise<void>
}

async function body(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 64 * 1024) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body is invalid')
  return value as Record<string, unknown>
}

function json(response: import('node:http').ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) {
    response.writeHead(status).end()
    return
  }
  const encoded = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) })
  response.end(encoded)
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
  })
}

export async function startPackageAuthGateway(): Promise<PackageAuthGateway> {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const caPath = join(fixtureDir, 'package-acceptance-cert.pem.fixture')
  const server = createServer({
    key: readFileSync(join(fixtureDir, 'package-acceptance-key.pem.fixture')),
    cert: readFileSync(caPath),
  }, async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
      if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' })
      const input = await body(request)
      if (pathname === '/gw/v1/auth/activate') {
        if (request.headers.authorization !== `Bearer ${PACKAGE_ACCEPTANCE_BOOTSTRAP}`
          || input.license_key !== PACKAGE_ACCEPTANCE_LICENSE
          || typeof input.installation_id !== 'string'
          || input.installation_id.length === 0) {
          return json(response, 401, { error: 'unauthorized' })
        }
        return json(response, 200, {
          access_token: 'package-acceptance-access',
          refresh_token: 'package-acceptance-refresh',
          expires_at: Date.now() + 10 * 60_000,
          token_type: 'Bearer',
        })
      }
      if (pathname === '/gw/v1/auth/refresh' && input.refresh_token === 'package-acceptance-refresh') {
        return json(response, 200, {
          access_token: 'package-acceptance-access-refreshed',
          refresh_token: 'package-acceptance-refresh',
          expires_at: Date.now() + 10 * 60_000,
          token_type: 'Bearer',
        })
      }
      if (pathname === '/gw/v1/auth/logout' && input.refresh_token === 'package-acceptance-refresh') {
        return json(response, 204)
      }
      return json(response, 404, { error: 'not_found' })
    } catch {
      return json(response, 400, { error: 'bad_request' })
    }
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('本地安装包激活服务没有获得监听端口')
  }
  return {
    url: `https://127.0.0.1:${address.port}/gw`,
    bootstrapCredential: PACKAGE_ACCEPTANCE_BOOTSTRAP,
    licenseKey: PACKAGE_ACCEPTANCE_LICENSE,
    caPath,
    close: () => closeServer(server),
  }
}

function readyFile(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--ready-file' || !argv[1]) {
    throw new Error('用法: bun run package-auth-gateway.ts --ready-file <path>')
  }
  return resolve(argv[1])
}

if (import.meta.main) {
  const gateway = await startPackageAuthGateway()
  writeFileSync(readyFile(process.argv.slice(2)), `${JSON.stringify({
    url: gateway.url,
    bootstrapCredential: gateway.bootstrapCredential,
    licenseKey: gateway.licenseKey,
    caPath: gateway.caPath,
  })}\n`, { mode: 0o600 })
  const stop = () => void gateway.close().finally(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await new Promise(() => undefined)
}
