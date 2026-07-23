import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export type SafeStorageLike = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

export class SecureSessionStore {
  constructor(private readonly file: string, private readonly safeStorage: SafeStorageLike) {}
  load(): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
    if (!existsSync(this.file)) return null
    try { return this.safeStorage.decryptString(Buffer.from(readFileSync(this.file, 'utf8'), 'base64')) }
    catch { throw new Error('Secure credential storage is corrupt or cannot be decrypted') }
  }
  save(value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
    const dir = dirname(this.file); mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, this.safeStorage.encryptString(value).toString('base64'), { mode: 0o600 })
    renameSync(tmp, this.file)
    try { chmodSync(this.file, 0o600) } catch { /* Windows DPAPI applies user-scoped encryption */ }
  }
  clear(): void { if (existsSync(this.file)) unlinkSync(this.file) }
}
