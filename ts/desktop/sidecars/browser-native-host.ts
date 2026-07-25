import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN,
  BILLIARDBUDDY_BROWSER_POINTER_FILE,
} from '../../shared/product/browserNativeHost'

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024

type NativeHostDescriptor = {
  version: 1
  endpoint: string
  token: string
}

type BrowserNativeHostDependencies = {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: string
  fetch?: typeof fetch
  stdin?: NodeJS.ReadableStream
  write?: (buffer: Buffer) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function defaultBrowserPointerPath(
  platform: NodeJS.Platform = process.platform,
  homedir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.BB_BROWSER_NATIVE_POINTER) return path.resolve(env.BB_BROWSER_NATIVE_POINTER)
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'BilliardBuddy', BILLIARDBUDDY_BROWSER_POINTER_FILE)
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'BilliardBuddy', BILLIARDBUDDY_BROWSER_POINTER_FILE)
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'BilliardBuddy', BILLIARDBUDDY_BROWSER_POINTER_FILE)
}

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('BROWSER_NATIVE_RESPONSE_TOO_LARGE')
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export function createNativeMessageDecoder(onMessage: (value: unknown) => void): (chunk: Buffer) => void {
  let buffered = Buffer.alloc(0)
  return chunk => {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0)
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('BROWSER_NATIVE_MESSAGE_TOO_LARGE')
      if (buffered.length < length + 4) return
      const body = buffered.subarray(4, length + 4)
      buffered = buffered.subarray(length + 4)
      onMessage(JSON.parse(body.toString('utf8')) as unknown)
    }
  }
}

function nativeOrigin(argv: string[]): string | undefined {
  return argv.find(value => value.startsWith('chrome-extension://'))
}

async function readDescriptor(pointerPath: string): Promise<NativeHostDescriptor> {
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8')) as unknown
  if (!isRecord(pointer) || pointer.version !== 1 || typeof pointer.descriptor_path !== 'string' || !path.isAbsolute(pointer.descriptor_path)) throw new Error('BROWSER_POINTER_INVALID')
  const descriptor = JSON.parse(await fs.readFile(pointer.descriptor_path, 'utf8')) as unknown
  if (!isRecord(descriptor) || descriptor.version !== 1 || typeof descriptor.endpoint !== 'string' || typeof descriptor.token !== 'string' || descriptor.token.length < 32) throw new Error('BROWSER_DESCRIPTOR_INVALID')
  const url = new URL(descriptor.endpoint)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.pathname !== '/api/browser/native/sync') throw new Error('BROWSER_DESCRIPTOR_INVALID')
  return descriptor as NativeHostDescriptor
}

export async function forwardNativeBrowserMessage(value: unknown, dependencies: BrowserNativeHostDependencies = {}): Promise<unknown> {
  const argv = dependencies.argv ?? process.argv.slice(2)
  if (nativeOrigin(argv) !== BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN) throw new Error('BROWSER_EXTENSION_ORIGIN_DENIED')
  const pointerPath = defaultBrowserPointerPath(dependencies.platform, dependencies.homedir, dependencies.env)
  const descriptor = await readDescriptor(pointerPath)
  const response = await (dependencies.fetch ?? fetch)(descriptor.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bb-browser-token': descriptor.token },
    body: JSON.stringify(value),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`BROWSER_BRIDGE_HTTP_${response.status}`)
  return await response.json()
}

export function runBrowserNativeHost(dependencies: BrowserNativeHostDependencies = {}): void {
  const stdin = dependencies.stdin ?? process.stdin
  const write = dependencies.write ?? (buffer => process.stdout.write(buffer))
  let chain = Promise.resolve()
  const decode = createNativeMessageDecoder(value => {
    chain = chain.then(async () => {
      try {
        write(encodeNativeMessage(await forwardNativeBrowserMessage(value, dependencies)))
      } catch (error) {
        write(encodeNativeMessage({ ok: false, error: error instanceof Error ? error.message : 'BROWSER_NATIVE_FAILED' }))
      }
    })
  })
  stdin.on('data', chunk => {
    try {
      decode(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    } catch (error) {
      write(encodeNativeMessage({ ok: false, error: error instanceof Error ? error.message : 'BROWSER_NATIVE_INVALID' }))
    }
  })
}
