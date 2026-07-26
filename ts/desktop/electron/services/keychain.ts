import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export type SafeStorageLike = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

export class SecureSessionStore {
  constructor(private readonly file: string, private readonly safeStorage: SafeStorageLike) {}
  load(): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
    if (!existsSync(this.file)) return null
    try { return this.safeStorage.decryptString(Buffer.from(readFileSync(this.file, 'utf8'), 'base64')) }
    catch (error) {
      const failure = Object.assign(new Error('Secure credential storage is corrupt or cannot be decrypted'), {
        code: 'SECURE_CREDENTIAL_DECRYPT_FAILED',
      })
      Object.defineProperty(failure, 'smokeDiagnostic', {
        configurable: false,
        enumerable: false,
        value: `secure-store=${basename(this.file)}; decrypt-error=${error instanceof Error ? error.message : String(error)}`.slice(0, 2_048),
        writable: false,
      })
      throw failure
    }
  }
  save(value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
    const dir = dirname(this.file); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    const handle = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(handle, this.safeStorage.encryptString(value).toString('base64'))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    try {
      renameSync(tmp, this.file)
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp)
    }
    try { chmodSync(this.file, 0o600) } catch { /* Windows DPAPI applies user-scoped encryption */ }
    if (process.platform !== 'win32') {
      const directory = openSync(dir, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  }
  clear(): void { if (existsSync(this.file)) unlinkSync(this.file) }
}
