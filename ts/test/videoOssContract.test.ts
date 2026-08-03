import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { expect, test } from 'bun:test'
import { OssObjectStore } from '../../video-media-relay/objectStore.ts'

const hash = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const credentials = { endpoint: 'oss-cn-beijing.aliyuncs.com', bucket: 'bb-video-media-contract', accessKeyId: 'LTAIexampleaccesskey', accessKeySecret: 'example-access-key-secret', region: 'cn-beijing' }

test('OSS V4 contract uses official SDK pagination and streams actual object bytes for verification', async () => {
  const calls: Array<Record<string, unknown>> = []
  const bytes = new TextEncoder().encode('actual OSS body')
  const client = {
    async headObject() { return { contentType: 'video/mp4' } },
    async getObject() { return { body: Readable.from([bytes]) } },
    async listParts(request: { filter: Record<string, unknown> }) {
      calls.push(request.filter)
      return request.filter.partNumberMarker ? { listPartsResult: { isTruncated: 'false', part: [{ partNumber: '1001', eTag: 'etag-1001' }] } } : { listPartsResult: { isTruncated: 'true', nextPartNumberMarker: '1000', part: [{ partNumber: '1', eTag: 'etag-1' }] } }
    },
    async listMultipartUploads() { return { listMultipartUploadsResult: { isTruncated: 'false', upload: [] } } },
    async abortMultipartUpload() {}, async completeMultipartUpload() {}, async deleteObject() {}, async initiateMultipartUpload() { return { initiateMultipartUploadResult: { uploadId: 'upload-123' } } }, async putObject() {},
  }
  const store = new OssObjectStore({ ...credentials, client })
  const signed = await store.createMultipartPartPutUrl({ leaseId: 'lease_12345678', uploadId: 'upload-123', partNumber: 2, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const url = new URL(signed.put_url)
  expect(url.searchParams.get('x-oss-signature-version')).toBe('OSS4-HMAC-SHA256')
  expect(url.searchParams.get('x-oss-credential')).toContain('/cn-beijing/oss/aliyun_v4_request')
  expect(url.searchParams.has('OSSAccessKeyId')).toBeFalse()
  expect(url.searchParams.get('partNumber')).toBe('2')
  expect(await store.listMultipartParts({ leaseId: 'lease_12345678', uploadId: 'upload-123' })).toEqual([{ part_number: 1, etag: 'etag-1' }, { part_number: 1001, etag: 'etag-1001' }])
  expect(calls).toEqual([{ uploadId: 'upload-123', maxParts: 1000 }, { uploadId: 'upload-123', maxParts: 1000, partNumberMarker: 1000 }])
  expect(await store.head('lease_12345678')).toEqual({ byte_size: bytes.byteLength, content_hash: hash(bytes), content_type: 'video/mp4' })
})

const live = process.env.VIDEO_MEDIA_OSS_CONTRACT === '1'
const liveTest = live ? test : test.skip
liveTest('OSS live contract creates, pages, completes, streams and removes a V4 multipart object', async () => {
  const endpoint = process.env.VIDEO_MEDIA_OSS_ENDPOINT!; const bucket = process.env.VIDEO_MEDIA_OSS_BUCKET!; const accessKeyId = process.env.VIDEO_MEDIA_OSS_ACCESS_KEY_ID!; const accessKeySecret = process.env.VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET!
  if (![endpoint, bucket, accessKeyId, accessKeySecret].every(Boolean)) throw new Error('live OSS contract requires VIDEO_MEDIA_OSS_ENDPOINT, VIDEO_MEDIA_OSS_BUCKET and dedicated RAM credentials')
  const store = new OssObjectStore({ endpoint, bucket, accessKeyId, accessKeySecret, region: 'cn-beijing' })
  const leaseId = `lease_contract_${crypto.randomUUID().replaceAll('-', '')}`; const body = new Uint8Array(2 * 1024 * 1024); body.fill(7)
  try {
    const upload = await store.createMultipartUpload({ leaseId, hash: hash(body), byteSize: body.byteLength, contentType: 'application/octet-stream' })
    const parts: Array<{ part_number: number; etag: string }> = []
    for (const partNumber of [1, 2]) {
      const signed = await store.createMultipartPartPutUrl({ leaseId, uploadId: upload.uploadId, partNumber, expiresAt: new Date(Date.now() + 60_000).toISOString() })
      const response = await fetch(signed.put_url, { method: 'PUT', headers: signed.required_headers, body: body.subarray((partNumber - 1) * 1024 * 1024, partNumber * 1024 * 1024) })
      if (!response.ok || !response.headers.get('etag')) throw new Error(`live OSS part ${partNumber} failed`)
      parts.push({ part_number: partNumber, etag: response.headers.get('etag')! })
    }
    expect(await store.listMultipartParts({ leaseId, uploadId: upload.uploadId })).toEqual(parts)
    await store.completeMultipartUpload({ leaseId, uploadId: upload.uploadId, parts })
    expect(await store.head(leaseId)).toEqual({ byte_size: body.byteLength, content_hash: hash(body), content_type: 'application/octet-stream' })
  } finally { await store.delete(leaseId) }
})
