import { request } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startPackageUpdateGateway } from './package-update-gateway'
import { cleanupNewCacheEntries, snapshotCacheEntries } from './accept-macos-update-recovery'

function get(
  url: string,
  caPath: string,
  path: string,
  range?: string,
): Promise<{ status: number, body: Buffer }> {
  return new Promise((resolveResponse, rejectResponse) => {
    const outgoing = request(new URL(path, `${url}/`), {
      ca: readFileSync(caPath),
      headers: range ? { range } : undefined,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('aborted', () => rejectResponse(new Error('response aborted')))
      response.once('end', () => resolveResponse({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }))
    })
    outgoing.once('error', rejectResponse)
    outgoing.end()
  })
}

describe('packaged desktop update gateway', () => {
  it('removes only updater cache entries created by the acceptance run', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-update-cache-'))
    const existing = join(tempDir, 'existing')
    const created = join(tempDir, 'created')
    writeFileSync(existing, 'keep')
    const snapshot = snapshotCacheEntries(tempDir)
    writeFileSync(created, 'remove')
    cleanupNewCacheEntries(tempDir, snapshot)
    expect(readFileSync(existing, 'utf8')).toBe('keep')
    expect(() => readFileSync(created)).toThrow()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('keeps downloads interrupted until recovery is explicitly enabled, then serves byte ranges', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-update-gateway-'))
    const artifactPath = join(tempDir, 'update.zip')
    writeFileSync(artifactPath, Buffer.alloc(256 * 1024, 7))
    const gateway = await startPackageUpdateGateway(artifactPath, { platform: 'mac' })
    try {
      const metadata = await get(gateway.url, gateway.caPath, 'latest-mac.yml')
      expect(metadata.status).toBe(200)
      expect(metadata.body.toString('utf8')).toContain(`version: ${gateway.version}`)

      await expect(get(
        gateway.url,
        gateway.caPath,
        `BilliardBuddy-${gateway.version}-mac-arm64.zip`,
      )).rejects.toThrow()
      expect(gateway.requests).toMatchObject([{ allowed: false, range: null }])

      gateway.allowDownloads()
      const recovered = await get(
        gateway.url,
        gateway.caPath,
        `BilliardBuddy-${gateway.version}-mac-arm64.zip`,
        'bytes=100-199',
      )
      expect(recovered.status).toBe(206)
      expect(recovered.body).toHaveLength(100)
      expect(gateway.requests.at(-1)).toMatchObject({ allowed: true, range: 'bytes=100-199' })
    } finally {
      await gateway.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('serves the Windows channel and installer names expected by electron-updater', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-update-gateway-win-'))
    const artifactPath = join(tempDir, 'update.exe')
    writeFileSync(artifactPath, Buffer.alloc(128 * 1024, 9))
    const gateway = await startPackageUpdateGateway(artifactPath, { platform: 'win' })
    try {
      const metadata = await get(gateway.url, gateway.caPath, 'latest.yml')
      expect(metadata.status).toBe(200)
      expect(metadata.body.toString('utf8')).toContain(`BilliardBuddy-${gateway.version}-win-x64.exe`)
      await expect(get(
        gateway.url,
        gateway.caPath,
        `BilliardBuddy-${gateway.version}-win-x64.exe`,
      )).rejects.toThrow()
      expect(gateway.requests).toMatchObject([{ allowed: false }])
    } finally {
      await gateway.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
