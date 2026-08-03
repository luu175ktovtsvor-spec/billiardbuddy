import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import OssClient, {
  AbortMultipartUploadRequest,
  CompleteMultipartUploadRequest,
  DeleteObjectRequest,
  GetObjectRequest,
  HeadObjectRequest,
  InitiateMultipartUploadRequest,
  ListMultipartUploadsRequest,
  ListPartsRequest,
  PutObjectRequest,
  type Config as OssConfig,
} from '../ts/node_modules/@alicloud/oss-client/dist/client.js'

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

type OssSdk = Pick<OssClient, 'abortMultipartUpload' | 'completeMultipartUpload' | 'deleteObject' | 'getObject' | 'headObject' | 'initiateMultipartUpload' | 'listMultipartUploads' | 'listParts' | 'putObject'>
const runtime = { autoretry: true, maxAttempts: 3, readTimeout: 60_000, connectTimeout: 10_000 }

/**
 * The official Alibaba Cloud SDK signs every Relay-to-OSS request with V4.
 * Presigned URLs are still generated locally because Sidecar and DashScope
 * receive only a temporary object capability, never the RAM credential.
 */
export class OssObjectStore implements RelayObjectStore {
  private readonly endpoint: string
  private readonly client: OssSdk
  constructor(private readonly options: { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string; region?: string; client?: OssSdk }) {
    this.endpoint = options.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    this.client = options.client ?? new OssClient({
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      endpoint: this.endpoint,
      regionId: options.region ?? 'cn-beijing',
      protocol: 'https',
      signatureVersion: 'V4',
      readTimeout: 60_000,
      connectTimeout: 10_000,
    } satisfies OssConfig)
  }

  async createPutUrl(input: { leaseId: string; hash: string; byteSize: number; contentType: string; expiresAt: string }) {
    const headers = { 'content-type': input.contentType, 'x-oss-meta-sha256': input.hash, 'x-oss-meta-size': String(input.byteSize) }
    return { put_url: this.presignedUrl('PUT', this.inputKey(input.leaseId), input.expiresAt, headers), required_headers: headers }
  }

