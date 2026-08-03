import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

export type ContentAddressedFile = {
  content_hash: `sha256:${string}`
  byte_size: number
}

/**
 * Shared integrity primitive for immutable payloads now and media assets in
 * later gates. A database row references a hash and locator; this is the only
 * place that decides whether the bytes still satisfy that reference.
 */
export class ContentAddressedStore {
  hash(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  }

  async inspect(path: string): Promise<ContentAddressedFile | null> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const digest = createHash('sha256')
    let byteSize = 0
    for await (const chunk of createReadStream(path)) {
      digest.update(chunk)
      byteSize += chunk.byteLength
    }
    // Immutable payloads and media assets must not be accepted when another
    // process changed the file while it was being verified. The second stat is
    // intentionally cheap and avoids treating a partial stream as a valid CAS
    // object.
    const finalInfo = await stat(path).catch(() => null)
    if (!finalInfo?.isFile() || finalInfo.size !== byteSize || finalInfo.mtimeMs !== info.mtimeMs) {
      throw new Error('MEDIA_ASSET_CHANGED_DURING_INSPECTION')
    }
    return { content_hash: `sha256:${digest.digest('hex')}`, byte_size: byteSize }
  }
}
