// 图像读取辅助 —— 纯代码(不装 npm、不引原生 sharp)实现 cc-haha Read 多模态分支的关键计算:
//  · 从魔数字节判断图片格式(png/jpeg/gif/webp/bmp)
//  · 从文件头解析像素宽高(不解码像素)
//  · 按 cc 的口径估算 vision token(≈ 宽*高/750,见 FileReadTool.estimateVisionImageTokens)
//  · 生成 Anthropic image content-block(base64)
// 说明:cc 用原生 sharp 对超预算图做「缩放/降采样」;本仓库不装 npm 且不能碰 media,
// 无法重采样像素,因此对「超 vision 预算」的图不做缩放,只据宽高判定并给出明确提示。
import type { ImageBlock } from '../types/message'

export type SupportedImageFormat = 'png' | 'jpeg' | 'gif' | 'webp'
export type DetectedImageFormat = SupportedImageFormat | 'bmp'

export interface ImageDimensions {
  width: number
  height: number
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
const VISION_SUPPORTED = new Set<DetectedImageFormat>(['png', 'jpeg', 'gif', 'webp'])

// cc 对齐:vision 大致按 宽*高/750 计费(不是 base64 文本长度)。
const VISION_TOKENS_PER_PIXEL_DIVISOR = 750

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''))
}

/** 从缓冲区魔数判断图片格式;认不出返回 null(不靠扩展名,防伪装)。 */
export function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  if (buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg'
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'gif'
  if (buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp'
  return null
}

export function mediaTypeFor(format: SupportedImageFormat): ImageBlock['source']['media_type'] {
  switch (format) {
    case 'png': return 'image/png'
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
  }
}

export function isVisionSupported(format: DetectedImageFormat): format is SupportedImageFormat {
  return VISION_SUPPORTED.has(format)
}

/** 从文件头解析宽高(不解码像素);无法解析返回 null。 */
export function getImageDimensions(buffer: Buffer, format: DetectedImageFormat): ImageDimensions | null {
  try {
    switch (format) {
      case 'png': return pngDimensions(buffer)
      case 'gif': return gifDimensions(buffer)
      case 'jpeg': return jpegDimensions(buffer)
      case 'webp': return webpDimensions(buffer)
      case 'bmp': return bmpDimensions(buffer)
    }
  } catch {
    return null
  }
}

function pngDimensions(b: Buffer): ImageDimensions | null {
  // 8 字节签名 + 4 长度 + 4 "IHDR" 后是宽(4)高(4),大端。
  if (b.length < 24) return null
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function gifDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 10) return null
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } // 逻辑屏宽高,小端
}

function bmpDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 26) return null
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) }
}

function jpegDimensions(b: Buffer): ImageDimensions | null {
  // 扫描 SOF 段(0xFFC0..0xFFCF,排除 C4/C8/CC),读其中的高(2)宽(2),大端。
  let offset = 2 // 跳过 SOI(FFD8)
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) { offset++; continue }
    let marker = b[offset + 1]!
    // 跳过填充 0xFF
    while (marker === 0xff && offset + 1 < b.length) { offset++; marker = b[offset + 1]! }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 >= b.length) return null
      return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) }
    }
    // 段长在 marker 后 2 字节(大端),含这 2 字节自身。
    if (offset + 3 >= b.length) return null
    const segLen = b.readUInt16BE(offset + 2)
    if (segLen < 2) return null
    offset += 2 + segLen
  }
  return null
}

function webpDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 30) return null
  const fourcc = b.toString('ascii', 12, 16)
  if (fourcc === 'VP8 ') {
    // 有损:关键帧起始码后 14x14 bits 宽高。
    // 帧标签 3 字节 + 起始码 3 字节(9d 01 2a),随后宽/高各 2 字节(14 位有效),小端。
    const w = b.readUInt16LE(26) & 0x3fff
    const h = b.readUInt16LE(28) & 0x3fff
    return { width: w, height: h }
  }
  if (fourcc === 'VP8L') {
    // 无损:signature 0x2f 后 14+14 位宽高(值 - 1)。
    const b0 = b[21]!, b1 = b[22]!, b2 = b[23]!, b3 = b[24]!
    const width = 1 + (((b1 & 0x3f) << 8) | b0)
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    return { width, height }
  }
  if (fourcc === 'VP8X') {
    // 扩展:canvas 宽/高各 3 字节(值 - 1),小端,起始于偏移 24。
    const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))
    const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))
    return { width, height }
  }
  return null
}

/** cc 对齐:估算图片作为 vision 块的 token 数(宽*高/750)。宽高缺失返回 null。 */
export function estimateVisionTokens(dimensions: ImageDimensions | null): number | null {
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null
  return Math.ceil((dimensions.width * dimensions.height) / VISION_TOKENS_PER_PIXEL_DIVISOR)
}

/** 生成 Anthropic image content-block(base64)。 */
export function toImageBlock(buffer: Buffer, format: SupportedImageFormat): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaTypeFor(format), data: buffer.toString('base64') },
  }
}

export interface ImageReadResult {
  format: DetectedImageFormat
  visionSupported: boolean
  dimensions: ImageDimensions | null
  estimatedVisionTokens: number | null
  byteSize: number
  /** vision 支持的格式生成的 image 块(bmp 等不支持则为 null)。 */
  imageBlock: ImageBlock | null
}

/** 读取图片缓冲 → 格式/宽高/vision token 估算/image 块。不做像素缩放(无原生库)。 */
export function readImageBuffer(buffer: Buffer): ImageReadResult | null {
  const format = detectImageFormat(buffer)
  if (!format) return null
  const dimensions = getImageDimensions(buffer, format)
  const visionSupported = isVisionSupported(format)
  return {
    format,
    visionSupported,
    dimensions,
    estimatedVisionTokens: estimateVisionTokens(dimensions),
    byteSize: buffer.length,
    imageBlock: visionSupported ? toImageBlock(buffer, format) : null,
  }
}
