import { expect, test } from 'bun:test'
import { resolveCredentialKey, type CredentialKeyDeps, type SafeStorageLike } from './credentialKey'

/** In-memory safeStorage 桩:encryptString 以固定前缀包裹(证明"落盘的不是明文 DEK"),decryptString 反解。 */
function mockSafeStorage(opts: { available?: boolean } = {}): SafeStorageLike & { encryptCalls: number; decryptCalls: number } {
  const PREFIX = 'SS::'
  return {
    encryptCalls: 0,
    decryptCalls: 0,
    isEncryptionAvailable() { return opts.available ?? true },
    encryptString(plain: string) { this.encryptCalls++; return Buffer.from(PREFIX + plain, 'utf8') },
    decryptString(buf: Buffer) {
      this.decryptCalls++
      const s = buf.toString('utf8')
      if (!s.startsWith(PREFIX)) throw new Error('mock: not encrypted by this safeStorage')
      return s.slice(PREFIX.length)
    },
  }
}

/** In-memory fs 桩,记录写入内容。 */
function memFs(): { deps: CredentialKeyDeps; files: Map<string, Buffer>; mkdirs: string[] } {
  const files = new Map<string, Buffer>()
  const mkdirs: string[] = []
  return {
    files,
    mkdirs,
    deps: {
      existsSyncFn: p => files.has(p),
      readFileSyncFn: p => {
        const b = files.get(p)
        if (!b) throw new Error(`mem: no such file ${p}`)
        return b
      },
      writeFileSyncFn: (p, data) => { files.set(p, Buffer.from(data)) },
      mkdirSyncFn: p => { mkdirs.push(p) },
    },
  }
}

const KEY_PATH = '/fake/userData/credential-key.enc'

test('first run: generates a 32-byte DEK, encrypts it via safeStorage, and stores ciphertext (never the raw DEK)', () => {
  const ss = mockSafeStorage()
  const { deps, files } = memFs()
  const fixedKey = 'a'.repeat(64)

  const dek = resolveCredentialKey(ss, KEY_PATH, { ...deps, generateKeyHex: () => fixedKey })

  expect(dek).toBe(fixedKey)
  expect(ss.encryptCalls).toBe(1)
  // 落盘的是 safeStorage 密文,不是明文 DEK
  const stored = files.get(KEY_PATH)!
  expect(stored).toBeDefined()
  expect(stored.toString('utf8')).not.toBe(fixedKey)
  expect(stored.toString('utf8').includes(fixedKey)).toBe(true) // mock 桩里 DEK 被前缀包裹(真实 safeStorage 是不可逆密文)
})

test('second run: reads the existing blob and returns the SAME DEK (stable across restarts, no re-encrypt)', () => {
  const ss = mockSafeStorage()
  const { deps } = memFs()
  const fixedKey = 'b'.repeat(64)

  const first = resolveCredentialKey(ss, KEY_PATH, { ...deps, generateKeyHex: () => fixedKey })
  const encryptCallsAfterFirst = ss.encryptCalls
  // 用不同的 generateKeyHex 证明第二次是"复用"而非"重新生成"
  const second = resolveCredentialKey(ss, KEY_PATH, { ...deps, generateKeyHex: () => 'c'.repeat(64) })

  expect(second).toBe(first)
  expect(ss.encryptCalls).toBe(encryptCallsAfterFirst) // 未再加密写盘
  expect(ss.decryptCalls).toBeGreaterThan(0)
})

test('safeStorage unavailable: returns null and writes nothing (sidecar falls back to plaintext, no regression)', () => {
  const ss = mockSafeStorage({ available: false })
  const { deps, files } = memFs()

  const dek = resolveCredentialKey(ss, KEY_PATH, deps)

  expect(dek).toBeNull()
  expect(files.size).toBe(0)
  expect(ss.encryptCalls).toBe(0)
})

test('corrupt/undecryptable blob: regenerates a fresh DEK instead of crashing', () => {
  const ss = mockSafeStorage()
  const { deps, files } = memFs()
  files.set(KEY_PATH, Buffer.from('garbage-not-our-format', 'utf8'))

  const dek = resolveCredentialKey(ss, KEY_PATH, { ...deps, generateKeyHex: () => 'd'.repeat(64) })

  expect(dek).toBe('d'.repeat(64))
  expect(ss.encryptCalls).toBe(1) // 重新生成并写盘
})
