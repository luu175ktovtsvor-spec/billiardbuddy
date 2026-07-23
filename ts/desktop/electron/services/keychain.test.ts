import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installMacOsChromiumKeychainPromptGuard, SecureSessionStore, type SafeStorageLike } from './keychain'

describe('Electron Chromium keychain guard', () => {
  it('uses Chromium mock keychain on macOS to avoid Safe Storage prompts', () => {
    const appendSwitch = vi.fn()

    const installed = installMacOsChromiumKeychainPromptGuard(
      { commandLine: { appendSwitch } },
      'darwin',
    )

    expect(installed).toBe(true)
    expect(appendSwitch).toHaveBeenCalledWith('use-mock-keychain')
  })

  it('leaves non-macOS platforms on their default credential backend', () => {
    const appendSwitch = vi.fn()

    const installed = installMacOsChromiumKeychainPromptGuard(
      { commandLine: { appendSwitch } },
      'linux',
    )

    expect(installed).toBe(false)
    expect(appendSwitch).not.toHaveBeenCalled()
  })

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
})