  /** HEAD only checks declared metadata. Complete paths call this streaming
   * inspection which hashes the actual OSS bytes before marking a lease ready. */
  async head(leaseId: string): Promise<ObjectMetadata | null> {
    const key = this.inputKey(leaseId)
    let metadata: Record<string, unknown>
    try { metadata = await this.client.headObject(new HeadObjectRequest({ bucketName: this.options.bucket, objectName: key }), runtime) as unknown as Record<string, unknown> } catch (error) {
      if (status(error) === 404) return null
      throw new Error('oss_head_failed')
    }
    const rawContentType = metadata.contentType ?? metadata['content-type']
    const contentType = typeof rawContentType === 'string' ? rawContentType.split(';', 1)[0]! : ''
    if (!contentType) return null
    let response: { body: Readable }
    try { response = await this.client.getObject(new GetObjectRequest({ bucketName: this.options.bucket, objectName: key }), runtime) as unknown as { body: Readable } } catch (error) {
      if (status(error) === 404) return null
      throw new Error('oss_get_failed')
    }
    const hash = createHash('sha256'); let actualSize = 0
    for await (const chunk of response.body) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); actualSize += bytes.byteLength; hash.update(bytes) }
    return { byte_size: actualSize, content_hash: `sha256:${hash.digest('hex')}`, content_type: contentType }
  }

  async delete(leaseId: string): Promise<void> { await this.deleteKey(this.inputKey(leaseId)) }
  async createReadUrl(input: { leaseId: string; expiresAt: string }): Promise<string> { return this.presignedUrl('GET', this.inputKey(input.leaseId), input.expiresAt) }
  async putResult(input: { objectRef: string; body: Uint8Array; contentHash: string; contentType: string }): Promise<void> {
    try {
      await this.client.putObject(new PutObjectRequest({ bucketName: this.options.bucket, objectName: this.resultKey(input.objectRef), body: Readable.from(input.body), userMeta: { sha256: input.contentHash, size: String(input.body.byteLength) }, header: { contentType: input.contentType } }), runtime)
    } catch { throw new Error('oss_result_put_failed') }
  }
  async createResultReadUrl(input: { objectRef: string; expiresAt: string }): Promise<string> { return this.presignedUrl('GET', this.resultKey(input.objectRef), input.expiresAt) }
  async deleteResult(objectRef: string): Promise<void> { await this.deleteKey(this.resultKey(objectRef)) }

  async createMultipartUpload(input: { leaseId: string; hash: string; byteSize: number; contentType: string }): Promise<{ uploadId: string }> {
    try {
      const response = await this.client.initiateMultipartUpload(new InitiateMultipartUploadRequest({ bucketName: this.options.bucket, objectName: this.inputKey(input.leaseId), header: { contentType: input.contentType } }), runtime)
      const uploadId = response.initiateMultipartUploadResult?.uploadId
      if (!uploadId) throw new Error('missing_upload_id')
      return { uploadId }
    } catch { throw new Error('oss_multipart_init_failed') }
  }
  async createMultipartPartPutUrl(input: { leaseId: string; uploadId: string; partNumber: number; expiresAt: string }) {
    return { put_url: this.presignedUrl('PUT', this.inputKey(input.leaseId), input.expiresAt, {}, { partNumber: String(input.partNumber), uploadId: input.uploadId }), required_headers: {} }
  }
  async listMultipartParts(input: { leaseId: string; uploadId: string }): Promise<Array<{ part_number: number; etag: string }>> {
    const parts: Array<{ part_number: number; etag: string }> = []; let marker = 0
    while (true) {
      let response: Awaited<ReturnType<OssSdk['listParts']>>
      try { response = await this.client.listParts(new ListPartsRequest({ bucketName: this.options.bucket, objectName: this.inputKey(input.leaseId), filter: { uploadId: input.uploadId, maxParts: 1000, ...(marker ? { partNumberMarker: marker } : {}) } }), runtime) } catch { throw new Error('oss_multipart_list_failed') }
      const result = response.listPartsResult
      for (const part of result.part ?? []) {
        const partNumber = Number(part.partNumber); const etag = part.eTag
        if (!Number.isSafeInteger(partNumber) || partNumber < 1 || !etag) throw new Error('oss_multipart_list_invalid')
        parts.push({ part_number: partNumber, etag })
      }
      if (result.isTruncated !== 'true') break
      const next = Number(result.nextPartNumberMarker)
      if (!Number.isSafeInteger(next) || next <= marker) throw new Error('oss_multipart_list_pagination_invalid')
      marker = next
    }
    return parts
  }
  async findMultipartUploads(input: { leaseId: string }): Promise<Array<{ uploadId: string; initiatedAt?: string }>> {
    const key = this.inputKey(input.leaseId); const uploads: Array<{ uploadId: string; initiatedAt?: string }> = []
    let keyMarker: string | undefined; let uploadIdMarker: string | undefined
    while (true) {
      let response: Awaited<ReturnType<OssSdk['listMultipartUploads']>>
      try { response = await this.client.listMultipartUploads(new ListMultipartUploadsRequest({ bucketName: this.options.bucket, filter: { prefix: key, maxUploads: '1000', ...(keyMarker ? { keyMarker } : {}), ...(uploadIdMarker ? { uploadIdMarker } : {}) } }), runtime) } catch { throw new Error('oss_multipart_recovery_list_failed') }
      const result = response.listMultipartUploadsResult
      for (const upload of result.upload ?? []) if (upload.key === key && upload.uploadId) uploads.push({ uploadId: upload.uploadId, ...(upload.initiated ? { initiatedAt: upload.initiated } : {}) })
      if (result.isTruncated !== 'true') break
      if (!result.nextKeyMarker || !result.nextUploadIdMarker || (result.nextKeyMarker === keyMarker && result.nextUploadIdMarker === uploadIdMarker)) throw new Error('oss_multipart_recovery_pagination_invalid')
      keyMarker = result.nextKeyMarker; uploadIdMarker = result.nextUploadIdMarker
    }
    return uploads.sort((a, b) => (b.initiatedAt ?? '').localeCompare(a.initiatedAt ?? ''))
  }
  async completeMultipartUpload(input: { leaseId: string; uploadId: string; parts: Array<{ part_number: number; etag: string }> }): Promise<void> {
    try {
      await this.client.completeMultipartUpload(new CompleteMultipartUploadRequest({ bucketName: this.options.bucket, objectName: this.inputKey(input.leaseId), filter: { uploadId: input.uploadId }, body: { completeMultipartUpload: { part: input.parts.map(part => ({ partNumber: String(part.part_number), eTag: part.etag })) } } }), runtime)
    } catch { throw new Error('oss_multipart_complete_failed') }
  }
  async abortMultipartUpload(input: { leaseId: string; uploadId: string }): Promise<void> {
    try { await this.client.abortMultipartUpload(new AbortMultipartUploadRequest({ bucketName: this.options.bucket, objectName: this.inputKey(input.leaseId), filter: { uploadId: input.uploadId } }), runtime) } catch (error) { if (status(error) !== 404) throw new Error('oss_multipart_abort_failed') }
  }

  private inputKey(leaseId: string): string { return `video-media/input/${leaseId}` }
  private resultKey(objectRef: string): string { return `video-media/result/${objectRef}` }
  private async deleteKey(key: string): Promise<void> { try { await this.client.deleteObject(new DeleteObjectRequest({ bucketName: this.options.bucket, objectName: key }), runtime) } catch (error) { if (status(error) !== 404) throw new Error('oss_delete_failed') } }
  private presignedUrl(method: 'GET' | 'PUT', key: string, expiresAt: string, headers: Record<string, string> = {}, query: Record<string, string> = {}): string {
    const now = new Date(); const date = now.toISOString().replace(/[-:]|\.\d{3}/g, ''); const day = date.slice(0, 8)
    const expires = Math.max(1, Math.min(7 * 24 * 60 * 60, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000)))
    const host = `${this.options.bucket}.${this.endpoint}`; const signed = Object.fromEntries(Object.entries({ host, ...headers }).map(([name, value]) => [name.toLowerCase(), value.trim()]))
    const additionalHeaders = Object.keys(signed).sort().join(';')
    const scope = `${day}/${this.options.region ?? 'cn-beijing'}/oss/aliyun_v4_request`
    const parameters = { ...query, 'x-oss-additional-headers': additionalHeaders, 'x-oss-credential': `${this.options.accessKeyId}/${scope}`, 'x-oss-date': date, 'x-oss-expires': String(expires), 'x-oss-signature-version': 'OSS4-HMAC-SHA256' }
    const canonicalQuery = canonicalQueryString(parameters)
    const canonicalHeaders = Object.entries(signed).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}:${value}\n`).join('')
    const canonicalRequest = `${method}\n/${key.split('/').map(rfc3986).join('/')}\n${canonicalQuery}\n${canonicalHeaders}\n${additionalHeaders}\nUNSIGNED-PAYLOAD`
    const stringToSign = `OSS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`
    const dateKey = hmac(`aliyun_v4${this.options.accessKeySecret}`, day); const regionKey = hmac(dateKey, this.options.region ?? 'cn-beijing'); const serviceKey = hmac(regionKey, 'oss'); const signingKey = hmac(serviceKey, 'aliyun_v4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    return `https://${host}/${key.split('/').map(rfc3986).join('/')}?${canonicalQuery}&x-oss-signature=${signature}`
  }
}

function hmac(key: string | Buffer, value: string): Buffer { return createHmac('sha256', key).update(value).digest() }
function rfc3986(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`) }
function canonicalQueryString(query: Record<string, string>): string { return Object.entries(query).map(([key, value]) => [rfc3986(key), rfc3986(value)] as const).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&') }
function status(error: unknown): number | undefined { const value = error as { statusCode?: number; data?: { httpCode?: number } }; return value.statusCode ?? value.data?.httpCode }
