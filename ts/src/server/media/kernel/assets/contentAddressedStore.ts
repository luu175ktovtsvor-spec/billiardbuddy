import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

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
    const bytes = await readFile(path)
    return { content_hash: this.hash(bytes), byte_size: bytes.byteLength }
  }
}
