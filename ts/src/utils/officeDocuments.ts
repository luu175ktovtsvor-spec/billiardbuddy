import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export interface CanvasBlock {
  id: string
  kind: 'paragraph' | 'slide_text'
  text: string
  meta?: Record<string, unknown>
}

interface ZipEntry {
  name: string
  data: Buffer
}

interface ZipReadLimits {
  maxEntries?: number
  maxUncompressedBytes?: number
  include?: (name: string) => boolean
}

export class OfficeDocumentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function isDocxPath(path: string): boolean {
  return extname(path).toLowerCase() === '.docx'
}

export function isPptxPath(path: string): boolean {
  return extname(path).toLowerCase() === '.pptx'
}

export function isXlsxPath(path: string): boolean {
  return extname(path).toLowerCase() === '.xlsx'
}

export async function readOfficeDocumentBlocks(path: string, limits?: ZipReadLimits): Promise<{ name: string; kind: 'docx' | 'pptx'; blocks: CanvasBlock[] }> {
  if (isDocxPath(path)) {
    const zip = readZip(await readFile(path), { ...limits, include: name => name === 'word/document.xml' })
    return { name: basename(path), kind: 'docx', blocks: docxBlocks(entryText(zip, 'word/document.xml')) }
  }
  if (isPptxPath(path)) {
    const zip = readZip(await readFile(path), { ...limits, include: name => /^ppt\/slides\/slide\d+\.xml$/.test(name) })
    return { name: basename(path), kind: 'pptx', blocks: pptxBlocks(zip) }
  }
  throw new OfficeDocumentError('只支持 docx/pptx 文本块读取', 415)
}

export async function saveOfficeDocumentBlocks(path: string, edits: Record<string, unknown>) {
  const zip = readZip(await readFile(path))
  let saved = 0
  if (isDocxPath(path)) {
    const entry = requireEntry(zip, 'word/document.xml')
    const result = saveDocxXml(entry.data.toString('utf8'), edits)
    entry.data = Buffer.from(result.xml, 'utf8')
    saved = result.saved
  } else if (isPptxPath(path)) {
    const result = savePptxXml(zip, edits)
    saved = result.saved
  } else {
    throw new OfficeDocumentError('只支持 docx/pptx 文本块写回', 415)
  }
  if (saved > 0) {
    await backupLocalFile(path)
    await writeFile(path, zipStore(zip))
  }
  return { ok: true, path, saved }
}

export async function readXlsxSheet(path: string, sheetName?: string, limits?: ZipReadLimits) {
  const zip = readZip(await readFile(path), {
    ...limits,
    include: name => name === 'xl/workbook.xml'
      || name === 'xl/_rels/workbook.xml.rels'
      || name === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  })
  const worksheets = listWorksheets(zip)
  const worksheet = (sheetName ? worksheets.find(item => item.name === sheetName) : worksheets[0]) ?? worksheets[0]
  if (!worksheet) throw new OfficeDocumentError('xlsx 缺少 worksheet', 422)
  const allRows = xlsxRows(worksheet.xml, readSharedStrings(zip))
  const truncated = allRows.length > 200 || allRows.some(row => row.length > 200)
  const rows = allRows.slice(0, 200).map(row => row.slice(0, 200))
  return { name: basename(path), sheet_names: worksheets.map(item => item.name), sheets: [{ name: worksheet.name, rows }], truncated }
}

