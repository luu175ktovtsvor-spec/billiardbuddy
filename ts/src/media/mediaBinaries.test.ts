// 媒体二进制解析链 + 功能门边界:env 显式最高且不回退、资产管理器其次、内置目录、PATH 兜底;
// 没接资产管理器时功能门必须不拦(单测/纯开发走旧降级),接了才给"准备中"结构化结果。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setActiveAssetManager, type ActiveAssetSource } from '../assets/assetManager'
import type { EnsureAssetResult } from '../assets/types'
import {
  ffmpegBinFrom,
  ffprobeBinFrom,
  gateMediaAssets,
  resolveWhisperCliPath,
  subtitleFontConfig,
  transcribeAssetsPreparingReason,
} from './mediaBinaries'
import { resolveTranscribeAvailability } from './transcribe'

const roots: string[] = []

afterEach(() => {
  setActiveAssetManager(null)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempFile(name: string, content = 'bin'): string {
  const dir = mkdtempSync(join(tmpdir(), 'qf-medbin-'))
  roots.push(dir)
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function stubSource(ready: Record<string, string>, ensure?: (id: string) => EnsureAssetResult): ActiveAssetSource {
  return {
    readyPath: id => ready[id] ?? null,
    ensureAsset: id => {
      const path = ready[id]
      if (path) return { status: 'ready', path }
      return ensure?.(id) ?? { status: 'downloading', progress: 40 }
    },
  }
}

// 隔离 env:PATH 与内置目录都指到空目录,避免开发机装的 ffmpeg 影响断言。
// 注意不能用 PATH:''——resolveExecutable 的 `env.PATH || process.env.PATH` 会把空串
// 当"没传"回落到真机 PATH,隔离就失效了(2026-07-13 真机逮到:~/bin/ffmpeg 泄进断言)。
function isolatedEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const emptyDir = mkdtempSync(join(tmpdir(), 'qf-empty-'))
  roots.push(emptyDir)
  return { PATH: emptyDir, QF_BINARIES_DIR: emptyDir, RESOURCES_PATH: emptyDir, ...extra }
}

test('ffmpegBinFrom:env 显式最高且不回退(坏路径也原样用,保持旧降级语义)', () => {
  setActiveAssetManager(stubSource({ ffmpeg: '/managed/ffmpeg' }))
  expect(ffmpegBinFrom(isolatedEnv({ FFMPEG_BIN: '/nonexistent/ffmpeg' }))).toBe('/nonexistent/ffmpeg')
})

test('ffmpegBinFrom:无显式覆盖时优先资产管理器 ready 路径,其次内置目录,最后 PATH 兜底', () => {
  const managed = tempFile('ffmpeg')
  setActiveAssetManager(stubSource({ ffmpeg: managed }))
  expect(ffmpegBinFrom(isolatedEnv())).toBe(managed)

  setActiveAssetManager(null)
  const bundled = tempFile(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  expect(ffmpegBinFrom(isolatedEnv({ QF_BINARIES_DIR: dirname(bundled) }))).toBe(bundled)
  expect(ffmpegBinFrom(isolatedEnv())).toBe('ffmpeg')
  expect(ffprobeBinFrom(isolatedEnv())).toBe('ffprobe')
})

test('resolveWhisperCliPath:资产管理器就绪路径参与解析', () => {
  const managed = tempFile('whisper-cli')
  setActiveAssetManager(stubSource({ 'whisper-cli': managed }))
  expect(resolveWhisperCliPath(isolatedEnv())).toBe(managed)
})

test('功能门:没接资产管理器 → null(调用方走旧降级,不拦)', () => {
  setActiveAssetManager(null)
  expect(gateMediaAssets(isolatedEnv(), ['ffmpeg', 'ffprobe'])).toBeNull()
  expect(transcribeAssetsPreparingReason(isolatedEnv())).toBeNull()
})

test('功能门:组件缺失且资产管理器在下 → "准备中"结构化 completed 结果(非报错)', () => {
  setActiveAssetManager(stubSource({}, () => ({ status: 'downloading', progress: 37 })))
  const gate = gateMediaAssets(isolatedEnv(), ['ffmpeg', 'ffprobe'])!
  expect(gate.blocked).toBe(true)
  expect(gate.block_reason).toBe('asset_preparing')
  expect(gate.needs_user_action).toBe(false)
  expect(gate.asset_progress).toBe(37)
  expect(String(gate.message)).toContain('37%')
  const assets = gate.assets as Array<{ id: string; status: string; progress: number }>
  expect(assets.map(asset => asset.id).sort()).toEqual(['ffmpeg', 'ffprobe'])
})

test('功能门:env 显式覆盖视为用户自管,不判缺、不拦', () => {
  setActiveAssetManager(stubSource({}, () => ({ status: 'downloading', progress: 5 })))
  expect(gateMediaAssets(isolatedEnv({ FFMPEG_BIN: '/nonexistent/ffmpeg', FFPROBE_BIN: '/nonexistent/ffprobe' }), ['ffmpeg', 'ffprobe'])).toBeNull()
})

test('功能门:组件齐全(资产管理器就绪)→ null 放行', () => {
  const ffmpeg = tempFile('ffmpeg')
  const ffprobe = tempFile('ffprobe')
  setActiveAssetManager(stubSource({ ffmpeg, ffprobe }))
  expect(gateMediaAssets(isolatedEnv(), ['ffmpeg', 'ffprobe'])).toBeNull()
})

test('转写可用性:资产管理器在下时 reason 是"正在后台准备(x%)"并触发按需下载', () => {
  const requested: string[] = []
  setActiveAssetManager(stubSource({}, id => {
    requested.push(id)
    return { status: 'downloading', progress: 12 }
  }))
  const availability = resolveTranscribeAvailability(isolatedEnv({ WHISPER_CLI: '', WHISPER_CPP_BIN: '' }))
  expect(availability.available).toBe(false)
  expect(availability.reason).toContain('正在后台准备')
  expect(availability.reason).toContain('12%')
  expect(requested.sort()).toEqual(['whisper-cli', 'whisper-model'])
})

test('转写可用性:没接资产管理器保持旧提示(需打包……)', () => {
  setActiveAssetManager(null)
  const availability = resolveTranscribeAvailability(isolatedEnv({ WHISPER_CLI: '', WHISPER_CPP_BIN: '' }))
  expect(availability.available).toBe(false)
  expect(availability.reason).toContain('需打包')
})

test('字幕中文字体:资产就绪 → fontsdir=字体所在目录 + 默认字体族,env 可换族名', () => {
  const font = tempFile('NotoSansSC-Regular.otf')
  setActiveAssetManager(stubSource({ 'zh-font': font }))
  expect(subtitleFontConfig(isolatedEnv())).toEqual({ fontsDir: dirname(font), family: 'Noto Sans SC' })
  expect(subtitleFontConfig(isolatedEnv({ QF_SUBTITLE_FONT_FAMILY: '思源黑体' }))!.family).toBe('思源黑体')
  setActiveAssetManager(null)
  expect(subtitleFontConfig(isolatedEnv())).toBeNull()
})
