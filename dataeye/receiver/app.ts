import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { insertBatch, type InsertBatch } from './db'

const MAX_DECOMPRESSED = 256 * 1024 * 1024

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail)
  }
}

export interface ReceiverDeps {
  env?: Record<string, string | undefined>
  insertBatch?: InsertBatch
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init)
}

export function allowedTokens(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.INGEST_TOKENS ?? '').split(',').map(token => token.trim()).filter(Boolean))
}

export async function gunzipBounded(raw: Uint8Array, limit = MAX_DECOMPRESSED): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  let settled = false

  return await new Promise((resolve, reject) => {
    const gunzip = createGunzip()
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      gunzip.destroy()
      reject(err)
    }

    gunzip.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        fail(new HttpError(413, 'decompressed body too large'))
        return
      }
      chunks.push(chunk)
    })
    gunzip.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    gunzip.on('error', fail)
    Readable.from([Buffer.from(raw)]).pipe(gunzip)
  })
}

async function requestBodyBytes(request: Request): Promise<Buffer> {
  const raw = Buffer.from(await request.arrayBuffer())
  const encoding = (request.headers.get('content-encoding') ?? '').toLowerCase()
  if (encoding === 'gzip') return await gunzipBounded(raw)
  return raw
}

export function createReceiverFetch(deps: ReceiverDeps = {}) {
  const env = deps.env ?? process.env
  const writeBatch = deps.insertBatch ?? insertBatch

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ ok: true })
      }

      if (url.pathname === '/ingest' && request.method === 'POST') {
        const auth = request.headers.get('authorization') ?? ''
        const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : ''
        if (!token || !allowedTokens(env).has(token)) {
          throw new HttpError(401, 'invalid token')
        }

        let body: any
        try {
          const raw = await requestBodyBytes(request)
          body = JSON.parse(raw.toString('utf8'))
        } catch (err) {
          if (err instanceof HttpError) throw err
          throw new HttpError(400, 'invalid json body')
        }

        const machineId = body?.machine_id
        const batch = Array.isArray(body?.batch) ? body.batch : []
        const [accepted, duplicated] = await writeBatch(machineId, batch)
        return jsonResponse({ accepted, duplicated })
      }

      return jsonResponse({ detail: 'not found' }, { status: 404 })
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse({ detail: err.detail }, { status: err.status })
      }
      console.error('[dataeye receiver] request failed', err)
      return jsonResponse({ detail: 'internal server error' }, { status: 500 })
    }
  }
}

function parseArgs(argv: string[]) {
  let host = '127.0.0.1'
  let port = 9100
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = argv[++i] ?? host
    else if (argv[i] === '--port') {
      const parsed = Number(argv[++i])
      if (Number.isFinite(parsed) && parsed > 0) port = parsed
    }
  }
  return { host, port }
}

export function startReceiverServer(opts: { host?: string; port?: number } = {}) {
  return Bun.serve({
    hostname: opts.host ?? '127.0.0.1',
    port: opts.port ?? 9100,
    fetch: createReceiverFetch(),
  })
}

if (import.meta.main) {
  const { host, port } = parseArgs(process.argv.slice(2))
  const server = startReceiverServer({ host, port })
  console.log(`[dataeye-receiver] listening on http://${host}:${server.port}`)
}
