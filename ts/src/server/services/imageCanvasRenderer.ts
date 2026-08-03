import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { openSync } from 'fontkit'
import jsQR from 'jsqr'
import QRCode from 'qrcode'
import sharp, { type Blend } from 'sharp'
import type { ImageCanvasDocument, ImageCanvasLayer } from '../../../shared/contracts/imageGeneration.js'
import type { VerifiedImageBytes } from './imageAssetStore.js'

export class ImageCanvasRendererError extends Error {
  constructor(message: string, readonly code: 'CANVAS_ASSET_MISSING' | 'CANVAS_FONT_MISSING' | 'CANVAS_FONT_GLYPH_MISSING' | 'CANVAS_SVG_UNSAFE' | 'CANVAS_QR_INVALID' | 'CANVAS_RENDER_INVALID') {
    super(message)
    this.name = 'ImageCanvasRendererError'
  }
}

export type CanvasRenderInputAsset = { id: string; verified: VerifiedImageBytes }
export type CanvasRenderOutput = {
  bytes: Buffer
  dependency_hashes: `sha256:${string}`[]
  font_hashes: `sha256:${string}`[]
  text_manifest_hash: `sha256:${string}`
  text_layout_manifest: Array<{
    id: string; text_hash: `sha256:${string}`; font_hash: `sha256:${string}`; font_size: number; width: number; height: number; lines: string[]; overflow: 'fit' | 'shrunk' | 'clipped'
    runs: Array<{ line_index: number; text: string; glyphs: Array<{ glyph_id: number; x: number; y: number; advance_x: number; advance_y: number }> }>
    pixel_bounds: { left: number; top: number; width: number; height: number; empty: boolean }
  }>
  qr_manifest: Array<{ id: string; payload: string; x: number; y: number; width: number; height: number; rotation_degrees: number }>
  renderer_version: string
  text_layout_engine_version: string
}

const RENDERER_VERSION = 'billiardbuddy-canvas-renderer-v4'
const TEXT_LAYOUT_ENGINE_VERSION = 'fontkit-cjk-wrap-runs-v2'
const BUILTIN_FONT_ID = 'font_builtin_0001'

function sha(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Reject active/network-capable SVG before it is ever handed to a renderer. */
export function assertSafeSvg(svg: string): void {
  if (svg.length === 0 || svg.length > 2_000_000
    || /<!doctype|<!entity|<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']?\s*(?:https?:|data:|file:|javascript:)/i.test(svg)) {
    throw new ImageCanvasRendererError('SVG 含有不允许的活动内容或外部引用', 'CANVAS_SVG_UNSAFE')
  }
}

function svgBuffer(svg: string, fontPath?: string): Buffer {
  assertSafeSvg(svg)
  return Buffer.from(new Resvg(svg, {
    fitTo: { mode: 'original' },
    ...(fontPath ? { font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: 'BilliardBuddy Builtin CJK' } } : {}),
  }).render().asPng())
}

function bounded(value: number): number { return Math.max(1, Math.min(12_000, Math.round(value))) }

function builtinFontPath(): string {
  // Never fall back to host fonts: the package/runtime contract supplies the
  // same reviewed CJK font on macOS, Windows and Linux. A local override is
  // useful only for a controlled development or test runtime.
  const configured = process.env.BB_IMAGE_FORMAL_FONT_PATH
  const packaged = process.env.BB_IMAGE_RUNTIME_ASSETS_DIR
    ? join(process.env.BB_IMAGE_RUNTIME_ASSETS_DIR, 'fonts', 'BilliardBuddy-NotoSansCJKsc-Regular.woff')
    : undefined
  const path = [configured, packaged].find((candidate): candidate is string => typeof candidate === 'string' && existsSync(candidate))
  if (!path) throw new ImageCanvasRendererError('正式 CJK 字体包不可用', 'CANVAS_FONT_MISSING')
  return path
}

type FormalFontFace = {
  unitsPerEm: number
  hasGlyphForCodePoint?(codePoint: number): boolean
  layout(text: string): { glyphs: Array<{ id: number; path: { toSVG(): string } }>; positions: Array<{ xAdvance: number; yAdvance?: number; xOffset?: number; yOffset?: number }> }
}

type FormalFont = { path: string; hash: `sha256:${string}`; face: FormalFontFace }

const formalFontCache = new Map<string, FormalFont>()

