import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { DocumentBlock } from '../types/message'
import type { ToolContext } from './Tool'
import { fileReadTool, fileReadManyTool } from './fileReadTool'
import { PDF_MAX_BYTES } from './pdfRead'

let root: string
let ctx: ToolContext
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'frp-')))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** 写一个最小合法 PDF(头 %PDF- + N 个 /Type /Page 标记),用于文档块/页数估算测试。 */
function writePdf(name: string, pages = 1): void {
  const pageMarkers = Array.from({ length: pages }, () => '/Type /Page').join('\n')
  const body = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${pageMarkers}\n%%EOF\n`
  writeFileSync(join(root, name), Buffer.from(body, 'latin1'))
}

test('read_file on a PDF pushes a document block into ctx.documentResultSink (vision channel)', async () => {
  writePdf('contract.pdf', 3)
  const documentResultSink: DocumentBlock[] = []
  const out = await fileReadTool.execute({ path: 'contract.pdf' }, { ...ctx, documentResultSink })
  // 返回值是元信息文本(向后兼容),不是乱码、不是 base64。
  expect(typeof out).toBe('string')
  expect(out).toContain('<file_pdf')
  expect(out).toContain('pages~="3"')
  expect(out).not.toContain('%PDF-') // 不把原始 PDF 字节吐成文本
  // 真文档块走 sink,给 loop 组进尾随 user 消息。
  expect(documentResultSink).toHaveLength(1)
  expect(documentResultSink[0]!.type).toBe('document')
  expect(documentResultSink[0]!.source.type).toBe('base64')
  expect(documentResultSink[0]!.source.media_type).toBe('application/pdf')
  expect(documentResultSink[0]!.source.data.length).toBeGreaterThan(0)
  // base64 能还原出 %PDF- 头(确认送的是真 PDF)。
  expect(Buffer.from(documentResultSink[0]!.source.data, 'base64').toString('latin1')).toContain('%PDF-')
})

test('read_file PDF branch works without a document sink (backward compatible, no throw)', async () => {
  writePdf('nosink.pdf')
  const out = await fileReadTool.execute({ path: 'nosink.pdf' }, ctx)
  expect(out).toContain('<file_pdf')
  expect(out).not.toContain('%PDF-')
})

test('read_file detects a mis-extensioned PDF by magic bytes and routes it to the document channel', async () => {
  // 无 .pdf 扩展名、内容其实是 PDF —— 靠魔数 %PDF- 识别,别当文本读成乱码。
  writePdf('scan_no_ext')
  const documentResultSink: DocumentBlock[] = []
  const out = await fileReadTool.execute({ path: 'scan_no_ext' }, { ...ctx, documentResultSink })
  expect(out).toContain('<file_pdf')
  expect(documentResultSink).toHaveLength(1)
  expect(documentResultSink[0]!.source.media_type).toBe('application/pdf')
})

test('read_file on a binary file (by extension) throws a friendly error instead of mojibake', async () => {
  // ZIP 魔数 PK\x03\x04 + NUL —— 当文本读会乱码。
  writeFileSync(join(root, 'bundle.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x00]))
  const documentResultSink: DocumentBlock[] = []
  await expect(fileReadTool.execute({ path: 'bundle.zip' }, { ...ctx, documentResultSink })).rejects.toThrow(/二进制/)
  expect(documentResultSink).toHaveLength(0)
})

test('read_file on binary content with no extension throws a friendly error (content sniff)', async () => {
  writeFileSync(join(root, 'blob'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x10, 0x00]))
  await expect(fileReadTool.execute({ path: 'blob' }, ctx)).rejects.toThrow(/无法把二进制文件当文本读/)
})

test('read_file on a large PDF returns a too_large notice and does not push a document block', async () => {
  // 构造一个超过 PDF_MAX_BYTES 的"PDF"(头 %PDF- + 填充),验证限流走友好文本、不回灌整份。
  const header = Buffer.from('%PDF-1.4\n', 'latin1')
  const filler = Buffer.alloc(PDF_MAX_BYTES + 1024, 0x20) // 空格填充(非 NUL,避免被当二进制)
  writeFileSync(join(root, 'huge.pdf'), Buffer.concat([header, filler]))
  const documentResultSink: DocumentBlock[] = []
  const out = await fileReadTool.execute({ path: 'huge.pdf' }, { ...ctx, documentResultSink })
  expect(out).toContain('error="too_large"')
  expect(documentResultSink).toHaveLength(0)
})

test('read_file plain text reads are unchanged by the PDF/binary branches', async () => {
  writeFileSync(join(root, 'note.txt'), 'plain text content\nsecond line')
  const documentResultSink: DocumentBlock[] = []
  const out = await fileReadTool.execute({ path: 'note.txt' }, { ...ctx, documentResultSink })
  expect(out).toContain('plain text content')
  expect(out).not.toContain('<file_pdf')
  expect(documentResultSink).toHaveLength(0)
})

test('read_many_files flags PDF and binary files instead of reading them as garbled text', async () => {
  writePdf('doc.pdf')
  writeFileSync(join(root, 'lib.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]))
  writeFileSync(join(root, 'ok.txt'), 'hello world')
  const out = await fileReadManyTool.execute({ paths: ['doc.pdf', 'lib.so', 'ok.txt'] }, ctx)
  expect(out).toContain('error="pdf_use_read_file"')
  expect(out).toContain('error="binary_file"')
  expect(out).toContain('hello world')
  expect(out).not.toContain('%PDF-')
})
