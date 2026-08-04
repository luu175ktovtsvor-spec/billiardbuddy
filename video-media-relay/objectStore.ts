import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
// ali-oss is the official OSS JavaScript SDK. Its CommonJS package currently
// ships no declarations, so this boundary supplies the narrow typed surface.
// @ts-expect-error ali-oss has no bundled declaration file
import OSS from '../ts/node_modules/ali-oss/lib/client.js'

export type ObjectMetadata = { byte_size: number; content_hash: string; content_type: string }
export type RelayObjectStore = {
  createPutUrl(input: { leaseId: string; hash: string; byteSize: number; contentType: string; expiresAt: string }): Promise<{ put_url: string; required_headers?: Record<string, string> }>
  head(leaseId: string): Promise<ObjectMetadata | null>
  delete(leaseId: string): Promise<void>
  createReadUrl(input: { leaseId: string; expiresAt: string }): Promise<string>
  putResult(input: { objectRef: string; body: Uint8Array; contentHash: string; contentType: string }): Promise<void>
  createResultReadUrl(input: { objectRef: string; expiresAt: string }): Promise<string>
  deleteResult(objectRef: string): Promise<void>
  createMultipartUpload?(input: { leaseId: string; hash: string; byteSize: number; contentType: string }): Promise<{ uploadId: string }>
  createMultipartPartPutUrl?(input: { leaseId: string; uploadId: string; partNumber: number; expiresAt: string }): Promise<{ put_url: string; required_headers?: Record<string, string> }>
  listMultipartParts?(input: { leaseId: string; uploadId: string }): Promise<Array<{ part_number: number; etag: string }>>
  findMultipartUploads?(input: { leaseId: string }): Promise<Array<{ uploadId: string; initiatedAt?: string }>>
  completeMultipartUpload?(input: { leaseId: string; uploadId: string; parts: Array<{ part_number: number; etag: string }> }): Promise<void>
  abortMultipartUpload?(input: { leaseId: string; uploadId: string }): Promise<void>
}

type OssSdk = {
  signatureUrlV4(method: string, expires: number, request?: { headers?: Record<string, string>; queries?: Record<string, string | number> }, objectName?: string, additionalHeaders?: string[]): Promise<string>
  head(name: string): Promise<{ res: { headers: Record<string, string | string[] | undefined> } }>
  getStream(name: string): Promise<{ stream: Readable }>
  putStream(name: string, stream: Readable, options?: { mime?: string; meta?: Record<string, string>; contentLength?: number; headers?: Record<string, string> }): Promise<unknown>
  delete(name: string): Promise<unknown>
  initMultipartUpload(name: string, options?: { mime?: string; meta?: Record<string, string>; headers?: Record<string, string> }): Promise<{ uploadId?: string }>
  listParts(name: string, uploadId: string, query?: Record<string, string | number>): Promise<{ parts?: Array<{ PartNumber?: string | number; ETag?: string }>; nextPartNumberMarker?: string | number; isTruncated?: boolean | string }>
  listUploads(query?: Record<string, string | number>): Promise<{ uploads?: Array<{ name?: string; uploadId?: string; initiated?: string }>; nextKeyMarker?: string; nextUploadIdMarker?: string; isTruncated?: boolean | string }>
  completeMultipartUpload(name: string, uploadId: string, parts: Array<{ number: number; etag: string }>, options?: { headers?: Record<string, string> }): Promise<unknown>
  abortMultipartUpload(name: string, uploadId: string): Promise<unknown>
}

const requestTimeout = 60_000

/**
 * All signed URLs and server-to-server OSS calls use ali-oss with
 * authorizationV4 enabled.  The SDK owns canonicalization, including the
 * mandatory /{bucket}/{object} Canonical URI, so no V1 fallback or local
 * signer can be selected accidentally.
 */
export class OssObjectStore implements RelayObjectStore {
  private readonly client: OssSdk
  constructor(private readonly options: { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string; region?: string; client?: OssSdk }) {
    this.client = options.client ?? new OSS({
      endpoint: options.endpoint,
      bucket: options.bucket,
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      region: options.region ?? 'oss-cn-beijing',
      secure: true,
      timeout: requestTimeout,
      authorizationV4: true,
    }) as OssSdk
  }