function loadFormalFont(path: string): FormalFont {
  const cached = formalFontCache.get(path)
  if (cached) return cached
  let font: ReturnType<typeof openSync>
  try { font = openSync(path) } catch { throw new ImageCanvasRendererError('正式字体包无法解析', 'CANVAS_FONT_MISSING') }
  const face = ((font.fonts ?? [font]) as unknown as FormalFontFace[])[0]
  if (!face || !Number.isFinite(face.unitsPerEm) || face.unitsPerEm <= 0) {
    throw new ImageCanvasRendererError('正式字体缺少可用排版度量', 'CANVAS_FONT_MISSING')
  }
  const loaded = { path, hash: sha(readFileSync(path)), face }
  formalFontCache.set(path, loaded)
  return loaded
}

function formalFontFor(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): FormalFont {
  if (layer.font_asset_id !== BUILTIN_FONT_ID) {
    throw new ImageCanvasRendererError('未提供可验证的正式字体资产', 'CANVAS_FONT_MISSING')
  }
  const path = builtinFontPath()
  // Parse, rather than trust a file name, so a damaged platform font cannot
  // silently become an untracked renderer dependency. The immutable package
  // bytes are cached only within this process; their hash remains in receipts.
  const loaded = loadFormalFont(path)
  for (const char of layer.text) {
    if (/\s/u.test(char)) continue
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || !loaded.face.hasGlyphForCodePoint?.(codePoint)) {
      throw new ImageCanvasRendererError('正式字体缺少画布文本所需字形', 'CANVAS_FONT_GLYPH_MISSING')
    }
  }
  // The exact parsed bytes, rather than a display name or path, are part of
  // every receipt. A machine with another registered builtin font therefore
  // cannot silently reproduce a historical Version under the same identity.
  return loaded
}

function fontHashFor(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): `sha256:${string}` {
  return formalFontFor(layer).hash
}

/** Preflight calls the same verifier as rendering, so no glyph failure is deferred until export. */
export function assertFormalTextLayer(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): void {
  fontHashFor(layer)
}

/** Preflight and final render share the same font metrics and CJK wrapping. */
export function assertDeterministicTextLayout(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): void {
  layoutText(layer)
}

function resolveColor(value: string, brandColors: Record<string, string>): string {
  if (!value.startsWith('brand.')) return value
  const resolved = brandColors[value.slice('brand.'.length)]
  if (!resolved) throw new ImageCanvasRendererError(`品牌色 Token ${value} 未在锁定 Brand Kit 中定义`, 'CANVAS_RENDER_INVALID')
  return resolved
}

type TextLayout = {
  font: FormalFont
  fontSize: number
  width: number
  height: number
  lines: string[]
  overflow: 'fit' | 'shrunk' | 'clipped'
}

type RenderTransform = { x: number; y: number; width: number; height: number; rotation_degrees: number; scale_x: number; scale_y: number }
type RenderedLayer = { bytes: Buffer; left: number; top: number; width: number; height: number }

function textWidth(face: FormalFontFace, text: string, fontSize: number, letterSpacing: number): number {
  if (!text) return 0
  const advance = face.layout(text).positions.reduce((total, position) => total + position.xAdvance, 0)
  return advance * fontSize / face.unitsPerEm + Math.max(0, Array.from(text).length - 1) * letterSpacing
}

function wrapCjkLine(face: FormalFontFace, source: string, fontSize: number, letterSpacing: number, maxWidth: number): string[] | null {
  if (!Number.isFinite(maxWidth)) return [source]
  const lines: string[] = []
  let line = ''
  for (const character of Array.from(source)) {
    const candidate = line + character
    if (textWidth(face, candidate, fontSize, letterSpacing) <= maxWidth || !line) {
      line = candidate
      if (textWidth(face, line, fontSize, letterSpacing) > maxWidth) return null
      continue
    }
    lines.push(line)
    line = character
    if (textWidth(face, line, fontSize, letterSpacing) > maxWidth) return null
  }
  lines.push(line)
  return lines
}

