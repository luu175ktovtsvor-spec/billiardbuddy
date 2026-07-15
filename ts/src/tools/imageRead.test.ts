import { expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import { detectImageFormat, estimateVisionTokens, getImageDimensions, isImageExtension, readImageBuffer } from './imageRead'

function pngBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) // 签名
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function gifBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(10)
  b.write('GIF89a', 0, 'ascii')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

function jpegBuffer(width: number, height: number): Buffer {
  // SOI(FFD8) + APP0 段(带长度) + SOF0(FFC0) 段(含高/宽)。
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]) // marker + len=4 + 2 字节占位
  const sof = Buffer.alloc(11)
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0) // marker + len + precision
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

test('detectImageFormat reads magic bytes', () => {
  expect(detectImageFormat(pngBuffer(1, 1))).toBe('png')
  expect(detectImageFormat(gifBuffer(1, 1))).toBe('gif')
  expect(detectImageFormat(jpegBuffer(1, 1))).toBe('jpeg')
  expect(detectImageFormat(Buffer.from('RIFF....WEBPVP8 '))).toBe('webp')
  expect(detectImageFormat(Buffer.from([0x42, 0x4d, 0, 0]))).toBe('bmp')
  expect(detectImageFormat(Buffer.from('hello world'))).toBeNull()
})

test('getImageDimensions parses PNG/GIF/JPEG headers', () => {
  expect(getImageDimensions(pngBuffer(800, 600), 'png')).toEqual({ width: 800, height: 600 })
  expect(getImageDimensions(gifBuffer(320, 240), 'gif')).toEqual({ width: 320, height: 240 })
  expect(getImageDimensions(jpegBuffer(1024, 768), 'jpeg')).toEqual({ width: 1024, height: 768 })
})

test('estimateVisionTokens follows width*height/750', () => {
  expect(estimateVisionTokens({ width: 750, height: 1 })).toBe(1)
  expect(estimateVisionTokens({ width: 800, height: 600 })).toBe(Math.ceil((800 * 600) / 750))
  expect(estimateVisionTokens(null)).toBeNull()
  expect(estimateVisionTokens({ width: 0, height: 100 })).toBeNull()
})

test('isImageExtension recognizes common extensions', () => {
  for (const ext of ['.png', 'jpg', '.JPEG', 'webp', '.gif', 'bmp']) expect(isImageExtension(ext)).toBe(true)
  for (const ext of ['.ts', '.txt', '.pdf', 'md']) expect(isImageExtension(ext)).toBe(false)
})

test('readImageBuffer produces a base64 image block for supported formats', () => {
  const png = readImageBuffer(pngBuffer(100, 50))
  expect(png?.format).toBe('png')
  expect(png?.visionSupported).toBe(true)
  expect(png?.imageBlock?.type).toBe('image')
  expect(png?.imageBlock?.source.media_type).toBe('image/png')
  expect(png?.imageBlock?.source.data).toBe(pngBuffer(100, 50).toString('base64'))
  expect(png?.estimatedVisionTokens).toBe(Math.ceil((100 * 50) / 750))
})

test('readImageBuffer marks bmp as not vision-supported and rejects garbage', () => {
  const bmp = readImageBuffer(Buffer.from([0x42, 0x4d, ...new Array(30).fill(0)]))
  expect(bmp?.format).toBe('bmp')
  expect(bmp?.visionSupported).toBe(false)
  expect(bmp?.imageBlock).toBeNull()
  expect(readImageBuffer(Buffer.from('not an image at all'))).toBeNull()
})

test('readImageBuffer downsizes a large PNG before creating the vision block', () => {
  const png = new PNG({ width: 1800, height: 1200 })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4
      png.data[offset] = (x * 17 + y * 11) % 256
      png.data[offset + 1] = (x * 7 + y * 19) % 256
      png.data[offset + 2] = (x * 23 + y * 5) % 256
      png.data[offset + 3] = 255
    }
  }
  const original = PNG.sync.write(png)
  const result = readImageBuffer(original)
  expect(result?.previewResized).toBe(true)
  expect(Math.max(result!.previewDimensions!.width, result!.previewDimensions!.height)).toBeLessThanOrEqual(1280)
  expect(result!.previewByteSize).toBeLessThanOrEqual(384 * 1024)
  expect(Buffer.from(result!.imageBlock!.source.data, 'base64').length).toBe(result!.previewByteSize!)
  expect(result!.imageBlock!.source.media_type).toBe('image/jpeg')
})
