import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import type { MediaAsset } from '../../../shared/contracts/media.js'
import { lock } from '../../utils/lockfile.js'
import { syncParentDirectory } from '../../utils/durableFile.js'

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

export type VerifiedImageBytes = {
  bytes: Buffer
  mime_type: SupportedImageMime
  width: number
  height: number
  content_hash: `sha256:${string}`
}

export type ImageAssetStoreHooks = {
  /** Test-only crash boundary: CAS is durable but metadata has not committed. */
  afterCasPublish?: (asset: VerifiedImageBytes) => Promise<void> | void
}

export class ImageAssetStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'IMAGE_ASSET_INVALID' | 'IMAGE_ASSET_NOT_FOUND' | 'IMAGE_ASSET_OUTSIDE_PROJECT' | 'IMAGE_ASSET_CORRUPT' | 'IMAGE_EXPORT_INVALID',
  ) {
    super(message)
    this.name = 'ImageAssetStoreError'
  }
}

function detectedImageMime(bytes: Buffer): SupportedImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function imageDimensions(bytes: Buffer, mimeType: SupportedImageMime): { width: number; height: number } | null {
  if (mimeType === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]!
      if ([0xd8, 0xd9].includes(marker)) { offset += 2; continue }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
      return { width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8), height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10) }
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    }
  }
  return null
}

function extensionForMime(mimeType: SupportedImageMime): 'png' | 'jpg' | 'webp' {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
}

/**
 * Provider input is a disposable derivative, never the original local asset.
 * Strip the metadata containers that can carry EXIF/GPS without re-encoding
 * image pixels or depending on a platform image codec.
 */
function withoutProviderMetadata(verified: VerifiedImageBytes): Buffer {
  if (verified.mime_type === 'image/jpeg') {
    const source = verified.bytes
    const parts: Buffer[] = [source.subarray(0, 2)]
    let offset = 2
    while (offset < source.length) {
      if (source[offset] !== 0xff) return source
      const marker = source[offset + 1]
      if (marker === undefined) return source
      if (marker === 0xda) { // Start of scan: the remainder is compressed image bytes.
        parts.push(source.subarray(offset))
        return Buffer.concat(parts)
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(source.subarray(offset, offset + 2))
        offset += 2
        continue
      }
      if (offset + 4 > source.length) return source
      const length = source.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > source.length) return source
      // APP1 holds EXIF (including GPS) and XMP.  Do not send either upstream.
      if (marker !== 0xe1) parts.push(source.subarray(offset, offset + 2 + length))
      offset += 2 + length
    }
    return Buffer.concat(parts)
  }
  if (verified.mime_type === 'image/png') {
    const source = verified.bytes
    const parts: Buffer[] = [source.subarray(0, 8)]
    let offset = 8
    while (offset + 12 <= source.length) {
      const length = source.readUInt32BE(offset)
      const end = offset + 12 + length
      if (end > source.length) return source
      const type = source.toString('ascii', offset + 4, offset + 8)
      // PNG eXIf is the only standardized EXIF container.
      if (type !== 'eXIf') parts.push(source.subarray(offset, end))
      offset = end
      if (type === 'IEND') return Buffer.concat(parts)
    }
    return source
  }
  if (verified.mime_type === 'image/webp') {
    const source = verified.bytes
    const chunks: Buffer[] = []
    let offset = 12
    while (offset + 8 <= source.length) {
      const size = source.readUInt32LE(offset + 4)
      const paddedSize = size + (size % 2)
      const end = offset + 8 + paddedSize
      if (end > source.length) return source
      if (source.toString('ascii', offset, offset + 4) !== 'EXIF') chunks.push(source.subarray(offset, end))
      offset = end
    }
    if (offset !== source.length) return source
    const body = Buffer.concat(chunks)
    const header = Buffer.from(source.subarray(0, 12))
    header.writeUInt32LE(4 + body.length, 4)
    return Buffer.concat([header, body])
  }
  return verified.bytes
}

function safeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{7,79}$/.test(value)
}

/** File and content-addressed storage owned only by the image workbench. */
export class ImageAssetStore {
  private readonly assetsDir: string
  private readonly casDir: string
  private readonly locksDir: string

  constructor(paths: { assets: string; root: string }, private readonly hooks: ImageAssetStoreHooks = {}) {
    this.assetsDir = paths.assets
    this.casDir = join(paths.root, 'cas', 'sha256')
    this.locksDir = join(paths.root, 'locks')
  }