function layoutText(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): TextLayout {
  const font = formalFontFor(layer)
  const maxWidth = layer.max_width ?? Number.POSITIVE_INFINITY
  const maxHeight = layer.max_height ?? Number.POSITIVE_INFINITY
  const minimum = layer.overflow === 'shrink_to_fit' ? layer.min_font_size! : layer.font_size
  for (let fontSize = layer.font_size; fontSize >= minimum - 0.0001; fontSize = Math.round((fontSize - 0.25) * 100) / 100) {
    const wrapped = layer.text.split('\n').map(source => wrapCjkLine(font.face, source, fontSize, layer.letter_spacing, maxWidth))
    const lines = wrapped.flatMap(value => value ?? [])
    const didOverflowWidth = wrapped.some(value => value === null)
    const height = lines.length * fontSize * layer.line_height
    const width = Math.max(1, ...lines.map(line => textWidth(font.face, line, fontSize, layer.letter_spacing)))
    const fits = !didOverflowWidth && width <= maxWidth + 0.001 && height <= maxHeight + 0.001
    if (fits || layer.overflow === 'clip') {
      return {
        font, fontSize, lines: didOverflowWidth ? layer.text.split('\n') : lines,
        width: bounded(Number.isFinite(maxWidth) ? maxWidth : Math.max(fontSize, width)),
        height: bounded(Number.isFinite(maxHeight) && layer.overflow === 'clip' ? maxHeight : Math.max(fontSize * layer.line_height, height)),
        overflow: layer.overflow === 'clip' ? 'clipped' : fontSize < layer.font_size ? 'shrunk' : 'fit',
      }
    }
    if (layer.overflow !== 'shrink_to_fit') break
  }
  throw new ImageCanvasRendererError('文字无法在锁定画布边界内确定性排版', 'CANVAS_RENDER_INVALID')
}

