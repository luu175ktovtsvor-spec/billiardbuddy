import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dockerfile = readFileSync(resolve(import.meta.dir, '../../deploy/production/Dockerfile.video-media-relay'), 'utf8')

function position(fragment: string): number {
  const value = dockerfile.indexOf(fragment)
  expect(value).toBeGreaterThanOrEqual(0)
  return value
}

test('Video Relay 镜像将 libass 和受控 CJK 字体作为烧录字幕的启动前置条件', () => {
  const packages = position('apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-noto-cjk libass9')
  const fontDirectory = position('VIDEO_MEDIA_SUBTITLE_FONT_DIR=/app/runtime-assets/fonts')
  const fontConfig = position('VIDEO_MEDIA_SUBTITLE_FONT_CONFIG=/app/runtime-assets/fonts/fonts.conf')
  const sourceResolution = position("font_path=\"$(fc-match -f '%{file}' 'Noto Sans CJK SC:style=Regular' | head -n 1)\"")
  const copy = position('NotoSansCJKSC-Regular.ttc')
  const cache = position('FONTCONFIG_FILE="$VIDEO_MEDIA_SUBTITLE_FONT_CONFIG" FONTCONFIG_PATH=/etc/fonts fc-cache -f')
  const explicitResolution = position('FONTCONFIG_FILE="$VIDEO_MEDIA_SUBTITLE_FONT_CONFIG" FONTCONFIG_PATH=/etc/fonts fc-match')
  const probe = position('> "$VIDEO_MEDIA_SUBTITLE_FONT_PROBE"')
  const unprivileged = position('USER bun')
  const subtitleFilter = position("grep -q '[[:space:]]subtitles[[:space:]]'")
  const fontsdir = position('fontsdir=$VIDEO_MEDIA_SUBTITLE_FONT_DIR')
  const readyCapability = position('export VIDEO_MEDIA_SUBTITLE_RUNTIME_READY=1')
  const startupMarker = position("'video_relay_subtitle_runtime_ready'")
  const failClosedStart = position('&& exec bun /app/video-media-relay/app.ts')

  expect(fontDirectory).toBeLessThan(fontConfig)
  expect(fontConfig).toBeLessThan(packages)
  expect(packages).toBeLessThan(sourceResolution)
  expect(sourceResolution).toBeLessThan(copy)
  expect(copy).toBeLessThan(cache)
  expect(cache).toBeLessThan(explicitResolution)
  expect(explicitResolution).toBeLessThan(probe)
  expect(probe).toBeLessThan(unprivileged)
  expect(unprivileged).toBeLessThan(subtitleFilter)
  expect(subtitleFilter).toBeLessThan(fontsdir)
  expect(fontsdir).toBeLessThan(readyCapability)
  expect(readyCapability).toBeLessThan(startupMarker)
  expect(startupMarker).toBeLessThan(failClosedStart)
  expect(dockerfile).not.toContain('|| true')
})