  async verify(bytes: Buffer): Promise<VerifiedImageBytes> {
    const mimeType = detectedImageMime(bytes)
    const dimensions = mimeType ? imageDimensions(bytes, mimeType) : null
    if (!mimeType || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12_000 || dimensions.height > 12_000) {
      throw new ImageAssetStoreError('图片文件格式或尺寸无效', 400, 'IMAGE_ASSET_INVALID')
    }
    return {
      bytes,
      mime_type: mimeType,
      width: dimensions.width,
      height: dimensions.height,
      content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    }
  }

  async verifyDataUrl(dataUrl: string): Promise<VerifiedImageBytes> {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new ImageAssetStoreError('图片数据格式无效', 400, 'IMAGE_ASSET_INVALID')
    const bytes = Buffer.from(match[2]!, 'base64')
    const verified = await this.verify(bytes)
    if (verified.mime_type !== match[1]) throw new ImageAssetStoreError('图片声明格式与实际内容不一致', 400, 'IMAGE_ASSET_INVALID')
    return verified
  }

  private async writeCas(verified: VerifiedImageBytes): Promise<void> {
    await mkdir(this.casDir, { recursive: true, mode: 0o700 })
    await mkdir(this.locksDir, { recursive: true, mode: 0o700 })
    const guard = join(this.locksDir, 'image-cas.guard')
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try {
      const digest = verified.content_hash.slice('sha256:'.length)
      const target = join(this.casDir, digest)
      const temporary = join(this.casDir, `.tmp-${randomUUID()}`)
      const temporaryHandle = await open(temporary, 'wx', 0o600)
      try {
        await temporaryHandle.writeFile(verified.bytes)
        await temporaryHandle.sync()
      } finally {
        await temporaryHandle.close()
      }
      try {
        await link(temporary, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readFile(target)
        if (`sha256:${createHash('sha256').update(existing).digest('hex')}` !== verified.content_hash) {
          throw new ImageAssetStoreError('图片内容寻址存储损坏', 500, 'IMAGE_ASSET_CORRUPT')
        }
      } finally {
        await rm(temporary, { force: true })
      }
      // fsync the directory after linking (or validating an existing entry)
      // so a power loss cannot expose a committed database row whose CAS name
      // was never made durable.
      await syncParentDirectory(target)
      // A pre-existing object was already validated above; both paths now
      // have a verified content-addressed object before any SQLite write.
      await this.hooks.afterCasPublish?.(verified)
    } finally {
      await release()
    }
  }

  async persist(
    projectId: string,
    assetId: string,
    role: Extract<MediaAsset['role'], 'reference' | 'mask' | 'result' | 'export'>,
    verified: VerifiedImageBytes,
    versionId: string,
    createdAt: string,
  ): Promise<{ asset: MediaAsset; file_name: string }> {
    if (!safeId(projectId) || !safeId(assetId) || !safeId(versionId)) {
      throw new ImageAssetStoreError('图片资产 ID 无效', 400, 'IMAGE_ASSET_INVALID')
    }
    await this.writeCas(verified)
    const extension = extensionForMime(verified.mime_type)
    const section = role === 'reference' ? 'references' : role === 'mask' ? 'masks' : role === 'export' ? 'exports' : 'results'
    const fileName = `${assetId}.${extension}`
    const target = join(this.assetsDir, projectId, section, fileName)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.tmp-${randomUUID()}`
    const temporaryHandle = await open(temporary, 'wx', 0o600)
    try {
      await temporaryHandle.writeFile(verified.bytes)
      await temporaryHandle.sync()
    } finally {
      await temporaryHandle.close()
    }
    await rename(temporary, target)
    await syncParentDirectory(target)
    return {
      file_name: fileName,
      asset: {
        id: assetId,
        role,
        version_id: versionId,
        storage: { kind: 'cas', locator: `sha256/${verified.content_hash.slice('sha256:'.length)}` },
        mime_type: verified.mime_type,
        byte_size: verified.bytes.byteLength,
        content_hash: verified.content_hash,
        created_at: createdAt,
      },
    }
  }

  private async ownedFile(projectId: string, section: 'references' | 'masks' | 'results' | 'exports', fileName: string): Promise<{ path: string; size: number }> {
    if (!safeId(projectId) || !/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) {
      throw new ImageAssetStoreError('图片资产名无效', 400, 'IMAGE_ASSET_INVALID')
    }
    const directory = join(this.assetsDir, projectId, section)
    const requested = join(directory, fileName)
    let canonicalDirectory: string
    let canonicalPath: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      [canonicalDirectory, canonicalPath, info] = await Promise.all([realpath(directory), realpath(requested), stat(requested)])
    } catch {
      throw new ImageAssetStoreError('图片资产不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
    }
    const relation = relative(canonicalDirectory, canonicalPath)
    if (!info.isFile() || relation.startsWith('..') || isAbsolute(relation)) {
      throw new ImageAssetStoreError('图片资产不属于当前项目', 403, 'IMAGE_ASSET_OUTSIDE_PROJECT')
    }
    return { path: canonicalPath, size: info.size }
  }

  async response(projectId: string, section: 'references' | 'masks' | 'results' | 'exports', fileName: string): Promise<Response> {
    const asset = await this.ownedFile(projectId, section, fileName)
    const extension = extname(fileName).toLowerCase()
    const contentType: SupportedImageMime = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/png'
    return new Response(Bun.file(asset.path), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(asset.size),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  }

  async readVerified(asset: MediaAsset): Promise<VerifiedImageBytes> {
    if (asset.storage.kind !== 'cas') throw new ImageAssetStoreError('图片资产不在本地内容存储中', 409, 'IMAGE_ASSET_NOT_FOUND')
    const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.storage.locator)?.[1]
    if (!digest) throw new ImageAssetStoreError('图片资产地址无效', 500, 'IMAGE_ASSET_CORRUPT')
    const bytes = await readFile(join(this.casDir, digest)).catch(() => null)
    if (!bytes) throw new ImageAssetStoreError('图片资产已经丢失', 404, 'IMAGE_ASSET_NOT_FOUND')
    const verified = await this.verify(bytes)
    if (verified.content_hash.slice('sha256:'.length) !== digest || (asset.content_hash && asset.content_hash !== verified.content_hash)) {
      throw new ImageAssetStoreError('图片资产内容已变化', 409, 'IMAGE_ASSET_CORRUPT')
    }
    return verified
  }

  /** A provider upload must not contain the user's original EXIF/GPS metadata. */
  async providerUpload(asset: MediaAsset): Promise<VerifiedImageBytes> {
    const verified = await this.readVerified(asset)
    return await this.verify(withoutProviderMetadata(verified))
  }

  async verifiedExport(source: MediaAsset, outputPath: string): Promise<{ byte_size: number; mime_type: SupportedImageMime; width: number; height: number; content_hash: `sha256:${string}`; verified_at: string }> {
    if (!isAbsolute(outputPath)) throw new ImageAssetStoreError('导出路径必须是绝对路径', 400, 'IMAGE_EXPORT_INVALID')
    const sourceBytes = await this.readVerified(source)
    const expectedExtension = `.${extensionForMime(sourceBytes.mime_type)}`
    const requestedExtension = extname(outputPath).toLowerCase()
    if (requestedExtension !== expectedExtension && !(expectedExtension === '.jpg' && requestedExtension === '.jpeg')) {
      throw new ImageAssetStoreError(`图片结果需要保存为 ${expectedExtension}`, 400, 'IMAGE_EXPORT_INVALID')
    }
    await mkdir(dirname(outputPath), { recursive: true })
    const temporary = `${outputPath}.partial-${randomUUID()}`
    try {
      await copyFile(join(this.casDir, sourceBytes.content_hash.slice('sha256:'.length)), temporary)
      await rename(temporary, outputPath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    const exported = await readFile(outputPath).catch(() => null)
    const verified = exported ? await this.verify(exported).catch(() => null) : null
    if (
      !verified
      || verified.content_hash !== sourceBytes.content_hash
      || verified.mime_type !== sourceBytes.mime_type
      || verified.width !== sourceBytes.width
      || verified.height !== sourceBytes.height
      || verified.bytes.byteLength !== sourceBytes.bytes.byteLength
    ) {
      throw new ImageAssetStoreError('保存后的图片未能通过完整性校验', 500, 'IMAGE_EXPORT_INVALID')
    }
    return {
      byte_size: verified.bytes.byteLength,
      mime_type: verified.mime_type,
      width: verified.width,
      height: verified.height,
      content_hash: verified.content_hash,
      verified_at: new Date().toISOString(),
    }
  }
}
