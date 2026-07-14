// /api/v1/canvas/* 路由:右面板文档/表格的本地读改与成品渲染下载。
// 纯本地实现(txt/md/html/csv 直接处理,docx/pptx/xlsx 走 officeDocuments),
// 只依赖 stateRoot 作为成品库落点。

import { basename, dirname, extname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import {
  OfficeDocumentError,
  editCsvCell,
  editXlsxCell,
  isDocxPath,
  isPptxPath,
  isXlsxPath,
  readOfficeDocumentBlocks,
  readXlsxSheet,
  renderMinimalPptx,
  renderMinimalXlsx,
  saveOfficeDocumentBlocks,
} from '../../utils/officeDocuments'
import { jsonDetailError } from '../middleware/http'
import { isSensitiveFilePath, readTextIfExists } from '../workspaceTree'

export function createCanvasRouteHandler(deps: { stateRoot: string }) {
  return async function handleCanvasRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/canvas/')) return null
    const action = url.pathname.slice('/api/v1/canvas/'.length)
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    if (action === 'edit' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const instruction = typeof body.instruction === 'string' ? body.instruction : ''
      return Response.json({ content: instruction ? `${content}\n\n${instruction}`.trim() : content, mode: 'local_fallback' })
    }
    if (action === 'render' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format.toLowerCase() : 'txt'
      const rendered = renderDeliverableBytes(content, format)
      return Response.json({ base64: Buffer.from(rendered.bytes).toString('base64'), ext: rendered.ext })
    }
    if (action === 'save-to-library' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format : 'txt'
      const rawName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `artifact-${Date.now()}`
      const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '_')
      const rendered = renderDeliverableBytes(content, format)
      const ext = rendered.ext
      const abs = join(deps.stateRoot, 'library', `${safeName}.${ext}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, rendered.bytes)
      return Response.json({ ok: true, path: abs })
    }
    if (action === 'doc' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), render: text.length > 200_000 ? 'toobig' : 'page', html: `<pre>${escapeHtml(text)}</pre>`, truncated: false })
    }
    if (action === 'sheet' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && isXlsxPath(resolve(path))) {
        try {
          return Response.json(await readXlsxSheet(resolve(path), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      const rows = text.split(/\r?\n/).slice(0, 200).map(line => line.split(','))
      return Response.json({ name: basename(path || 'sheet.csv'), sheets: [{ name: 'Sheet1', rows }], truncated: false })
    }
    if (action === 'excel-edit' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      if (path && isTextSheetPath(path)) {
        return Response.json(await editCsvCell(path, String(body.cell ?? ''), String(body.value ?? '')))
      }
      if (path && isXlsxPath(path)) {
        try {
          return Response.json(await editXlsxCell(path, String(body.cell ?? ''), String(body.value ?? ''), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, sheet: 'Sheet1', cell: String(body.cell ?? ''), old: '', new: String(body.value ?? ''), detail: 'TS 本地模式仅支持 csv/xlsx 表格写回' }, { status: 501 })
    }
    if (action === 'doc-blocks' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && (isDocxPath(resolve(path)) || isPptxPath(resolve(path)))) {
        try {
          return Response.json(await readOfficeDocumentBlocks(resolve(path)))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), kind: 'docx', blocks: text.split(/\n{2,}/).slice(0, 200).map((block, i) => ({ id: `b${i}`, kind: 'paragraph', text: block })) })
    }
    if (action === 'doc-save' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      const edits = body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits)
        ? body.edits as Record<string, unknown>
        : {}
      if (path && isTextDocumentPath(path)) {
        return Response.json(await saveTextDocumentBlocks(path, edits))
      }
      if (path && (isDocxPath(path) || isPptxPath(path))) {
        try {
          return Response.json(await saveOfficeDocumentBlocks(path, edits))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, path: String(body.path ?? ''), saved: 0, detail: 'TS 本地模式仅支持 txt/md/html/docx/pptx 文档写回' }, { status: 501 })
    }
    return null
  }
}

function canvasOfficeError(error: unknown): Response {
  if (error instanceof OfficeDocumentError) return jsonDetailError(error.message, error.status)
  return jsonDetailError(error instanceof Error ? error.message : String(error), 500)
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function escapeXml(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function renderDeliverableBytes(content: string, format: string): { bytes: Uint8Array; ext: string } {
  const fmt = format.toLowerCase()
  if (fmt.includes('docx') || fmt.includes('word')) return { bytes: renderMinimalDocx(content), ext: 'docx' }
  if (fmt.includes('pptx') || fmt.includes('powerpoint') || fmt.includes('幻灯片')) return { bytes: renderMinimalPptx(content), ext: 'pptx' }
  if (fmt.includes('xlsx') || fmt.includes('excel') || fmt.includes('表格')) return { bytes: renderMinimalXlsx(content), ext: 'xlsx' }
  if (fmt.includes('html') || fmt.includes('网页')) return { bytes: Buffer.from(renderMarkdownHtml(content), 'utf8'), ext: 'html' }
  if (fmt.includes('md') || fmt.includes('markdown')) return { bytes: Buffer.from(content, 'utf8'), ext: 'md' }
  return { bytes: Buffer.from(stripMarkdown(content), 'utf8'), ext: 'txt' }
}

function stripMarkdown(content: string): string {
  return content
    .split('\n')
    .map(line => line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\s*[-*]\s+/, '- ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1'))
    .join('\n')
}

function renderMarkdownHtml(content: string): string {
  const body: string[] = []
  let inList = false
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (!bullet && inList) {
      body.push('</ul>')
      inList = false
    }
    if (heading) {
      const level = heading[1]!.length
      body.push(`<h${level}>${inlineMarkdownHtml(heading[2]!)}</h${level}>`)
    } else if (bullet) {
      if (!inList) {
        body.push('<ul>')
        inList = true
      }
      body.push(`<li>${inlineMarkdownHtml(bullet[1]!)}</li>`)
    } else if (line.trim()) {
      body.push(`<p>${inlineMarkdownHtml(line)}</p>`)
    }
  }
  if (inList) body.push('</ul>')
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>body{font-family:-apple-system,system-ui,'PingFang SC',sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.75;color:#1d1d1f;}h1{font-size:24px;}h2{font-size:20px;}h3{font-size:17px;}</style>",
    '</head><body>',
    body.join('\n'),
    '</body></html>',
  ].join('')
}

function inlineMarkdownHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
}

function renderMinimalDocx(content: string): Uint8Array {
  const paragraphs = content.split(/\n+/).map(line => line.trim()).filter(Boolean)
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    paragraphs.map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(stripMarkdown(line))}</w:t></w:r></w:p>`).join('') +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ])
}

