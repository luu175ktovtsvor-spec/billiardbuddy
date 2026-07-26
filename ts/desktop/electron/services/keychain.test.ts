import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCredentialStore, LocalEncryptedSessionStore, SecureSessionStore, type SafeStorageLike } from './keychain'

const productionMainSource = readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')

describe('Electron production credential storage', () => {
  it('does not weaken Chromium credential storage with command-line switches', () => {
    expect(productionMainSource).not.toContain('use-mock-keychain')
    expect(productionMainSource).not.toContain('password-store=basic')
  })

  it('uses local encrypted files on macOS without touching safeStorage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-local-credential-'))
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => { throw new Error('must not call safeStorage') },
      encryptString: () => { throw new Error('must not call safeStorage') },
      decryptString: () => { throw new Error('must not call safeStorage') },
    }
    try {
      const store = createCredentialStore('darwin', dir, 'installation-session', safeStorage)
      store.save('rotated-refresh-proof')

      expect(store.load()).toBe('rotated-refresh-proof')
      const credentialDir = path.join(dir, 'local-credentials')
      expect(readdirSync(credentialDir).sort()).toEqual(['installation-session.enc', 'master-key'])
      expect(readFileSync(path.join(credentialDir, 'installation-session.enc'), 'utf8'))
        .not.toContain('rotated-refresh-proof')
      expect(statSync(path.join(credentialDir, 'installation-session.enc')).mode & 0o777).toBe(0o600)
      expect(statSync(path.join(credentialDir, 'master-key')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('LocalEncryptedSessionStore', () => {
  it('fails closed when encrypted data or its local key is corrupt', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-local-credential-'))
    const file = path.join(dir, 'session.enc')
    const keyFile = path.join(dir, 'master-key')
    try {
      const store = new LocalEncryptedSessionStore(file, keyFile)
      store.save('refresh-proof')
      writeFileSync(file, '{"version":1,"iv":"broken"}')

      expect(() => store.load()).toThrow('Local credential storage is corrupt or cannot be decrypted')
      const secondFile = path.join(dir, 'second.enc')
      const secondStore = new LocalEncryptedSessionStore(secondFile, keyFile)
      secondStore.save('another-refresh-proof')
      unlinkSync(keyFile)
      expect(() => secondStore.load()).toThrow('Local credential storage is corrupt or cannot be decrypted')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('SecureSessionStore', () => {
  it('fails closed when safe storage is unavailable or a persisted session is corrupt after restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-secure-session-'))
    const file = path.join(dir, 'session')
    const unavailable: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    }
    const available: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: () => { throw new Error('cannot decrypt') },
    }
    try {
      expect(() => new SecureSessionStore(file, unavailable).save('refresh')).toThrow('unavailable')
      writeFileSync(file, Buffer.from('garbage').toString('base64'))
      let failure: unknown
      try { new SecureSessionStore(file, available).load() } catch (error) { failure = error }
      expect(failure).toMatchObject({
        message: 'Secure credential storage is corrupt or cannot be decrypted',
        code: 'SECURE_CREDENTIAL_DECRYPT_FAILED',
      })
      expect(Object.keys(failure as object)).not.toContain('smokeDiagnostic')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces encrypted session state without leaving temporary data', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-secure-session-'))
    const file = path.join(dir, 'session')
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(value),
      decryptString: value => value.toString(),
    }
    try {
      const store = new SecureSessionStore(file, safeStorage)
      store.save('first-refresh-proof')
      store.save('rotated-refresh-proof')

      expect(store.load()).toBe('rotated-refresh-proof')
      expect(readdirSync(dir)).toEqual(['session'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('removes the temporary credential file when encryption fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bb-secure-session-'))
    const file = path.join(dir, 'session')
    const safeStorage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('encryption failed') },
      decryptString: value => value.toString(),
    }
    try {
      expect(() => new SecureSessionStore(file, safeStorage).save('refresh')).toThrow('encryption failed')
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
