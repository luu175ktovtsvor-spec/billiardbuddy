import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureInstallationId } from './installationId'

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
  it('generates an activation id on first launch and persists it without group/world access', () => {
    const dir = tempDir()
    const id = ensureInstallationId(dir, () => '1111-2222-3333-4444')
    expect(id).toMatch(/^[A-Za-z0-9._-]{8,128}$/)
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
