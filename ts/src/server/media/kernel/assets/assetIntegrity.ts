import { ContentAddressedStore } from './contentAddressedStore.js'

export class AssetIntegrityError extends Error {
  constructor(readonly code: 'MEDIA_ASSET_MISSING' | 'MEDIA_ASSET_HASH_MISMATCH') {
    super(code)
    this.name = 'AssetIntegrityError'
  }
}

export class AssetIntegrity {
  constructor(private readonly contentAddressedStore = new ContentAddressedStore()) {}

  async assert(path: string, expectedHash: `sha256:${string}`, expectedBytes?: number): Promise<void> {
    const actual = await this.contentAddressedStore.inspect(path)
    if (!actual) throw new AssetIntegrityError('MEDIA_ASSET_MISSING')
    if (actual.content_hash !== expectedHash || (expectedBytes !== undefined && actual.byte_size !== expectedBytes)) {
      throw new AssetIntegrityError('MEDIA_ASSET_HASH_MISMATCH')
    }
  }
}