  async createPutUrl(input: { leaseId: string; hash: string; byteSize: number; contentType: string; expiresAt: string }) {
    // OSS uses its dedicated V4-signable overwrite guard. Replaying a lease
    // URL must never replace the verified source object before consumption.
    const headers = { 'content-type': input.contentType, 'x-oss-forbid-overwrite': 'true', 'x-oss-meta-sha256': input.hash, 'x-oss-meta-size': String(input.byteSize) }
    return { put_url: await this.presignedUrl('PUT', this.inputKey(input.leaseId), input.expiresAt, headers), required_headers: headers }
  }

  /** Reads the actual object stream. Metadata is advisory only; completion
   * always checks the bytes and the standard lower-case HTTP content-type. */
  async head(leaseId: string): Promise<ObjectMetadata | null> {
    const key = this.inputKey(leaseId)
    let contentType: string
    try {
      const response = await this.client.head(key)
      const header = response.res.headers['content-type']
      contentType = typeof header === 'string' ? header.split(';', 1)[0]! : ''
    } catch (error) {
      if (status(error) === 404) return null
      throw new Error('oss_head_failed')
    }
    if (!contentType) throw new Error('oss_head_content_type_missing')
    let stream: Readable
    try { stream = (await this.client.getStream(key)).stream } catch (error) {
      if (status(error) === 404) return null
      throw new Error('oss_get_failed')
    }
    const digest = createHash('sha256'); let byteSize = 0
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteSize += bytes.byteLength
      digest.update(bytes)
    }
    return { byte_size: byteSize, content_hash: `sha256:${digest.digest('hex')}`, content_type: contentType }
  }

  async delete(leaseId: string): Promise<void> { await this.deleteKey(this.inputKey(leaseId)) }
  async createReadUrl(input: { leaseId: string; expiresAt: string }): Promise<string> { return await this.presignedUrl('GET', this.inputKey(input.leaseId), input.expiresAt) }
  async putResult(input: { objectRef: string; body: Uint8Array; contentHash: string; contentType: string }): Promise<void> {
    try {
      // Readable.from(Uint8Array) iterates numbers in Bun's Node compatibility
      // layer. Wrap the immutable bytes as one binary chunk so ali-oss always
      // receives a byte stream rather than a stream of numeric values.
      // Result refs are immutable receipts. OSS rejects a retry or collision
      // rather than replacing bytes that a Sidecar may already acknowledge.
      await this.client.putStream(this.resultKey(input.objectRef), Readable.from([Buffer.from(input.body)]), { contentLength: input.body.byteLength, mime: input.contentType, meta: { sha256: input.contentHash, size: String(input.body.byteLength) }, headers: { 'x-oss-forbid-overwrite': 'true' } })
    } catch { throw new Error('oss_result_put_failed') }
  }
  async createResultReadUrl(input: { objectRef: string; expiresAt: string }): Promise<string> { return await this.presignedUrl('GET', this.resultKey(input.objectRef), input.expiresAt) }
  async deleteResult(objectRef: string): Promise<void> { await this.deleteKey(this.resultKey(objectRef)) }

  async createMultipartUpload(input: { leaseId: string; hash: string; byteSize: number; contentType: string }): Promise<{ uploadId: string }> {
    try {
      const response = await this.client.initMultipartUpload(this.inputKey(input.leaseId), { mime: input.contentType, meta: { sha256: input.hash, size: String(input.byteSize) }, headers: { 'x-oss-forbid-overwrite': 'true' } })
      if (!response.uploadId) throw new Error('missing_upload_id')
      return { uploadId: response.uploadId }
    } catch { throw new Error('oss_multipart_init_failed') }
  }
  async createMultipartPartPutUrl(input: { leaseId: string; uploadId: string; partNumber: number; expiresAt: string }) {
    return { put_url: await this.presignedUrl('PUT', this.inputKey(input.leaseId), input.expiresAt, {}, { partNumber: input.partNumber, uploadId: input.uploadId }), required_headers: {} }
  }
  async listMultipartParts(input: { leaseId: string; uploadId: string }): Promise<Array<{ part_number: number; etag: string }>> {
    const parts: Array<{ part_number: number; etag: string }> = []; let marker: number | undefined
    while (true) {
      let response: Awaited<ReturnType<OssSdk['listParts']>>
      try { response = await this.client.listParts(this.inputKey(input.leaseId), input.uploadId, { 'max-parts': 1000, ...(marker ? { 'part-number-marker': marker } : {}) }) } catch { throw new Error('oss_multipart_list_failed') }
      for (const part of response.parts ?? []) {
        const partNumber = Number(part.PartNumber); const etag = part.ETag
        if (!Number.isSafeInteger(partNumber) || partNumber < 1 || !etag) throw new Error('oss_multipart_list_invalid')
        parts.push({ part_number: partNumber, etag })
      }
      if (!truncated(response.isTruncated)) break
      const next = Number(response.nextPartNumberMarker)
      if (!Number.isSafeInteger(next) || next < 1 || next === marker) throw new Error('oss_multipart_list_pagination_invalid')
      marker = next
    }
    return parts
  }
  async findMultipartUploads(input: { leaseId: string }): Promise<Array<{ uploadId: string; initiatedAt?: string }>> {
    const key = this.inputKey(input.leaseId); const uploads: Array<{ uploadId: string; initiatedAt?: string }> = []
    let keyMarker: string | undefined; let uploadIdMarker: string | undefined
    while (true) {
      let response: Awaited<ReturnType<OssSdk['listUploads']>>
      try { response = await this.client.listUploads({ prefix: key, 'max-uploads': 1000, ...(keyMarker ? { 'key-marker': keyMarker } : {}), ...(uploadIdMarker ? { 'upload-id-marker': uploadIdMarker } : {}) }) } catch { throw new Error('oss_multipart_recovery_list_failed') }
      for (const upload of response.uploads ?? []) if (upload.name === key && upload.uploadId) uploads.push({ uploadId: upload.uploadId, ...(upload.initiated ? { initiatedAt: upload.initiated } : {}) })
      if (!truncated(response.isTruncated)) break
      if (!response.nextKeyMarker || !response.nextUploadIdMarker || (response.nextKeyMarker === keyMarker && response.nextUploadIdMarker === uploadIdMarker)) throw new Error('oss_multipart_recovery_pagination_invalid')
      keyMarker = response.nextKeyMarker; uploadIdMarker = response.nextUploadIdMarker
    }
    return uploads.sort((a, b) => (b.initiatedAt ?? '').localeCompare(a.initiatedAt ?? ''))
  }
  async completeMultipartUpload(input: { leaseId: string; uploadId: string; parts: Array<{ part_number: number; etag: string }> }): Promise<void> {
    try { await this.client.completeMultipartUpload(this.inputKey(input.leaseId), input.uploadId, input.parts.map(part => ({ number: part.part_number, etag: part.etag })), { headers: { 'x-oss-forbid-overwrite': 'true' } }) } catch { throw new Error('oss_multipart_complete_failed') }
  }
  async abortMultipartUpload(input: { leaseId: string; uploadId: string }): Promise<void> {
    try { await this.client.abortMultipartUpload(this.inputKey(input.leaseId), input.uploadId) } catch (error) { if (status(error) !== 404) throw new Error('oss_multipart_abort_failed') }
  }

  private inputKey(leaseId: string): string { return `video-media/input/${leaseId}` }
  private resultKey(objectRef: string): string { return `video-media/result/${objectRef}` }
  private async deleteKey(key: string): Promise<void> { try { await this.client.delete(key) } catch (error) { if (status(error) !== 404) throw new Error('oss_delete_failed') } }
  private async presignedUrl(method: 'GET' | 'PUT', key: string, expiresAt: string, headers: Record<string, string> = {}, queries: Record<string, string | number> = {}): Promise<string> {
    const expires = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)))
    try { return await this.client.signatureUrlV4(method, expires, { headers, queries }, key, Object.keys(headers)) } catch { throw new Error('oss_presign_failed') }
  }
}

function truncated(value: boolean | string | undefined): boolean { return value === true || value === 'true' }
function status(error: unknown): number | undefined { const value = error as { status?: number; statusCode?: number; res?: { status?: number } }; return value.status ?? value.statusCode ?? value.res?.status }
