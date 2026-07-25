import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN } from '../../shared/product/browserNativeHost'
import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  forwardNativeBrowserMessage,
} from './browser-native-host'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('browser native host', () => {
  it('decodes fragmented, length-prefixed native messages', () => {
    const values: unknown[] = []
    const decode = createNativeMessageDecoder(value => values.push(value))
    const first = encodeNativeMessage({ type: 'first' })
    const second = encodeNativeMessage({ type: 'second' })
    decode(first.subarray(0, 2))
    decode(Buffer.concat([first.subarray(2), second]))
    expect(values).toEqual([{ type: 'first' }, { type: 'second' }])
  })

  it('accepts only the fixed extension origin and a loopback descriptor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-host-'))
    roots.push(root)
    const descriptorPath = path.join(root, 'descriptor.json')
    const pointerPath = path.join(root, 'pointer.json')
    await fs.writeFile(descriptorPath, JSON.stringify({
      version: 1,
      endpoint: 'http://127.0.0.1:4567/api/browser/native/sync',
      token: 'x'.repeat(32),
    }))
    await fs.writeFile(pointerPath, JSON.stringify({ version: 1, descriptor_path: descriptorPath }))
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:4567/api/browser/native/sync')
      expect(new Headers(init?.headers).get('x-bb-browser-token')).toBe('x'.repeat(32))
      return Response.json({ ok: true })
    }
    const dependencies = {
      argv: [BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN],
      env: { BB_BROWSER_NATIVE_POINTER: pointerPath },
      fetch: fetchMock as typeof fetch,
    }
    await expect(forwardNativeBrowserMessage({ type: 'sync' }, dependencies)).resolves.toEqual({ ok: true })
    await expect(forwardNativeBrowserMessage({ type: 'sync' }, { ...dependencies, argv: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] })).rejects.toThrow('BROWSER_EXTENSION_ORIGIN_DENIED')
  })
})
