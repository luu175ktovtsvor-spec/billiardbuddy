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
import { basename, dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type SafeStorageLike = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }

export type CredentialStore = {
  load(): string | null
  save(value: string): void
  clear(): void
}

type LocalCredentialEnvelope = {
  version: 1
  iv: string
  tag: string
  ciphertext: string
}

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
    try {
      const handle = openSync(tmp, 'wx', 0o600)
      try {
        writeFileSync(handle, this.safeStorage.encryptString(value).toString('base64'))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
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

export class LocalEncryptedSessionStore implements CredentialStore {
  constructor(private readonly file: string, private readonly keyFile: string) {}

  load(): string | null {
    if (!existsSync(this.file)) return null
    try {
      const envelope = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LocalCredentialEnvelope>
      if (envelope.version !== 1 || typeof envelope.iv !== 'string'
        || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
        throw new Error('invalid envelope')
      }
      const decipher = createDecipheriv('aes-256-gcm', this.readKey(false), Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch (error) {
      throw Object.assign(new Error('Local credential storage is corrupt or cannot be decrypted'), {
        code: 'LOCAL_CREDENTIAL_DECRYPT_FAILED',
        cause: error,
      })
    }
  }

  save(value: string): void {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.readKey(true), iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    this.writePrivateFile(this.file, JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    } satisfies LocalCredentialEnvelope))
  }

  clear(): void {
    if (existsSync(this.file)) unlinkSync(this.file)
  }

  private readKey(create: boolean): Buffer {
    if (!existsSync(this.keyFile)) {
      if (!create) throw new Error('local credential key is missing')
      this.writePrivateFile(this.keyFile, randomBytes(32).toString('base64'))
    }
    const key = Buffer.from(readFileSync(this.keyFile, 'utf8'), 'base64')
    if (key.length !== 32) throw new Error('local credential key is invalid')
    return key
  }

  private writePrivateFile(file: string, value: string): void {
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const handle = openSync(tmp, 'wx', 0o600)
      try {
        writeFileSync(handle, value)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(tmp, file)
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp)
    }
    chmodSync(file, 0o600)
    const directory = openSync(dir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

export function createCredentialStore(
  platform: NodeJS.Platform,
  userDataPath: string,
  name: string,
  safeStorage: SafeStorageLike,
): CredentialStore {
  if (platform === 'darwin') {
    const dir = join(userDataPath, 'local-credentials')
    return new LocalEncryptedSessionStore(join(dir, `${name}.enc`), join(dir, 'master-key'))
  }
  return new SecureSessionStore(join(userDataPath, name), safeStorage)
}
