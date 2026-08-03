import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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

const RENDERER_VERSION = 'billiardbuddy-canvas-renderer-v1'
const TEXT_LAYOUT_ENGINE_VERSION = 'resvg-fontkit-v1'
const BUILTIN_FONT_ID = 'font_builtin_0001'
const BUILTIN_FONT_PATHS = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]

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

function flatten(layers: ImageCanvasLayer[]): ImageCanvasLayer[] {
  return layers.flatMap(layer => layer.kind === 'group' ? flatten(layer.children) : [layer])
}

function bounded(value: number): number { return Math.max(1, Math.min(12_000, Math.round(value))) }

function builtinFontPath(): string {
  const path = BUILTIN_FONT_PATHS.find(candidate => existsSync(candidate))
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

function textSvg(layer: Extract<ImageCanvasLayer, { kind: 'text' }>): Buffer {
  const width = bounded(layer.max_width ?? Math.max(layer.font_size, layer.text.length * layer.font_size * 1.3))
  const height = bounded(layer.max_height ?? Math.ceil(layer.font_size * layer.line_height * (layer.text.split('\n').length + 0.4)))
  const fontSize = layer.font_size
  const lines = layer.text.split('\n').map((line, index) => `<tspan x="${layer.align === 'center' ? width / 2 : layer.align === 'right' ? width : 0}" dy="${index === 0 ? fontSize : fontSize * layer.line_height}">${escapeXml(line)}</tspan>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="0" y="0" font-family="BilliardBuddy Builtin CJK" font-size="${fontSize}" font-weight="${layer.font_weight}" font-style="${layer.font_style}" letter-spacing="${layer.letter_spacing}" fill="${layer.fill}"${layer.stroke ? ` stroke="${layer.stroke}"` : ''} text-anchor="${layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start'}">${lines}</text></svg>`
  return svgBuffer(svg, builtinFontPath())
}

function shapeSvg(layer: Extract<ImageCanvasLayer, { kind: 'shape' }>): Buffer {
  const { width, height } = layer.transform
  const fill = layer.fill ?? 'none'
  const stroke = layer.stroke ?? 'none'
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

export class DeterministicImageCanvasRenderer {
  async render(document: ImageCanvasDocument, inputAssets: CanvasRenderInputAsset[]): Promise<CanvasRenderOutput> {
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
    for (const layer of flatten(document.layers)) {
      if (layer.kind === 'mask') continue
      if (layer.kind === 'raster' || layer.kind === 'logo') {
        const source = assets.get(layer.source_asset_id)
        if (!source) throw new ImageCanvasRendererError('画布引用的素材不存在', 'CANVAS_ASSET_MISSING')
        dependencyHashes.add(source.content_hash)
        let image = sharp(source.bytes).rotate().ensureAlpha()
        if (layer.kind === 'raster' && layer.source_crop) {
          image = image.extract({ left: Math.floor(layer.source_crop.x), top: Math.floor(layer.source_crop.y), width: Math.floor(layer.source_crop.width), height: Math.floor(layer.source_crop.height) })
        }
        const transform = layer.transform
        const rendered = await image.resize({ width: bounded(transform.width * transform.scale_x), height: bounded(transform.height * transform.scale_y), fit: 'fill' })
          .rotate(transform.rotation_degrees, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .ensureAlpha(layer.kind === 'raster' ? layer.opacity : 1).png().toBuffer()
        output = output.composite([{ input: rendered, left: Math.round(transform.x), top: Math.round(transform.y), blend: layer.kind === 'raster' ? toBlend(layer.blend_mode) : 'over' }])
        continue
      }
      if (layer.kind === 'shape') {
        const image = await sharp(shapeSvg(layer)).ensureAlpha(layer.opacity).png().toBuffer()
        output = output.composite([{ input: image, left: Math.round(layer.transform.x), top: Math.round(layer.transform.y), blend: 'over' }])
        continue
      }
      if (layer.kind === 'text') {
        fontHashes.add(fontHashFor(layer))
        textManifest.push({ id: layer.id, text: layer.text, font: layer.font_asset_id, locale: layer.locale, requirement: layer.requirement_id })
        const image = await sharp(textSvg(layer)).ensureAlpha(layer.opacity).png().toBuffer()
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