async function backupLocalFile(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  const bdir = join(dirname(path), '.billiards-backups')
  await mkdir(bdir, { recursive: true })
  const backup = join(bdir, `${basename(path)}.${Date.now()}.bak`)
  await copyFile(path, backup)
  return backup
}

function isTextDocumentPath(path: string): boolean {
  if (isSensitiveFilePath(path)) return false
  return ['.txt', '.md', '.markdown', '.html', '.htm'].includes(extname(path).toLowerCase())
}

function isTextSheetPath(path: string): boolean {
  if (isSensitiveFilePath(path)) return false
  return extname(path).toLowerCase() === '.csv'
}

async function saveTextDocumentBlocks(path: string, edits: Record<string, unknown>) {
  const text = await readTextIfExists(path)
  const blocks = text.split(/\n{2,}/)
  let saved = 0
  for (const [id, value] of Object.entries(edits)) {
    const match = id.match(/^b(\d+)$/)
    if (!match || typeof value !== 'string') continue
    const index = Number(match[1])
    if (!Number.isInteger(index) || index < 0 || index >= blocks.length) continue
    blocks[index] = value
    saved++
  }
  if (saved > 0) {
    await backupLocalFile(path)
    await writeFile(path, blocks.join('\n\n'), 'utf8')
  }
  return { ok: true, path, saved }
}

function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = Buffer.from(file.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