function textSvg(layer: Extract<ImageCanvasLayer, { kind: 'text' }>, layout: TextLayout, brandColors: Record<string, string>): Buffer {
  const scale = layout.fontSize / layout.font.face.unitsPerEm
  const paths = layout.lines.flatMap((line, lineIndex) => {
    const run = layout.font.face.layout(line)
    const lineWidth = textWidth(layout.font.face, line, layout.fontSize, layer.letter_spacing)
    let cursor = layer.align === 'left' ? 0 : layer.align === 'center' ? (layout.width - lineWidth) / 2 : layout.width - lineWidth
    const baseline = layout.fontSize + lineIndex * layout.fontSize * layer.line_height
    return run.glyphs.map((glyph, index) => {
      const position = run.positions[index] ?? { xAdvance: 0 }
      const x = cursor + (position.xOffset ?? 0) * scale
      const y = baseline + (position.yOffset ?? 0) * scale
      cursor += position.xAdvance * scale + (index < run.glyphs.length - 1 ? layer.letter_spacing : 0)
      return `<path d="${glyph.path.toSVG()}" transform="translate(${x} ${y}) scale(${scale} ${-scale})"/>`
    })
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}"><g fill="${resolveColor(layer.fill, brandColors)}"${layer.stroke ? ` stroke="${resolveColor(layer.stroke, brandColors)}"` : ''}>${paths}</g></svg>`
  return svgBuffer(svg)
}

function transformPoint(x: number, y: number, transform: RenderTransform): { x: number; y: number } {
  const scaleX = transform.scale_x
  const scaleY = transform.scale_y
  const centerX = transform.width * scaleX / 2
  const centerY = transform.height * scaleY / 2
  const localX = x * scaleX - centerX
  const localY = y * scaleY - centerY
  const radians = transform.rotation_degrees * Math.PI / 180
  return {
    x: transform.x + centerX + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: transform.y + centerY + localX * Math.sin(radians) + localY * Math.cos(radians),
  }
}

async function transformRenderedImage(source: Buffer, transform: RenderTransform): Promise<RenderedLayer> {
  const targetWidth = bounded(transform.width * transform.scale_x)
  const targetHeight = bounded(transform.height * transform.scale_y)
  const scaled = await sharp(source).ensureAlpha().resize({ width: targetWidth, height: targetHeight, fit: 'fill' }).png().toBuffer()
  const bytes = Buffer.from(await sharp(scaled).rotate(transform.rotation_degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
  const metadata = await sharp(bytes).metadata()
  if (!metadata.width || !metadata.height) throw new ImageCanvasRendererError('变换后的图层缺少有效尺寸', 'CANVAS_RENDER_INVALID')
  return {
    bytes,
    left: Math.round(transform.x + (targetWidth - metadata.width) / 2),
    top: Math.round(transform.y + (targetHeight - metadata.height) / 2),
    width: metadata.width,
    height: metadata.height,
  }
}

async function opaquePixelBounds(layer: RenderedLayer): Promise<{ left: number; top: number; width: number; height: number; empty: boolean }> {
  const raw = await sharp(layer.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = raw.info.width
  let minY = raw.info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < raw.info.height; y += 1) {
    for (let x = 0; x < raw.info.width; x += 1) {
      if (raw.data[(y * raw.info.width + x) * 4 + 3] === 0) continue
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0 || maxY < 0) return { left: layer.left, top: layer.top, width: 0, height: 0, empty: true }
  return { left: layer.left + minX, top: layer.top + minY, width: maxX - minX + 1, height: maxY - minY + 1, empty: false }
}

function textRuns(layer: Extract<ImageCanvasLayer, { kind: 'text' }>, layout: TextLayout): CanvasRenderOutput['text_layout_manifest'][number]['runs'] {
  const transform: RenderTransform = {
    x: layer.position.x, y: layer.position.y, width: layout.width, height: layout.height,
    rotation_degrees: layer.rotation_degrees, scale_x: layer.scale_x ?? 1, scale_y: layer.scale_y ?? 1,
  }
  return layout.lines.map((line, lineIndex) => {
    const run = layout.font.face.layout(line)
    const lineWidth = textWidth(layout.font.face, line, layout.fontSize, layer.letter_spacing)
    let cursor = layer.align === 'left' ? 0 : layer.align === 'center' ? (layout.width - lineWidth) / 2 : layout.width - lineWidth
    const baseline = layout.fontSize + lineIndex * layout.fontSize * layer.line_height
    return {
      line_index: lineIndex,
      text: line,
      glyphs: run.glyphs.map((glyph, index) => {
        const position = run.positions[index] ?? { xAdvance: 0 }
        const advanceX = position.xAdvance * layout.fontSize / layout.font.face.unitsPerEm + (index < run.glyphs.length - 1 ? layer.letter_spacing : 0)
        const advanceY = (position.yAdvance ?? 0) * layout.fontSize / layout.font.face.unitsPerEm
        const point = transformPoint(
          cursor + (position.xOffset ?? 0) * layout.fontSize / layout.font.face.unitsPerEm,
          baseline + (position.yOffset ?? 0) * layout.fontSize / layout.font.face.unitsPerEm,
          transform,
        )
        cursor += advanceX
        return { glyph_id: glyph.id, x: point.x, y: point.y, advance_x: advanceX, advance_y: advanceY }
      }),
    }
  })
}

export async function verifyRenderedQrManifest(bytes: Buffer, manifest: Array<{ id: string; payload: string; x: number; y: number; width: number; height: number; rotation_degrees: number }>): Promise<void> {
  for (const expected of manifest) {
    const metadata = await sharp(bytes).metadata()
    if (!metadata.width || !metadata.height) throw new ImageCanvasRendererError('最终导出二维码无法读取尺寸', 'CANVAS_QR_INVALID')
    const left = Math.max(0, Math.floor(expected.x))
    const top = Math.max(0, Math.floor(expected.y))
    const width = Math.min(metadata.width - left, Math.ceil(expected.width))
    const height = Math.min(metadata.height - top, Math.ceil(expected.height))
    if (width < 16 || height < 16) throw new ImageCanvasRendererError(`最终导出二维码 ${expected.id} 超出画板`, 'CANVAS_QR_INVALID')
    const cropped = sharp(bytes).extract({ left, top, width, height }).ensureAlpha()
    const normalized = expected.rotation_degrees === 0
      ? cropped
      : cropped.rotate(-expected.rotation_degrees, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
    const raw = await normalized.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const decoded = jsQR(new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), raw.info.width, raw.info.height)
    if (!decoded || decoded.data !== expected.payload) throw new ImageCanvasRendererError(`最终导出二维码 ${expected.id} 无法解码`, 'CANVAS_QR_INVALID')
  }
}

function shapeSvg(layer: Extract<ImageCanvasLayer, { kind: 'shape' }>, brandColors: Record<string, string>): Buffer {
  const { width, height } = layer.transform
  const fill = layer.fill ? resolveColor(layer.fill, brandColors) : 'none'
  const stroke = layer.stroke ? resolveColor(layer.stroke, brandColors) : 'none'
  const strokeWidth = layer.stroke_width ?? 0
  const shape = layer.shape === 'rectangle'
    ? `<rect width="${width}" height="${height}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    : layer.shape === 'ellipse'
      ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
      : `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="${stroke}" stroke-width="${Math.max(1, strokeWidth)}"/>`
  return svgBuffer(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shape}</svg>`)
}

function toBlend(value: 'normal' | 'multiply' | 'screen'): Blend {
  return value === 'normal' ? 'over' : value
}

async function applyOpacity(bytes: Buffer, opacity: number): Promise<Buffer> {
  return await sharp(bytes).ensureAlpha().linear([1, 1, 1, opacity], [0, 0, 0, 0]).png().toBuffer()
}

async function applyRasterMask(sourceBytes: Buffer, maskBytes: Buffer, mode: 'alpha' | 'luminance'): Promise<Buffer> {
  const [source, mask] = await Promise.all([
    sharp(sourceBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  if (source.info.width !== mask.info.width || source.info.height !== mask.info.height) {
    throw new ImageCanvasRendererError('蒙版与目标图层边界不一致', 'CANVAS_RENDER_INVALID')
  }
  const pixels = Buffer.from(source.data)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = mode === 'alpha'
      ? mask.data[offset + 3]! / 255
      : ((mask.data[offset]! * 0.2126 + mask.data[offset + 1]! * 0.7152 + mask.data[offset + 2]! * 0.0722) / 255) * (mask.data[offset + 3]! / 255)
    pixels[offset + 3] = Math.round(pixels[offset + 3]! * alpha)
  }
  return await sharp(pixels, { raw: { width: source.info.width, height: source.info.height, channels: 4 } }).png().toBuffer()
}

export class DeterministicImageCanvasRenderer {
  async render(document: ImageCanvasDocument, inputAssets: CanvasRenderInputAsset[], brandColors: Record<string, string> = {}): Promise<CanvasRenderOutput> {
    const assets = new Map(inputAssets.map(asset => [asset.id, asset.verified]))
    const dependencyHashes = new Set<`sha256:${string}`>()
    const fontHashes = new Set<`sha256:${string}`>()
    const textManifest: CanvasRenderOutput['text_layout_manifest'] = []
    const qrManifest: CanvasRenderOutput['qr_manifest'] = []
    const composites: Array<{ input: Buffer; left: number; top: number; blend: Blend }> = []
    const output = sharp({
      create: {
        width: document.width,
        height: document.height,
        channels: 4,
        background: document.background.kind === 'transparent' ? { r: 0, g: 0, b: 0, alpha: 0 } : document.background.color,
      },
    }).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    const renderLayerList = async (layers: ImageCanvasLayer[]): Promise<void> => {
      const siblingById = new Map(layers.map(layer => [layer.id, layer]))
      const masks = new Map<string, Extract<ImageCanvasLayer, { kind: 'mask' }>>()
      for (const layer of layers) {
        if (layer.kind !== 'mask') continue
        const target = siblingById.get(layer.target_layer_id)
        if (!target || target.kind !== 'raster') throw new ImageCanvasRendererError('蒙版只能指向同一分组中的 Raster 图层', 'CANVAS_RENDER_INVALID')
        if (masks.has(layer.target_layer_id)) throw new ImageCanvasRendererError('同一 Raster 图层只能有一个蒙版', 'CANVAS_RENDER_INVALID')
        masks.set(layer.target_layer_id, layer)
      }
      for (const layer of layers) {
        if (layer.kind === 'group') {
          await renderLayerList(layer.children)
          continue
        }
        if (layer.kind === 'mask') continue
        if (layer.kind === 'raster' || layer.kind === 'logo') {
        const source = assets.get(layer.source_asset_id)
        if (!source) throw new ImageCanvasRendererError('画布引用的素材不存在', 'CANVAS_ASSET_MISSING')
        dependencyHashes.add(source.content_hash)
        let image = sharp(source.bytes).rotate().ensureAlpha()
        if (layer.kind === 'raster' && layer.source_crop) {
          if (layer.source_crop.x + layer.source_crop.width > source.width || layer.source_crop.y + layer.source_crop.height > source.height) {
            throw new ImageCanvasRendererError('Raster 裁切范围超出源图像', 'CANVAS_RENDER_INVALID')
          }
          image = image.extract({ left: Math.floor(layer.source_crop.x), top: Math.floor(layer.source_crop.y), width: Math.floor(layer.source_crop.width), height: Math.floor(layer.source_crop.height) })
        }
        const transform = layer.transform
        const baseWidth = bounded(transform.width)
        const baseHeight = bounded(transform.height)
        let rendered = Buffer.from(await image.resize({ width: baseWidth, height: baseHeight, fit: 'fill' }).png().toBuffer())
        const mask = layer.kind === 'raster' ? masks.get(layer.id) : undefined
        if (mask) {
          const maskSource = assets.get(mask.source_asset_id)
          if (!maskSource) throw new ImageCanvasRendererError('画布蒙版素材不存在', 'CANVAS_ASSET_MISSING')
          dependencyHashes.add(maskSource.content_hash)
          const maskPixels = await sharp(maskSource.bytes).rotate().ensureAlpha().resize({ width: baseWidth, height: baseHeight, fit: 'fill' }).png().toBuffer()
          rendered = Buffer.from(await applyRasterMask(rendered, maskPixels, mask.mode))
        }
        if (layer.kind === 'raster') rendered = Buffer.from(await applyOpacity(rendered, layer.opacity))
        const transformed = await transformRenderedImage(rendered, transform)
        composites.push({ input: transformed.bytes, left: transformed.left, top: transformed.top, blend: layer.kind === 'raster' ? toBlend(layer.blend_mode) : 'over' })
        continue
      }
      if (layer.kind === 'shape') {
        const image = await applyOpacity(await sharp(shapeSvg(layer, brandColors)).ensureAlpha().png().toBuffer(), layer.opacity)
        const transformed = await transformRenderedImage(image, layer.transform)
        composites.push({ input: transformed.bytes, left: transformed.left, top: transformed.top, blend: 'over' })
        continue
      }
      if (layer.kind === 'text') {
        const layout = layoutText(layer)
        fontHashes.add(layout.font.hash)
        const image = await applyOpacity(await sharp(textSvg(layer, layout, brandColors)).ensureAlpha().png().toBuffer(), layer.opacity)
        const transformed = await transformRenderedImage(image, {
          x: layer.position.x, y: layer.position.y, width: layout.width, height: layout.height,
          rotation_degrees: layer.rotation_degrees, scale_x: layer.scale_x ?? 1, scale_y: layer.scale_y ?? 1,
        })
        textManifest.push({
          id: layer.id, text_hash: sha(layer.text), font_hash: layout.font.hash, font_size: layout.fontSize, width: layout.width, height: layout.height,
          lines: layout.lines, overflow: layout.overflow, runs: textRuns(layer, layout), pixel_bounds: await opaquePixelBounds(transformed),
        })
        composites.push({ input: transformed.bytes, left: transformed.left, top: transformed.top, blend: 'over' })
        continue
      }
      if (layer.kind === 'qrcode') {
        let payload: string
        if (layer.source.kind === 'payload') payload = layer.source.value
        else {
          const source = assets.get(layer.source.asset_id)
          if (!source) throw new ImageCanvasRendererError('二维码来源资产不存在', 'CANVAS_ASSET_MISSING')
          dependencyHashes.add(source.content_hash)
          const raw = await sharp(source.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
          const code = jsQR(new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), raw.info.width, raw.info.height)
          if (!code) throw new ImageCanvasRendererError('二维码来源资产无法解码', 'CANVAS_QR_INVALID')
          payload = code.data
        }
        if (layer.transform.width !== layer.transform.height || layer.transform.scale_x !== layer.transform.scale_y) {
          throw new ImageCanvasRendererError('正式二维码必须保持正方形和等比缩放', 'CANVAS_QR_INVALID')
        }
        // Generate at the resolved scale instead of interpolating QR modules.
        // This preserves the module grid before optional whole-image rotation.
        const size = bounded(layer.transform.width * layer.transform.scale_x)
        const image = await sharp(await QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: layer.error_correction, margin: layer.quiet_zone_modules, width: size }))
          .flatten({ background: '#ffffff' }).png().toBuffer()
        const transformed = await transformRenderedImage(image, {
          ...layer.transform,
          width: size,
          height: size,
          scale_x: 1,
          scale_y: 1,
        })
        qrManifest.push({ id: layer.id, payload, x: transformed.left, y: transformed.top, width: transformed.width, height: transformed.height, rotation_degrees: layer.transform.rotation_degrees })
        composites.push({ input: transformed.bytes, left: transformed.left, top: transformed.top, blend: 'over' })
      }
      }
    }
    await renderLayerList(document.layers)
    const bytes = await output.composite(composites).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer()
    await verifyRenderedQrManifest(bytes, qrManifest)
    return {
      bytes,
      dependency_hashes: [...dependencyHashes].sort(),
      font_hashes: [...fontHashes].sort(),
      text_manifest_hash: sha(JSON.stringify(textManifest)),
      text_layout_manifest: textManifest,
      qr_manifest: qrManifest,
      renderer_version: RENDERER_VERSION,
      text_layout_engine_version: TEXT_LAYOUT_ENGINE_VERSION,
    }
  }
}
