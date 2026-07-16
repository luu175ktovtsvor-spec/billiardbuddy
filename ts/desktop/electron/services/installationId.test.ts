import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyInstallationIdToEnv, ensureInstallationId } from './installationId'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-install-'))
  dirs.push(d)
  return d
}

describe('ensureInstallationId', () => {
  it('generates a gateway-format id on first launch and persists it without group/world access', () => {
    const dir = tempDir()
    const id = ensureInstallationId(dir, () => '1111-2222-3333-4444')
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,128}$/) // matches the gateway X-QF-Client-ID pattern
    expect(id.startsWith('bb-')).toBe(true)
    const file = path.join(dir, 'installation-id.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).installationId).toBe(id)
    expect(fs.statSync(file).mode & 0o077).toBe(0) // no group/other access
  })

  it('is stable across launches (does not regenerate)', () => {
    const dir = tempDir()
    const a = ensureInstallationId(dir, () => 'aaaa-bbbb-cccc')
    const b = ensureInstallationId(dir, () => 'a-totally-different-seed')
    expect(b).toBe(a)
  })

  it('regenerates when the stored file is corrupt', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'installation-id.json'), '{ not json')
    expect(ensureInstallationId(dir, () => 'ccccdddd')).toBe('bb-ccccdddd')
  })

  it('produces different ids for different installs', () => {
    let n = 0
    const seeds = () => `seed-value-${n++}`
    const a = ensureInstallationId(tempDir(), seeds)
    const b = ensureInstallationId(tempDir(), seeds)
    expect(a).not.toBe(b)
  })
})

describe('applyInstallationIdToEnv', () => {
  it('injects BB_INSTALLATION_ID when absent', () => {
    expect(applyInstallationIdToEnv({ PATH: '/x' }, 'bb-1').BB_INSTALLATION_ID).toBe('bb-1')
  })

  it('never overrides an existing ops/shell value', () => {
    expect(applyInstallationIdToEnv({ BB_INSTALLATION_ID: 'ops' }, 'bb-1').BB_INSTALLATION_ID).toBe('ops')
  })

  it('leaves the env object untouched when the id is empty (adapter path)', () => {
    const base = { PATH: '/x' }
    expect(applyInstallationIdToEnv(base, undefined)).toBe(base)
    expect(applyInstallationIdToEnv(base, '')).toBe(base)
  })
})
