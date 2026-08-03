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
  renderer_version: string
  text_layout_engine_version: string
}

const RENDERER_VERSION = 'billiardbuddy-canvas-renderer-v2'
const TEXT_LAYOUT_ENGINE_VERSION = 'resvg-fontkit-v2'
const BUILTIN_FONT_ID = 'font_builtin_0001'

function sha(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!))
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

function fontHashFor(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): `sha256:${string}` {
  if (layer.font_asset_id !== BUILTIN_FONT_ID) {
    throw new ImageCanvasRendererError('未提供可验证的正式字体资产', 'CANVAS_FONT_MISSING')
  }
  const path = builtinFontPath()
  // Parse, rather than trust a file name, so a damaged platform font cannot
  // silently become an untracked renderer dependency.
  let font: ReturnType<typeof openSync>
  try { font = openSync(path) } catch { throw new ImageCanvasRendererError('正式字体包无法解析', 'CANVAS_FONT_MISSING') }
  const faces = font.fonts ?? [font]
  for (const char of layer.text) {
    if (/\s/u.test(char)) continue
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || !faces.some(face => face.hasGlyphForCodePoint?.(codePoint))) {
      throw new ImageCanvasRendererError('正式字体缺少画布文本所需字形', 'CANVAS_FONT_GLYPH_MISSING')
    }
  }
  // The exact parsed bytes, rather than a display name or path, are part of
  // every receipt. A machine with another registered builtin font therefore
  // cannot silently reproduce a historical Version under the same identity.
  return sha(readFileSync(path))
}

/** Preflight calls the same verifier as rendering, so no glyph failure is deferred until export. */
export function assertFormalTextLayer(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): void {
  fontHashFor(layer)
}

function resolveColor(value: string, brandColors: Record<string, string>): string {
  if (!value.startsWith('brand.')) return value
  const resolved = brandColors[value.slice('brand.'.length)]
  if (!resolved) throw new ImageCanvasRendererError(`品牌色 Token ${value} 未在锁定 Brand Kit 中定义`, 'CANVAS_RENDER_INVALID')
  return resolved
}

function textSvg(layer: Extract<ImageCanvasLayer, { kind: 'text' }>, brandColors: Record<string, string>): Buffer {
  const width = bounded(layer.max_width ?? Math.max(layer.font_size, layer.text.length * layer.font_size * 1.3))
  const height = bounded(layer.max_height ?? Math.ceil(layer.font_size * layer.line_height * (layer.text.split('\n').length + 0.4)))
  const fontSize = layer.font_size
  const lines = layer.text.split('\n').map((line, index) => `<tspan x="${layer.align === 'center' ? width / 2 : layer.align === 'right' ? width : 0}" dy="${index === 0 ? fontSize : fontSize * layer.line_height}">${escapeXml(line)}</tspan>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="0" y="0" font-family="BilliardBuddy Builtin CJK" font-size="${fontSize}" font-weight="${layer.font_weight}" font-style="${layer.font_style}" letter-spacing="${layer.letter_spacing}" fill="${resolveColor(layer.fill, brandColors)}"${layer.stroke ? ` stroke="${resolveColor(layer.stroke, brandColors)}"` : ''} text-anchor="${layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start'}">${lines}</text></svg>`
  return svgBuffer(svg, builtinFontPath())
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
    const textManifest: Array<Record<string, unknown>> = []
    const expectedQr: string[] = []
    let output = sharp({
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
        const targetWidth = bounded(transform.width * transform.scale_x)
        const targetHeight = bounded(transform.height * transform.scale_y)
        let rendered = Buffer.from(await image.resize({ width: targetWidth, height: targetHeight, fit: 'fill' }).png().toBuffer())
        const mask = layer.kind === 'raster' ? masks.get(layer.id) : undefined
        if (mask) {
          const maskSource = assets.get(mask.source_asset_id)
          if (!maskSource) throw new ImageCanvasRendererError('画布蒙版素材不存在', 'CANVAS_ASSET_MISSING')
          dependencyHashes.add(maskSource.content_hash)
          const maskPixels = await sharp(maskSource.bytes).rotate().ensureAlpha().resize({ width: targetWidth, height: targetHeight, fit: 'fill' }).png().toBuffer()
          rendered = Buffer.from(await applyRasterMask(rendered, maskPixels, mask.mode))
        }
        rendered = Buffer.from(await sharp(rendered).rotate(transform.rotation_degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
        if (layer.kind === 'raster') rendered = Buffer.from(await applyOpacity(rendered, layer.opacity))
        output = output.composite([{ input: rendered, left: Math.round(transform.x), top: Math.round(transform.y), blend: layer.kind === 'raster' ? toBlend(layer.blend_mode) : 'over' }])
        continue
      }
      if (layer.kind === 'shape') {
        const image = await applyOpacity(await sharp(shapeSvg(layer, brandColors)).ensureAlpha().png().toBuffer(), layer.opacity)
        output = output.composite([{ input: image, left: Math.round(layer.transform.x), top: Math.round(layer.transform.y), blend: 'over' }])
        continue
      }
      if (layer.kind === 'text') {
        fontHashes.add(fontHashFor(layer))
        textManifest.push({ id: layer.id, text: layer.text, font: layer.font_asset_id, locale: layer.locale, requirement: layer.requirement_id })
        const image = await applyOpacity(await sharp(textSvg(layer, brandColors)).ensureAlpha().png().toBuffer(), layer.opacity)
        output = output.composite([{ input: image, left: Math.round(layer.position.x), top: Math.round(layer.position.y), blend: 'over' }])
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
        expectedQr.push(payload)
        const image = await QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: layer.error_correction, margin: layer.quiet_zone_modules, width: bounded(Math.min(layer.transform.width, layer.transform.height)) })
        output = output.composite([{ input: image, left: Math.round(layer.transform.x), top: Math.round(layer.transform.y), blend: 'over' }])
      }
      }
    }
    await renderLayerList(document.layers)
    const bytes = await output.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer()
    if (expectedQr.length > 0) {
      const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const decoded = jsQR(new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), raw.info.width, raw.info.height)
      if (!decoded || !expectedQr.includes(decoded.data)) throw new ImageCanvasRendererError('最终画布二维码无法解码', 'CANVAS_QR_INVALID')
    }
    return {
      bytes,
      dependency_hashes: [...dependencyHashes].sort(),
      font_hashes: [...fontHashes].sort(),
      text_manifest_hash: sha(JSON.stringify(textManifest)),
      renderer_version: RENDERER_VERSION,
      text_layout_engine_version: TEXT_LAYOUT_ENGINE_VERSION,
    }
  }
}
