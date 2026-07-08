#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pngjs from 'pngjs'

const { PNG } = pngjs

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.resolve(__dirname, '..', 'build')
const defaults = {
  src: path.join(buildDir, 'icon-source.png'),
  out: path.join(buildDir, 'icon.png'),
}

const CANVAS = 1024
const TILE = 824
const RADIUS = 185

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log('Usage: node scripts/make_rounded_icon.mjs [--src path] [--out path]')
  process.exit(0)
}

const sourcePath = path.resolve(opts.src ?? defaults.src)
const outputPath = path.resolve(opts.out ?? defaults.out)
const source = PNG.sync.read(fs.readFileSync(sourcePath))
if (source.width <= 0 || source.height <= 0) {
  throw new Error(`Invalid PNG dimensions: ${sourcePath}`)
}

const art = resizeBilinear(source, TILE, TILE)
const canvas = new PNG({ width: CANVAS, height: CANVAS })
canvas.data.fill(0)

const offset = Math.floor((CANVAS - TILE) / 2)
for (let y = 0; y < TILE; y += 1) {
  for (let x = 0; x < TILE; x += 1) {
    const srcIdx = (y * TILE + x) * 4
    const dstIdx = ((y + offset) * CANVAS + x + offset) * 4
    const coverage = roundedRectCoverage(x, y, TILE, TILE, RADIUS)
    canvas.data[dstIdx] = art.data[srcIdx]
    canvas.data[dstIdx + 1] = art.data[srcIdx + 1]
    canvas.data[dstIdx + 2] = art.data[srcIdx + 2]
    canvas.data[dstIdx + 3] = Math.round(art.data[srcIdx + 3] * coverage)
  }
}

fs.writeFileSync(outputPath, PNG.sync.write(canvas))
console.log(`OK -> ${outputPath} (canvas ${CANVAS}, tile ${TILE}, radius ${RADIUS}, transparent alpha margin)`)

function parseArgs(args) {
  const parsed = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--src') {
      parsed.src = requiredValue(args, ++i, arg)
    } else if (arg === '--out') {
      parsed.out = requiredValue(args, ++i, arg)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function requiredValue(args, index, name) {
  const value = args[index]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function resizeBilinear(sourcePng, width, height) {
  const output = new PNG({ width, height })
  const xScale = sourcePng.width / width
  const yScale = sourcePng.height / height

  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * yScale - 0.5
    const y0 = clamp(Math.floor(sourceY), 0, sourcePng.height - 1)
    const y1 = clamp(y0 + 1, 0, sourcePng.height - 1)
    const yWeight = sourceY - Math.floor(sourceY)

    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * xScale - 0.5
      const x0 = clamp(Math.floor(sourceX), 0, sourcePng.width - 1)
      const x1 = clamp(x0 + 1, 0, sourcePng.width - 1)
      const xWeight = sourceX - Math.floor(sourceX)
      const dstIdx = (y * width + x) * 4

      for (let channel = 0; channel < 4; channel += 1) {
        const top = mix(readChannel(sourcePng, x0, y0, channel), readChannel(sourcePng, x1, y0, channel), xWeight)
        const bottom = mix(readChannel(sourcePng, x0, y1, channel), readChannel(sourcePng, x1, y1, channel), xWeight)
        output.data[dstIdx + channel] = Math.round(mix(top, bottom, yWeight))
      }
    }
  }

  return output
}

function roundedRectCoverage(x, y, width, height, radius) {
  if ((x >= radius && x < width - radius) || (y >= radius && y < height - radius)) return 1

  const samples = 4
  let inside = 0
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples
      const py = y + (sy + 0.5) / samples
      if (insideRoundedRect(px, py, width, height, radius)) inside += 1
    }
  }
  return inside / (samples * samples)
}

function insideRoundedRect(px, py, width, height, radius) {
  const cx = clamp(px, radius, width - radius)
  const cy = clamp(py, radius, height - radius)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= radius * radius
}

function readChannel(png, x, y, channel) {
  return png.data[(y * png.width + x) * 4 + channel]
}

function mix(a, b, amount) {
  return a + (b - a) * amount
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
