import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecureSessionStore, type SafeStorageLike } from './keychain'

const productionMainSource = readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')

describe('Electron production credential storage', () => {
  it('keeps the OS credential store on all production platforms', () => {
    expect(productionMainSource).not.toContain('use-mock-keychain')
    expect(productionMainSource).not.toContain('password-store=basic')
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
      expect(() => new SecureSessionStore(file, available).load()).toThrow('corrupt')
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
})
