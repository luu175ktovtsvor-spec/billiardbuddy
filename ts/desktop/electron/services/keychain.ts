import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  /** Electron exposes this only as meaningful on Linux. */
  getSelectedStorageBackend?(): string
}

export type CredentialStore = {
  load(): string | null
  save(value: string): void
  clear(): void
}

/**
 * Holds a short-lived product session only for the current Electron process.
 *
 * This must not be used for a user-supplied provider key. Its purpose is to
 * keep automatic installation authentication out of the system credential
 * vault: a fresh installation session is bootstrapped on each app launch.
 */
export class EphemeralCredentialStore implements CredentialStore {
  private value: string | null = null

  load(): string | null { return this.value }
  save(value: string): void { this.value = value }
  clear(): void { this.value = null }
}

/**
 * Remove only the retired automatic installation-session artifacts.
 *
 * This deliberately never constructs a SecureSessionStore or touches
 * Electron safeStorage: ordinary product startup must not ask macOS Keychain
 * or Windows credential services to unlock a non-user-owned session. Do not
 * remove `master-key` here because legacy provider credentials may still use
 * it until their explicit migration completes.
 */
export function retireInstallationSessionArtifacts(
  platform: NodeJS.Platform,
  userDataPath: string,
): void {
  const retired = [join(userDataPath, 'installation-session')]
  if (platform === 'darwin') {
    retired.push(join(userDataPath, 'local-credentials', 'installation-session.enc'))
  }
  for (const file of retired) {
    if (existsSync(file)) unlinkSync(file)
  }
}

function assertSecureStorageAvailable(safeStorage: SafeStorageLike, platform: NodeJS.Platform): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
  // Electron reports basic_text as available on Linux, but it is explicitly not
  // an OS credential vault. Do not downgrade a user-owned provider Key to
  // plaintext merely because the desktop has no secret-service integration.
  if (platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.()
    if (!backend || backend === 'basic_text' || backend === 'unknown') {
      const failure = Object.assign(new Error('Secure credential storage requires a Linux secret-service backend'), {
        code: 'SECURE_CREDENTIAL_STORAGE_UNAVAILABLE',
      })
      throw failure
    }
  }
}

type LocalCredentialEnvelope = {
  version: 1
  iv: string
  tag: string
  ciphertext: string
}

export class SecureSessionStore {
  constructor(
    private readonly file: string,
    private readonly safeStorage: SafeStorageLike,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}
  load(): string | null {
    if (!existsSync(this.file)) return null
    // A normal launch with no saved personal Key must not touch the OS vault.
    // Only an existing encrypted record needs safeStorage availability and
    // decryption, so macOS does not prompt merely to resolve the managed route.
    assertSecureStorageAvailable(this.safeStorage, this.platform)
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
    assertSecureStorageAvailable(this.safeStorage, this.platform)
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
    if (this.platform !== 'win32') {
      const directory = openSync(dir, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  }
  clear(): void { if (existsSync(this.file)) unlinkSync(this.file) }
}

class LocalEncryptedSessionStore implements CredentialStore {
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

/**
 * macOS builds before the credential-vault migration used an AES key beside
 * the encrypted data. Keep that reader only long enough to move existing user
 * data into Electron safeStorage (Keychain on macOS), never as a new-store
 * choice. The old ciphertext is retained until the new value has been written
 * and decrypted successfully.
 */
export class MigratingCredentialStore implements CredentialStore {
  constructor(
    private readonly current: SecureSessionStore,
    private readonly legacy: LocalEncryptedSessionStore,
    private readonly legacyKeyFile: string,
  ) {}

  load(): string | null {
    const currentValue = this.current.load()
    if (currentValue !== null) {
      this.removeLegacyArtifacts()
      return currentValue
    }
    const legacyValue = this.legacy.load()
    if (legacyValue === null) return null
    this.current.save(legacyValue)
    const verified = this.current.load()
    if (verified !== legacyValue) throw new Error('Secure credential migration verification failed')
    this.removeLegacyArtifacts()
    return verified
  }

  save(value: string): void {
    this.current.save(value)
    if (this.current.load() !== value) throw new Error('Secure credential write verification failed')
    this.removeLegacyArtifacts()
  }

  clear(): void {
    let failure: unknown
    try { this.current.clear() } catch (error) { failure = error }
    try { this.removeLegacyArtifacts() } catch (error) { failure ??= error }
    if (failure) throw failure
  }

  private removeLegacyArtifacts(): void {
    this.legacy.clear()
    const legacyDir = dirname(this.legacyKeyFile)
    if (!existsSync(this.legacyKeyFile) || !existsSync(legacyDir)) return
    // installation-session and provider-credentials historically shared one
    // local key. Remove it only after the last legacy ciphertext is gone.
    if (readdirSync(legacyDir).some(name => name.endsWith('.enc'))) return
    unlinkSync(this.legacyKeyFile)
    const directory = openSync(legacyDir, 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

export function createCredentialStore(
  platform: NodeJS.Platform,
  userDataPath: string,
  name: string,
  safeStorage: SafeStorageLike,
): CredentialStore {
  const current = new SecureSessionStore(join(userDataPath, name), safeStorage, platform)
  if (platform === 'darwin') {
    const dir = join(userDataPath, 'local-credentials')
    return new MigratingCredentialStore(
      current,
      new LocalEncryptedSessionStore(join(dir, `${name}.enc`), join(dir, 'master-key')),
      join(dir, 'master-key'),
    )
  }
  return current
}
