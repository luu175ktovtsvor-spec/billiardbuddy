import { createHash, X509Certificate } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'

export type PackageUpdateRequest = {
  path: string
  range: string | null
  allowed: boolean
}

export type PackageUpdateGateway = {
  url: string
  caPath: string
  certificatePin: string
  version: string
  platform: PackageUpdatePlatform
  requests: PackageUpdateRequest[]
  allowDownloads(): void
  close(): Promise<void>
}

export type PackageUpdatePlatform = 'mac' | 'win'

export type PackageUpdateGatewayOptions = {
  version?: string
  platform?: PackageUpdatePlatform
  allowSignalFile?: string
}

function sha512(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.once('error', rejectHash)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', () => resolveHash(hash.digest('base64')))
  })
}

function parseRange(value: string | undefined, size: number): { start: number, end: number } | null {
  const match = value?.match(/^bytes=(\d+)-(\d*)$/)
  if (!match) return null
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size) return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
  })
}

export async function startPackageUpdateGateway(
  artifactPath: string,
  options: PackageUpdateGatewayOptions = {},
): Promise<PackageUpdateGateway> {
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const caPath = join(fixtureDir, 'package-acceptance-cert.pem.fixture')
  const certificate = new X509Certificate(readFileSync(caPath))
  const certificatePin = createHash('sha256').update(certificate.publicKey.export({
    type: 'spki',
    format: 'der',
  })).digest('base64')
  const size = statSync(artifactPath).size
  if (size <= 0) throw new Error('更新验收产物为空')
  const digest = await sha512(artifactPath)
  const version = options.version ?? '0.5.1'
  const platform = options.platform ?? 'mac'
  const artifactName = platform === 'mac'
    ? `BilliardBuddy-${version}-mac-arm64.zip`
    : `BilliardBuddy-${version}-win-x64.exe`
  const metadataName = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml'
  const metadata = [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${digest}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${digest}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
  const requests: PackageUpdateRequest[] = []
  const sockets = new Set<Socket>()
  let downloadsAllowed = false

  const server = createServer({
    key: readFileSync(join(fixtureDir, 'package-acceptance-key.pem.fixture')),
    cert: readFileSync(caPath),
  }, (request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://127.0.0.1').pathname
    const allowedMethod = request.method === 'GET' || request.method === 'HEAD'
    if (!allowedMethod) {
      response.writeHead(405).end()
      return
    }
    if (pathname === `/desktop/${metadataName}`) {
      response.writeHead(200, {
        'content-type': 'text/yaml; charset=utf-8',
        'content-length': Buffer.byteLength(metadata),
        'cache-control': 'no-store',
      })
      if (request.method === 'HEAD') response.end()
      else response.end(metadata)
      return
    }
    if (pathname !== `/desktop/${artifactName}`) {
      response.writeHead(404).end()
      return
    }

    const allowed = downloadsAllowed || Boolean(options.allowSignalFile && existsSync(options.allowSignalFile))
    requests.push({
      path: pathname,
      range: request.headers.range ?? null,
      allowed,
    })
    const range = parseRange(request.headers.range, size)
    const start = range?.start ?? 0
    const end = range?.end ?? size - 1
    const headers: Record<string, string | number> = {
      'content-type': platform === 'mac' ? 'application/zip' : 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'cache-control': 'no-store',
    }
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
    response.writeHead(range ? 206 : 200, headers)
    if (request.method === 'HEAD') {
      response.end()
      return
    }

    if (!allowed) {
      const failedEnd = Math.min(end, start + 64 * 1024 - 1)
      const stream = createReadStream(artifactPath, { start, end: failedEnd })
      stream.on('data', chunk => response.write(chunk))
      stream.once('error', () => response.socket?.destroy())
      stream.once('end', () => response.socket?.destroy())
      return
    }
    const stream = createReadStream(artifactPath, { start, end })
    stream.once('error', () => response.destroy())
    stream.pipe(response)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server, sockets)
    throw new Error('本地更新验收服务没有获得监听端口')
  }
  return {
    url: `https://127.0.0.1:${address.port}/desktop`,
    caPath,
    certificatePin,
    version,
    platform,
    requests,
    allowDownloads() {
      downloadsAllowed = true
    },
    close: () => closeServer(server, sockets),
  }
}

function parseCli(argv: string[]): {
  artifactPath: string
  platform: PackageUpdatePlatform
  readyFile: string
  allowSignalFile: string
} {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--artifact', '--platform', '--ready-file', '--allow-signal-file'].includes(name)) {
      throw new Error('用法: bun run package-update-gateway.ts --artifact <path> --platform <mac|win> --ready-file <path> --allow-signal-file <path>')
    }
    values.set(name, value)
  }
  const artifactPath = values.get('--artifact')
  const platform = values.get('--platform')
  const readyFile = values.get('--ready-file')
  const allowSignalFile = values.get('--allow-signal-file')
  if (!artifactPath || (platform !== 'mac' && platform !== 'win') || !readyFile || !allowSignalFile) {
    throw new Error('更新验收服务参数不完整')
  }
  return { artifactPath, platform, readyFile, allowSignalFile }
}

if (import.meta.main) {
  const input = parseCli(process.argv.slice(2))
  const gateway = await startPackageUpdateGateway(input.artifactPath, {
    platform: input.platform,
    allowSignalFile: input.allowSignalFile,
  })
  writeFileSync(input.readyFile, `${JSON.stringify({
    url: gateway.url,
    caPath: gateway.caPath,
    certificatePin: gateway.certificatePin,
    version: gateway.version,
    platform: gateway.platform,
  })}\n`, { mode: 0o600 })
  const close = async () => {
    rmSync(input.readyFile, { force: true })
    await gateway.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void close() })
  process.once('SIGTERM', () => { void close() })
  await new Promise(() => undefined)
}
