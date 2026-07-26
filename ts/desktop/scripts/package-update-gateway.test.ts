import { request } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startPackageUpdateGateway } from './package-update-gateway'
import { cleanupNewCacheEntries, snapshotCacheEntries } from './accept-macos-update-recovery'
import { verifyPublishedUpdate } from './verify-published-update'

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
  it('accepts a published feed only when metadata and ranged artifact bytes match', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-published-update-'))
    const metadataPath = join(tempDir, 'latest.yml')
    const artifactPath = join(tempDir, 'BilliardBuddy-0.5.0-win-x64.exe')
    const artifact = Buffer.alloc(16 * 1024, 11)
    const metadata = 'version: 0.5.0\nfiles:\n  - url: BilliardBuddy-0.5.0-win-x64.exe\n'
    writeFileSync(metadataPath, metadata)
    writeFileSync(artifactPath, artifact)
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const name = new URL(String(input)).pathname.split('/').at(-1)
      if (name === 'latest.yml') return new Response(metadata)
      if (name !== 'BilliardBuddy-0.5.0-win-x64.exe') return new Response(null, { status: 404 })
      if (init?.method === 'HEAD') {
        return new Response(null, { headers: { 'content-length': String(artifact.length), 'accept-ranges': 'bytes' } })
      }
      const requestHeaders = init?.headers as Record<string, string> | undefined
      const match = requestHeaders?.range?.match(/^bytes=(\d+)-(\d+)$/)
      if (!match) return new Response(null, { status: 416 })
      const start = Number(match[1])
      const end = Number(match[2])
      return new Response(artifact.subarray(start, end + 1), { status: 206 })
    }
    try {
      await expect(verifyPublishedUpdate({
        baseUrl: 'https://updates.example.test/desktop',
        expectedVersion: '0.5.0',
        metadataPath,
        artifactPaths: [artifactPath],
      }, fetchImpl as typeof fetch)).resolves.toEqual({
        version: '0.5.0',
        metadata: 'latest.yml',
        artifacts: [{ name: 'BilliardBuddy-0.5.0-win-x64.exe', size: artifact.length }],
      })
      artifact[artifact.length - 1] = 12
      await expect(verifyPublishedUpdate({
        baseUrl: 'https://updates.example.test/desktop',
        expectedVersion: '0.5.0',
        metadataPath,
        artifactPaths: [artifactPath],
      }, fetchImpl as typeof fetch)).rejects.toThrow('正式发布文件内容不匹配')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

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
