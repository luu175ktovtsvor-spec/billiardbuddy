import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { retireInstallationSessionArtifacts, SecureSessionStore } from '../desktop/electron/services/keychain'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SecureSessionStore', () => {
  test('does not touch the OS vault when no personal credential exists', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-keychain-test-'))
    temporaryDirectories.push(directory)
    let availabilityChecks = 0
    const safeStorage = {
      isEncryptionAvailable: () => { availabilityChecks += 1; return false },
      encryptString: () => { throw new Error('must not encrypt') },
      decryptString: () => { throw new Error('must not decrypt') },
    }
    const store = new SecureSessionStore(path.join(directory, 'provider-credentials'), safeStorage, 'darwin')
    expect(store.load()).toBeNull()
    expect(availabilityChecks).toBe(0)
  })

  test('still requires the OS vault when reading an existing personal credential', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-keychain-test-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'provider-credentials')
    await Bun.write(file, Buffer.from('encrypted').toString('base64'))
    let availabilityChecks = 0
    const safeStorage = {
      isEncryptionAvailable: () => { availabilityChecks += 1; return false },
      encryptString: () => Buffer.from('unused'),
      decryptString: () => 'unused',
    }
    const store = new SecureSessionStore(file, safeStorage, 'darwin')
    expect(() => store.load()).toThrow('Secure credential storage is unavailable')
    expect(availabilityChecks).toBe(1)
  })

  test('retires only automatic installation-session files and preserves personal credential files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-keychain-test-'))
    temporaryDirectories.push(directory)
    await mkdir(path.join(directory, 'local-credentials'), { recursive: true })
    await Promise.all([
      writeFile(path.join(directory, 'installation-session'), 'retired'),
      writeFile(path.join(directory, 'local-credentials', 'installation-session.enc'), 'retired'),
      writeFile(path.join(directory, 'provider-credentials'), 'personal'),
      writeFile(path.join(directory, 'local-credentials', 'master-key'), 'legacy-key'),
    ])

    retireInstallationSessionArtifacts('darwin', directory)

    expect(existsSync(path.join(directory, 'installation-session'))).toBe(false)
    expect(existsSync(path.join(directory, 'local-credentials', 'installation-session.enc'))).toBe(false)
    expect(existsSync(path.join(directory, 'provider-credentials'))).toBe(true)
    expect(existsSync(path.join(directory, 'local-credentials', 'master-key'))).toBe(true)
  })
})
