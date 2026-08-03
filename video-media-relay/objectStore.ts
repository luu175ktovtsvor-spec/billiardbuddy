import { createHmac } from 'node:crypto'

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
  completeMultipartUpload?(input: { leaseId: string; uploadId: string; parts: Array<{ part_number: number; etag: string }> }): Promise<void>
  abortMultipartUpload?(input: { leaseId: string; uploadId: string }): Promise<void>
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Minimal OSS v1 signer.  Keys are Relay-owned and object names are generated
 * here, so neither Sidecar nor Provider ever receives bucket credentials or a
 * caller-selected key.  The stored SHA-256 is an OSS metadata field because an
 * OSS ETag is not a SHA-256 for multipart uploads.
 */
export class OssObjectStore implements RelayObjectStore {
  private readonly endpoint: string
  constructor(private readonly options: { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string; fetchImpl?: FetchLike }) {
    this.endpoint = options.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  }

  async createPutUrl(input: { leaseId: string; hash: string; byteSize: number; contentType: string; expiresAt: string }) {
    const expires = Math.floor(Date.parse(input.expiresAt) / 1000)
    const headers = { 'Content-Type': input.contentType, 'x-oss-meta-sha256': input.hash, 'x-oss-meta-size': String(input.byteSize) }
    return { put_url: this.signedUrl('PUT', this.inputKey(input.leaseId), expires, input.contentType, headers), required_headers: headers }
  }

  async head(leaseId: string): Promise<ObjectMetadata | null> {
    const response = await this.request('HEAD', this.inputKey(leaseId))
    if (response.status === 404) return null
    if (!response.ok) throw new Error('oss_head_failed')
    const byteSize = Number(response.headers.get('content-length'))
    const contentHash = response.headers.get('x-oss-meta-sha256') ?? ''
    const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? ''
    return Number.isSafeInteger(byteSize) && byteSize >= 0 && contentHash && contentType ? { byte_size: byteSize, content_hash: contentHash, content_type: contentType } : null
  }

  async delete(leaseId: string): Promise<void> { await this.deleteKey(this.inputKey(leaseId)) }
  async createReadUrl(input: { leaseId: string; expiresAt: string }): Promise<string> { return this.signedUrl('GET', this.inputKey(input.leaseId), Math.floor(Date.parse(input.expiresAt) / 1000)) }
  async putResult(input: { objectRef: string; body: Uint8Array; contentHash: string; contentType: string }): Promise<void> {
    const key = this.resultKey(input.objectRef)
    const response = await this.request('PUT', key, { body: input.body, headers: { 'Content-Type': input.contentType, 'x-oss-meta-sha256': input.contentHash, 'x-oss-meta-size': String(input.body.byteLength) } })
    if (!response.ok) throw new Error('oss_result_put_failed')
  }
  async createResultReadUrl(input: { objectRef: string; expiresAt: string }): Promise<string> { return this.signedUrl('GET', this.resultKey(input.objectRef), Math.floor(Date.parse(input.expiresAt) / 1000)) }
  async deleteResult(objectRef: string): Promise<void> { await this.deleteKey(this.resultKey(objectRef)) }

