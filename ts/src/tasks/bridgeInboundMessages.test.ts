import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  detectImageFormatFromBase64,
  extractInboundAttachments,
  extractInboundMessageFields,
  normalizeImageBlocks,
  prependPathRefs,
  resolveInboundAttachments,
  resolveInboundUserMessage,
  sanitizeFileName,
} from './bridgeInboundMessages'

function pngBase64(): string {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
}

test('extractInboundMessageFields skips non-user and normalizes image block media types', () => {
  expect(extractInboundMessageFields({ type: 'assistant', message: { content: 'no' } })).toBeUndefined()
  expect(extractInboundMessageFields({ type: 'user', message: { content: [] } })).toBeUndefined()

  const fields = extractInboundMessageFields({
    type: 'user',
    uuid: 'uuid_1',
    message: {
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/webp', data: pngBase64() } },
        { type: 'image', source: { type: 'base64', data: pngBase64() } },
      ],
    },
  })
  expect(fields?.uuid).toBe('uuid_1')
  expect(fields?.content).toEqual([
    { type: 'text', text: '看图' },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: pngBase64() } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64() } },
  ])
})

test('normalizeImageBlocks fast-path keeps already valid arrays by reference', () => {
  const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' } }] as any
  expect(normalizeImageBlocks(blocks)).toBe(blocks)
  expect(detectImageFormatFromBase64('/9j/4AAQ')).toBe('image/jpeg')
})

test('extractInboundAttachments validates loose file_attachments shape', () => {
  expect(extractInboundAttachments({})).toEqual([])
  expect(extractInboundAttachments({
    file_attachments: [
      { file_uuid: 'file_1', file_name: '../unsafe name.txt' },
      { file_uuid: 'missing_name' },
      'bad',
    ],
  })).toEqual([{ file_uuid: 'file_1', file_name: '../unsafe name.txt' }])
})

test('resolveInboundAttachments downloads files with OAuth header and writes quoted refs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-inbound-attach-'))
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  try {
    const resolved = await resolveInboundAttachments([
      { file_uuid: 'file-uuid-123456', file_name: '../bad name.txt' },
      { file_uuid: 'file-missing', file_name: 'missing.txt' },
    ], {
      sessionId: 'bridge:session_attach',
      stateRoot: root,
      baseUrl: 'https://remote.example',
      token: 'oauth-token',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
        if (String(input).includes('file-missing')) return new Response('missing', { status: 404 })
        return new Response(Buffer.from('attachment-body'))
      },
    })
    expect(calls[0]).toMatchObject({
      url: 'https://remote.example/api/oauth/files/file-uuid-123456/content',
      headers: { authorization: 'Bearer oauth-token' },
    })
    expect(resolved.paths).toHaveLength(1)
    expect(basename(resolved.paths[0]!)).toBe('file-uui-bad_name.txt')
    expect(readFileSync(resolved.paths[0]!, 'utf8')).toBe('attachment-body')
    expect(resolved.prefix).toBe(`@"${resolved.paths[0]}" `)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prependPathRefs targets string content and the last text block', () => {
  expect(prependPathRefs('hello', '@"/tmp/a" ')).toBe('@"/tmp/a" hello')
  expect(prependPathRefs([
    { type: 'text', text: 'first' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'last' },
  ], '@"/tmp/a" ')).toEqual([
    { type: 'text', text: 'first' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: '@"/tmp/a" last' },
  ])
  expect(prependPathRefs([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ], '@"/tmp/a" ')).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: '@"/tmp/a"' },
  ])
})

test('resolveInboundUserMessage combines extraction, download and bridge queue flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-inbound-resolve-'))
  try {
    const resolved = await resolveInboundUserMessage({
      type: 'user',
      uuid: 'uuid_resolve',
      message: { content: [{ type: 'text', text: '请读附件' }] },
      file_attachments: [{ file_uuid: 'abc12345-file', file_name: 'report.md' }],
    }, {
      sessionId: 'session_resolve',
      stateRoot: root,
      baseUrl: 'http://127.0.0.1:8850',
      token: 'token',
      fetchImpl: async () => new Response('markdown'),
    })
    expect(resolved).toMatchObject({
      uuid: 'uuid_resolve',
      bridgeOrigin: true,
      skipSlashCommands: true,
      attachments: [{ file_uuid: 'abc12345-file', file_name: 'report.md' }],
    })
    expect(Array.isArray(resolved?.content)).toBe(true)
    const content = resolved?.content as any[]
    expect(content.at(-1)).toMatchObject({ type: 'text' })
    expect(content.at(-1).text).toContain('请读附件')
    expect(resolved?.resolvedPaths[0]).toContain(join(root, 'bridge-uploads', 'session_resolve'))
    expect(existsSync(resolved!.resolvedPaths[0]!)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sanitizeFileName mirrors bridge basename and safe-char behavior', () => {
  expect(sanitizeFileName('../../a b/收据?.pdf')).toBe('___.pdf')
  expect(sanitizeFileName('')).toBe('attachment')
})