export async function readCsvSheet(path: string) {
  const allRows = parseCsvRecords((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  const truncated = allRows.length > 200 || allRows.some(row => row.length > 200)
  const rows = allRows.slice(0, 200).map(row => row.slice(0, 200))
  return { name: basename(path), sheet_names: ['Sheet1'], sheets: [{ name: 'Sheet1', rows }], truncated }
}

export async function editXlsxCell(path: string, cell: string, value: string, sheetName?: string) {
  const pos = parseA1Cell(cell)
  if (!pos) return { ok: false, sheet: sheetName || 'Sheet1', cell, old: '', new: value, detail: `坐标无效:${cell}` }
  const zip = readZip(await readFile(path))
  const worksheet = findWorksheet(zip, sheetName)
  const shared = readSharedStrings(zip)
  const old = readXlsxCellValue(worksheet.xml, cell, shared)
  worksheet.entry.data = Buffer.from(upsertXlsxCell(worksheet.xml, cell.toUpperCase(), value), 'utf8')
  await backupLocalFile(path)
  await writeFile(path, zipStore(zip))
  return { ok: true, sheet: worksheet.name, cell: cell.toUpperCase(), old, new: value }
}

export async function editCsvCell(path: string, cell: string, value: string) {
  const pos = parseA1Cell(cell)
  if (!pos) return { ok: false, sheet: 'Sheet1', cell, old: '', new: value, detail: `坐标无效:${cell}` }
  const rows = (await readTextIfExists(path)).split(/\r?\n/).map(parseCsvLine)
  while (rows.length <= pos.row) rows.push([])
  while (rows[pos.row]!.length <= pos.col) rows[pos.row]!.push('')
  const old = rows[pos.row]![pos.col] ?? ''
  rows[pos.row]![pos.col] = value
  await backupLocalFile(path)
  await writeFile(path, rows.map(formatCsvLine).join('\n'), 'utf8')
  return { ok: true, sheet: 'Sheet1', cell: cell.toUpperCase(), old, new: value }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

export function renderMinimalXlsx(content: string): Uint8Array {
  const rows = content.split(/\r?\n/).filter(line => line.trim().length > 0)
  const rowXml = (rows.length ? rows : ['']).map((line, rowIndex) => {
    const cells = line.includes('\t') ? line.split('\t') : line.includes(',') ? line.split(',') : [line]
    const cellXml = cells.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value.trim())}</t></is></c>`
    }).join('')
    return `<row r="${rowIndex + 1}">${cellXml}</row>`
  }).join('')
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>', 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ])
}

export function renderMinimalPptx(content: string): Uint8Array {
  const lines = content.split(/\r?\n/).map(line => line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '')).filter(line => line.trim())
  const title = lines[0] || '台球房运营方案'
  const bullets = lines.slice(1, 8)
  const paragraphXml = [
    `<a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t>${escapeXml(title)}</a:t></a:r></a:p>`,
    ...bullets.map(line => `<a:p><a:pPr marL="342900" indent="-171450"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`),
  ].join('')
  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="内容"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="685800"/><a:ext cx="7772400" cy="5486400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphXml}</p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>', 'utf8') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>', 'utf8') },
    { name: 'ppt/presentation.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>', 'utf8') },
    { name: 'ppt/_rels/presentation.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>', 'utf8') },
    { name: 'ppt/slides/slide1.xml', data: Buffer.from(slideXml, 'utf8') },
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

function requireEntry(zip: ZipEntry[], name: string): ZipEntry {
  const entry = zip.find(item => item.name === name)
  if (!entry) throw new OfficeDocumentError(`Office 文档缺少 ${name}`, 422)
  return entry
}

function entryText(zip: ZipEntry[], name: string): string {
  return requireEntry(zip, name).data.toString('utf8')
}

function docxBlocks(xml: string): CanvasBlock[] {
  const out: CanvasBlock[] = []
  let visible = 0
  for (const [sourceIndex, para] of allMatches(xml, /<w:p\b[\s\S]*?<\/w:p>/g).entries()) {
    const text = extractXmlText(para, 'w:t')
    if (!text.trim()) continue
    out.push({ id: `b${visible++}`, kind: 'paragraph', text, meta: { sourceIndex } })
  }
  return out
}

function saveDocxXml(xml: string, edits: Record<string, unknown>): { xml: string; saved: number } {
  let visible = 0
  let saved = 0
  const out = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, para => {
    const text = extractXmlText(para, 'w:t')
    if (!text.trim()) return para
    const edit = edits[`b${visible++}`]
    if (typeof edit !== 'string') return para
    saved++
    return replaceTextRuns(para, 'w:t', edit)
  })
  return { xml: out, saved }
}

function pptxBlocks(zip: ZipEntry[]): CanvasBlock[] {
  const out: CanvasBlock[] = []
  let global = 0
  for (const slide of slideEntries(zip)) {
    let local = 0
    for (const text of allMatches(slide.data.toString('utf8'), /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g).map(match => decodeXml(String(match.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/)?.[1] ?? '')))) {
      if (!text.trim()) {
        local++
        continue
      }
      out.push({ id: `b${global++}`, kind: 'slide_text', text, meta: { slide: slide.name, index: local++ } })
    }
  }
  return out
}

function savePptxXml(zip: ZipEntry[], edits: Record<string, unknown>): { saved: number } {
  let global = 0
  let saved = 0
  for (const slide of slideEntries(zip)) {
    slide.data = Buffer.from(slide.data.toString('utf8').replace(/<a:t\b[^>]*>[\s\S]*?<\/a:t>/g, run => {
      const text = decodeXml(String(run.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/)?.[1] ?? ''))
      if (!text.trim()) return run
      const edit = edits[`b${global++}`]
      if (typeof edit !== 'string') return run
      saved++
      return run.replace(/(<a:t\b[^>]*>)[\s\S]*?(<\/a:t>)/, `$1${escapeXml(edit)}$2`)
    }), 'utf8')
  }
  return { saved }
}

function slideEntries(zip: ZipEntry[]): ZipEntry[] {
  return zip
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => Number(a.name.match(/slide(\d+)\.xml/)?.[1] ?? 0) - Number(b.name.match(/slide(\d+)\.xml/)?.[1] ?? 0))
}

function listWorksheets(zip: ZipEntry[]): Array<{ name: string; entry: ZipEntry; xml: string }> {
  const workbook = zip.find(entry => entry.name === 'xl/workbook.xml')?.data.toString('utf8') ?? ''
  const rels = zip.find(entry => entry.name === 'xl/_rels/workbook.xml.rels')?.data.toString('utf8') ?? ''
  const fallback = zip
    .filter(item => /^xl\/worksheets\/sheet\d+\.xml$/.test(item.name))
    .sort((a, b) => Number(a.name.match(/sheet(\d+)\.xml/)?.[1] ?? 0) - Number(b.name.match(/sheet(\d+)\.xml/)?.[1] ?? 0))
    .map((entry, index) => ({ name: `Sheet${index + 1}`, entry, xml: entry.data.toString('utf8') }))
  if (workbook && rels) {
    const sheets = allMatches(workbook, /<sheet\b[^>]*\/?>/g).map(tag => parseAttrs(tag))
    const relationships = allMatches(rels, /<Relationship\b[^>]*\/?>/g).map(tag => parseAttrs(tag))
    const resolved = sheets.flatMap((sheet, index) => {
      const rel = relationships.find(item => item.Id === sheet['r:id'])
      if (!rel?.Target) return []
      const target = rel.Target.replace(/^\//, '').replace(/^\.\//, '')
      const targetPath = target.startsWith('xl/') ? target : `xl/${target}`
      const entry = zip.find(item => item.name === targetPath)
      return entry ? [{ name: sheet.name || `Sheet${index + 1}`, entry, xml: entry.data.toString('utf8') }] : []
    })
    if (resolved.length > 0) return resolved
  }
  return fallback
}

function findWorksheet(zip: ZipEntry[], sheetName?: string): { name: string; entry: ZipEntry; xml: string } {
  const worksheets = listWorksheets(zip)
  const worksheet = (sheetName ? worksheets.find(item => item.name === sheetName) : worksheets[0]) ?? worksheets[0]
  if (!worksheet) throw new OfficeDocumentError('xlsx 缺少 worksheet', 422)
  return worksheet
}

function readSharedStrings(zip: ZipEntry[]): string[] {
  const entry = zip.find(item => item.name === 'xl/sharedStrings.xml')
  if (!entry) return []
  return allMatches(entry.data.toString('utf8'), /<si\b[\s\S]*?<\/si>/g).map(si => extractXmlText(si, 't'))
}

function xlsxRows(xml: string, shared: string[]): string[][] {
  const out: string[][] = []
  for (const cell of xlsxCells(xml)) {
    const pos = parseA1Cell(cell.ref)
    if (!pos) continue
    while (out.length <= pos.row) out.push([])
    while (out[pos.row]!.length <= pos.col) out[pos.row]!.push('')
    out[pos.row]![pos.col] = decodeCellValue(cell.xml, shared)
  }
  return out
}

function readXlsxCellValue(xml: string, cell: string, shared: string[]): string {
  const target = cell.toUpperCase()
  const found = xlsxCells(xml).find(item => item.ref.toUpperCase() === target)
  return found ? decodeCellValue(found.xml, shared) : ''
}

function xlsxCells(xml: string): Array<{ ref: string; xml: string }> {
  const out: Array<{ ref: string; xml: string }> = []
  for (const match of allMatches(xml, /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const attrs = parseAttrs(match.match(/^<c\b[^>]*/)?.[0] ?? '')
    if (attrs.r) out.push({ ref: attrs.r, xml: match })
  }
  return out
}

function decodeCellValue(cellXml: string, shared: string[]): string {
  const open = cellXml.match(/^<c\b[^>]*/)?.[0] ?? ''
  const type = parseAttrs(open).t
  if (type === 's') {
    const index = Number(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? -1)
    return shared[index] ?? ''
  }
  if (type === 'inlineStr') return extractXmlText(cellXml, 't')
  return decodeXml(String(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? ''))
}

function upsertXlsxCell(xml: string, cell: string, value: string): string {
  const pos = parseA1Cell(cell)
  if (!pos) return xml
  const rowNo = String(pos.row + 1)
  const newCell = `<c r="${cell}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`
  const sheetData = xml.match(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/)
  if (!sheetData || sheetData.index === undefined) {
    return xml.replace(/<\/worksheet>/, `<sheetData><row r="${rowNo}">${newCell}</row></sheetData></worksheet>`)
  }
  const start = sheetData.index
  const before = xml.slice(0, start)
  const block = sheetData[0]
  const after = xml.slice(start + block.length)
  const rowMatch = findRow(block, rowNo)
  if (!rowMatch) {
    const newRow = `<row r="${rowNo}">${newCell}</row>`
    const inserted = insertRow(block, newRow, pos.row + 1)
    return before + inserted + after
  }
  const [rowXml, rowIndex] = rowMatch
  const nextRow = replaceOrInsertCell(rowXml, cell, newCell, pos.col)
  return before + block.slice(0, rowIndex) + nextRow + block.slice(rowIndex + rowXml.length) + after
}

function findRow(sheetDataXml: string, rowNo: string): [string, number] | null {
  const rowRegex = /<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g
  let match: RegExpExecArray | null
  while ((match = rowRegex.exec(sheetDataXml))) {
    if (parseAttrs(match[0].match(/^<row\b[^>]*/)?.[0] ?? '').r === rowNo) return [match[0], match.index]
  }
  return null
}

function insertRow(sheetDataXml: string, rowXml: string, rowNumber: number): string {
  const rowRegex = /<row\b[^>]*(?:\/>|>[\s\S]*?<\/row>)/g
  let match: RegExpExecArray | null
  while ((match = rowRegex.exec(sheetDataXml))) {
    const r = Number(parseAttrs(match[0].match(/^<row\b[^>]*/)?.[0] ?? '').r)
    if (Number.isFinite(r) && r > rowNumber) {
      return sheetDataXml.slice(0, match.index) + rowXml + sheetDataXml.slice(match.index)
    }
  }
  return sheetDataXml.replace(/<\/sheetData>/, `${rowXml}</sheetData>`)
}

function replaceOrInsertCell(rowXml: string, ref: string, cellXml: string, colIndex: number): string {
  const cells = allMatches(rowXml, /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)
  for (const cell of cells) {
    const attrs = parseAttrs(cell.match(/^<c\b[^>]*/)?.[0] ?? '')
    if (attrs.r?.toUpperCase() === ref.toUpperCase()) return rowXml.replace(cell, cellXml)
  }
  for (const cell of cells) {
    const attrs = parseAttrs(cell.match(/^<c\b[^>]*/)?.[0] ?? '')
    const pos = attrs.r ? parseA1Cell(attrs.r) : null
    if (pos && pos.col > colIndex) return rowXml.replace(cell, `${cellXml}${cell}`)
  }
  if (rowXml.endsWith('/>')) return rowXml.replace(/\/>$/, `>${cellXml}</row>`)
  return rowXml.replace(/<\/row>/, `${cellXml}</row>`)
}

function parseA1Cell(cell: string): { row: number; col: number } | null {
  const match = cell.trim().match(/^([A-Za-z]+)([1-9][0-9]*)$/)
  if (!match) return null
  let col = 0
  for (const ch of match[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(match[2]) - 1, col: col - 1 }
}

function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function parseCsvRecords(value: string): string[][] {
  if (!value) return []
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (quoted) {
      if (ch === '"' && value[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && value[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (row.length > 0 || cell.length > 0 || value.endsWith(',')) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function formatCsvLine(row: string[]): string {
  return row.map(value => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')
}

function extractXmlText(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return allMatches(xml, new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'g'))
    .map(run => decodeXml(String(run.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`))?.[1] ?? '')))
    .join('')
}

function replaceTextRuns(xml: string, tag: string, value: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let used = false
  const replaced = xml.replace(new RegExp(`(<${escaped}\\b[^>]*>)[\\s\\S]*?(<\\/${escaped}>)`, 'g'), (_m, open: string, close: string) => {
    if (used) return `${open}${close}`
    used = true
    return `${open}${escapeXml(value)}${close}`
  })
  if (used) return replaced
  return xml.replace(new RegExp(`</${xml.startsWith('<w:p') ? 'w:p' : 'a:p'}>`), `<${tag}>${escapeXml(value)}</${tag}>$&`)
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) attrs[match[1]!] = decodeXml(match[2]!)
  return attrs
}

function allMatches(value: string, regex: RegExp): string[] {
  const out: string[] = []
  let match: RegExpExecArray | null
  regex.lastIndex = 0
  while ((match = regex.exec(value))) out.push(match[0])
  return out
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function readZip(input: Uint8Array, limits: ZipReadLimits = {}): ZipEntry[] {
  const buf = Buffer.from(input)
  const eocd = findEndOfCentralDirectory(buf)
  const total = buf.readUInt16LE(eocd + 10)
  if (limits.maxEntries !== undefined && total > limits.maxEntries) {
    throw new OfficeDocumentError('Office 文档包含过多文件', 413)
  }
  const centralOffset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let expandedBytes = 0
  let pos = centralOffset
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new OfficeDocumentError('ZIP central directory 损坏', 422)
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const uncompressedSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    if (limits.include && !limits.include(name)) {
      pos += 46 + nameLen + extraLen + commentLen
      continue
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)
    const remaining = limits.maxUncompressedBytes === undefined ? undefined : limits.maxUncompressedBytes - expandedBytes
    if (remaining !== undefined && (remaining < 0 || uncompressedSize > remaining)) {
      throw new OfficeDocumentError('Office 文档解压后过大', 413)
    }
    let data: Buffer
    if (method === 0) data = Buffer.from(compressed)
    else if (method === 8) data = inflateRawSync(compressed, remaining === undefined ? undefined : { maxOutputLength: Math.max(1, remaining) })
    else throw new OfficeDocumentError(`ZIP 压缩方式暂不支持:${method}`, 422)
    expandedBytes += data.length
    if (limits.maxUncompressedBytes !== undefined && expandedBytes > limits.maxUncompressedBytes) {
      throw new OfficeDocumentError('Office 文档解压后过大', 413)
    }
    entries.push({ name, data })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new OfficeDocumentError('不是有效的 Office/ZIP 文档', 415)
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