  async createMultipartUpload(input: { leaseId: string; hash: string; byteSize: number; contentType: string }): Promise<{ uploadId: string }> {
    const response = await this.request('POST', this.inputKey(input.leaseId), { query: 'uploads', headers: { 'Content-Type': input.contentType, 'x-oss-meta-sha256': input.hash, 'x-oss-meta-size': String(input.byteSize) } })
    if (!response.ok) throw new Error('oss_multipart_init_failed')
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await response.text())?.[1]
    if (!uploadId) throw new Error('oss_multipart_init_invalid')
    return { uploadId }
  }
  async createMultipartPartPutUrl(input: { leaseId: string; uploadId: string; partNumber: number; expiresAt: string }) {
    const expires = Math.floor(Date.parse(input.expiresAt) / 1000)
    const query = `partNumber=${input.partNumber}&uploadId=${encodeURIComponent(input.uploadId)}`
    return { put_url: this.signedUrl('PUT', this.inputKey(input.leaseId), expires, '', {}, query), required_headers: {} }
  }
  async listMultipartParts(input: { leaseId: string; uploadId: string }): Promise<Array<{ part_number: number; etag: string }>> {
    const response = await this.request('GET', this.inputKey(input.leaseId), { query: `uploadId=${encodeURIComponent(input.uploadId)}` })
    if (!response.ok) throw new Error('oss_multipart_list_failed')
    const xml = await response.text()
    return [...xml.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>\s*<\/Part>/g)].map(match => ({ part_number: Number(match[1]), etag: match[2]! }))
  }
  async completeMultipartUpload(input: { leaseId: string; uploadId: string; parts: Array<{ part_number: number; etag: string }> }): Promise<void> {
    const body = `<CompleteMultipartUpload>${input.parts.map(part => `<Part><PartNumber>${part.part_number}</PartNumber><ETag>${xml(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`
    const response = await this.request('POST', this.inputKey(input.leaseId), { query: `uploadId=${encodeURIComponent(input.uploadId)}`, body, headers: { 'Content-Type': 'application/xml' } })
    if (!response.ok) throw new Error('oss_multipart_complete_failed')
  }
  async abortMultipartUpload(input: { leaseId: string; uploadId: string }): Promise<void> {
    const response = await this.request('DELETE', this.inputKey(input.leaseId), { query: `uploadId=${encodeURIComponent(input.uploadId)}` })
    if (!response.ok && response.status !== 404) throw new Error('oss_multipart_abort_failed')
  }

  private inputKey(leaseId: string): string { return `video-media/input/${leaseId}` }
  private resultKey(objectRef: string): string { return `video-media/result/${objectRef}` }
  private resource(key: string, query = ''): string { return `/${this.options.bucket}/${key}${query ? `?${query}` : ''}` }
  private url(key: string, query = ''): string { return `https://${this.options.bucket}.${this.endpoint}/${key.split('/').map(encodeURIComponent).join('/')}${query ? `?${query}` : ''}` }
  private signature(method: string, resource: string, date: string, contentType = '', headers: Record<string, string> = {}): string {
    const canonicalHeaders = Object.entries(headers).filter(([key]) => key.toLowerCase().startsWith('x-oss-')).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key.toLowerCase()}:${value.trim()}\n`).join('')
    return createHmac('sha1', this.options.accessKeySecret).update(`${method}\n\n${contentType}\n${date}\n${canonicalHeaders}${resource}`).digest('base64')
  }
  private signedUrl(method: string, key: string, expires: number, contentType = '', headers: Record<string, string> = {}, query = ''): string {
    const resource = this.resource(key, query)
    const signature = this.signature(method, resource, String(expires), contentType, headers)
    const params = new URLSearchParams({ OSSAccessKeyId: this.options.accessKeyId, Expires: String(expires), Signature: signature })
    return `${this.url(key, query)}${query ? '&' : '?'}${params}`
  }
  private async request(method: string, key: string, init: { body?: BodyInit; headers?: Record<string, string>; query?: string } = {}): Promise<Response> {
    const date = new Date().toUTCString()
    const contentType = init.headers?.['Content-Type'] ?? ''
    const headers = { ...(init.headers ?? {}), Date: date }
    const signature = this.signature(method, this.resource(key, init.query), date, contentType, init.headers ?? {})
    return await (this.options.fetchImpl ?? fetch)(this.url(key, init.query), { method, headers: { ...headers, Authorization: `OSS ${this.options.accessKeyId}:${signature}` }, ...(init.body === undefined ? {} : { body: init.body }) })
  }
  private async deleteKey(key: string): Promise<void> {
    const response = await this.request('DELETE', key)
    if (!response.ok && response.status !== 404) throw new Error('oss_delete_failed')
  }
}

function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }
