import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upscaleImage, upscaleAvailable, UpscaleUnavailableError } from './imageUpscale'

const NO_BIN = { PATH: '/nonexistent-qf-upscale-dir' }

test('upscaleAvailable: FFmpeg 缺失时不可用', () => {
  expect(upscaleAvailable(NO_BIN)).toBe(false)
})

test('upscaleImage: FFmpeg 未就绪时抛可识别错误', async () => {
  await expect(upscaleImage('/tmp/whatever.png', { env: NO_BIN })).rejects.toBeInstanceOf(UpscaleUnavailableError)
})

test('upscaleImage: 使用 Lanczos 和轻锐化生成新的三倍尺寸图片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'image-upscale-'))
  const input = join(root, 'source.png')
  const output = join(root, 'output.png')
  const argsFile = join(root, 'args.txt')
  const ffmpeg = join(root, 'fake-ffmpeg.sh')
  writeFileSync(input, 'source')
  writeFileSync(ffmpeg, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argsFile}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "scaled" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })

  try {
    expect(upscaleAvailable({ PATH: '', FFMPEG_BIN: ffmpeg })).toBe(true)
    expect(await upscaleImage(input, {
      env: { PATH: '', FFMPEG_BIN: ffmpeg },
      scale: 3,
      outputPath: output,
    })).toBe(output)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(argsFile, 'utf8')).toContain('scale=iw*3:ih*3:flags=lanczos')
    expect(readFileSync(argsFile, 'utf8')).toContain('unsharp=5:5:0.35:5:5:0.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
