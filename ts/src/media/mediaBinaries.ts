// 媒体外部二进制/资产统一解析 + 功能门(反逻辑保护)。
//
// 解析链(对所有媒体二进制统一):env 显式覆盖(最高、不回退,测试/开发注入用)
// → 资产管理器 ready 路径(瘦安装包后台下载落位)→ 打包内置目录(过渡期兼容)
// → 系统 PATH(开发机)。
//
// 功能门:某功能依赖的组件还没就绪时,返回 portraitGate consent_required 同款的
// "结构化 completed 结果"(blocked + 大白话 message + 进度),同时触发按需下载——
// 绝不静默失败、绝不点了没反应。没接资产管理器(单测/纯开发)时功能门不拦,
// 走各调用方原有的优雅降级路径。

import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { ASSET_IDS, ensureManagedAsset, managedAssetPath } from '../assets/assetManager'
import type { EnsureAssetResult } from '../assets/types'

type Env = Record<string, string | undefined>

function toEnv(env: Env | undefined): Env {
  return env ?? process.env
}

/** PATH 查找可执行文件(带路径的直接判存在;win 补 .exe/.cmd/.bat)。 */
export function resolveExecutable(command: string, env: Env): string | null {
  if (!command.trim()) return null
  const direct = command.includes('/') || command.includes('\\') ? resolve(command) : ''
  if (direct) return existsSync(direct) ? direct : null
  const path = env.PATH || process.env.PATH || ''
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 打包内置 binaries 候选目录:显式 env、prod resourcesPath、cwd/desktop/binaries。 */
export function binaryDirs(env: Env): string[] {
  const explicitDir = env.QF_BINARIES_DIR?.trim()
  // 显式目录是受控查找边界；不要再旁路执行 cwd 或相邻目录里的同名二进制。
  if (explicitDir) return [resolve(explicitDir)]
  const dirs: string[] = []
  const resourcesPath = env.RESOURCES_PATH || (process as unknown as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) dirs.push(join(resourcesPath, 'binaries'))
  dirs.push(join(process.cwd(), 'desktop', 'binaries'))
  dirs.push(join(process.cwd(), '..', 'desktop', 'binaries'))
  return dirs
}

function exeName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

function bundledBinary(base: string, env: Env): string | null {
  for (const dir of binaryDirs(env)) {
    const candidate = join(dir, exeName(base))
    if (existsSync(candidate)) return candidate
  }
  return null
}

function explicitOf(env: Env, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return null
}

/**
 * ffmpeg 命令:env 显式 → 资产管理器 → 内置目录 → 'ffmpeg'(PATH 兜底)。
 * 显式覆盖原样返回不验存在(与旧行为一致:坏路径由 spawn 失败走各方降级)。
 */
export function ffmpegBinFrom(env?: Env): string {
  const e = toEnv(env)
  return explicitOf(e, ['FFMPEG_BIN', 'FFMPEG_PATH'])
    ?? managedAssetPath(ASSET_IDS.ffmpeg)
    ?? bundledBinary('ffmpeg', e)
    ?? 'ffmpeg'
}

/** ffprobe 命令,同 ffmpegBinFrom 链路。 */
export function ffprobeBinFrom(env?: Env): string {
  const e = toEnv(env)
  return explicitOf(e, ['FFPROBE_BIN', 'FFPROBE_PATH'])
    ?? managedAssetPath(ASSET_IDS.ffprobe)
    ?? bundledBinary('ffprobe', e)
    ?? 'ffprobe'
}

/** whisper-cli 绝对路径:env 显式 → 资产管理器 → 内置目录 → PATH(whisper-cli/main)。 */
export function resolveWhisperCliPath(env?: Env): string | null {
  const e = toEnv(env)
  const explicit = resolveExecutable(e.WHISPER_CLI || e.WHISPER_CPP_BIN || '', e)
  if (explicit) return explicit
  const managed = managedAssetPath(ASSET_IDS.whisperCli)
  if (managed) return managed
  const bundled = bundledBinary('whisper-cli', e)
  if (bundled) return bundled
  return resolveExecutable('whisper-cli', e) ?? resolveExecutable('main', e)
}

const WHISPER_MODEL_CANDIDATES = [
  'ggml-large-v3-turbo.bin',
  'ggml-large-v3-turbo-q8_0.bin',
  'ggml-large-v3-turbo-q5_0.bin',
  'ggml-large-v3.bin',
  'ggml-large-v3-q5_0.bin',
  'ggml-medium.bin',
  'ggml-medium-q5_0.bin',
  'ggml-small.bin',
  'model.bin',
]

/** 转写权重绝对路径:env 直指 → 资产管理器 → WHISPER_MODEL_DIR/内置 models 目录扫候选名。 */
export function resolveWhisperModelPath(env?: Env): string {
  const e = toEnv(env)
  const direct = e.WHISPER_MODEL_PATH || e.WHISPER_CPP_MODEL
  if (direct && existsSync(direct)) return direct
  const managed = managedAssetPath(ASSET_IDS.whisperModel)
  if (managed) return managed
  const dirs: string[] = []
  if (e.WHISPER_MODEL_DIR?.trim()) dirs.push(e.WHISPER_MODEL_DIR.trim())
  for (const base of binaryDirs(e)) {
    dirs.push(join(base, 'models'))
    dirs.push(base)
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of WHISPER_MODEL_CANDIDATES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/** 字幕烧录中文字体:资产管理器就绪(或 env 显式指目录)→ 给 fontsdir + 字体族名。 */
export function subtitleFontConfig(env?: Env): { fontsDir: string; family: string } | null {
  const e = toEnv(env)
  const family = e.QF_SUBTITLE_FONT_FAMILY?.trim() || 'Noto Sans SC'
  const explicitDir = e.QF_SUBTITLE_FONT_DIR?.trim()
  if (explicitDir && existsSync(explicitDir)) return { fontsDir: explicitDir, family }
  const managed = managedAssetPath(ASSET_IDS.zhFont)
  if (managed) return { fontsDir: dirname(managed), family }
  return null
}

/** 超分二进制绝对路径:env 显式 → 资产管理器 → 内置目录 → PATH。缺则 null(上层功能门提示"正在准备组件x%")。 */
export function resolveRealesrganPath(env?: Env): string | null {
  const e = toEnv(env)
  const explicit = resolveExecutable(e.REALESRGAN_BIN || '', e)
  if (explicit) return explicit
  const managed = managedAssetPath(ASSET_IDS.realesrgan)
  if (managed) return managed
  const bundled = bundledBinary('realesrgan-ncnn-vulkan', e)
  if (bundled) return bundled
  return resolveExecutable('realesrgan-ncnn-vulkan', e) ?? resolveExecutable('realesrgan', e)
}

// ── 功能门 ────────────────────────────────────────────────────────────────────

export type MediaBinaryNeed = 'ffmpeg' | 'ffprobe' | 'whisper' | 'realesrgan'

/** 一个 need 缺哪些资产 id(env 显式覆盖视为用户自管、不判缺,保持门与实际 spawn 一致)。 */
function missingAssetIdsFor(need: MediaBinaryNeed, env: Env): string[] {
  if (need === 'ffmpeg') {
    if (explicitOf(env, ['FFMPEG_BIN', 'FFMPEG_PATH'])) return []
    const found = managedAssetPath(ASSET_IDS.ffmpeg) ?? bundledBinary('ffmpeg', env) ?? resolveExecutable('ffmpeg', env)
    return found ? [] : [ASSET_IDS.ffmpeg]
  }
  if (need === 'ffprobe') {
    if (explicitOf(env, ['FFPROBE_BIN', 'FFPROBE_PATH'])) return []
    const found = managedAssetPath(ASSET_IDS.ffprobe) ?? bundledBinary('ffprobe', env) ?? resolveExecutable('ffprobe', env)
    return found ? [] : [ASSET_IDS.ffprobe]
  }
  if (need === 'realesrgan') {
    if (explicitOf(env, ['REALESRGAN_BIN'])) return []
    return resolveRealesrganPath(env) ? [] : [ASSET_IDS.realesrgan]
  }
  // whisper = 转写二进制 + 权重都要;用户显式自管(自定义命令/直指路径)则不判缺。
  const missing: string[] = []
  if (!env.WHISPER_TRANSCRIBE_COMMAND?.trim()) {
    if (!explicitOf(env, ['WHISPER_CLI', 'WHISPER_CPP_BIN']) && !resolveWhisperCliPath(env)) missing.push(ASSET_IDS.whisperCli)
    const modelExplicit = env.WHISPER_MODEL_PATH || env.WHISPER_CPP_MODEL
    if (!modelExplicit && !resolveWhisperModelPath(env)) missing.push(ASSET_IDS.whisperModel)
  }
  return missing
}

export interface AssetGateEntry {
  id: string
  ensure: EnsureAssetResult
}

/**
 * "组件准备中"结构化结果(照 portraitGate consent_required 模式:任务正常完成、非报错,
 * agent 读到后用大白话告诉用户等一下,前端也能拿 assets/进度画"准备中 x%")。
 */
export function assetPreparingResult(entries: AssetGateEntry[]): Record<string, unknown> {
  const progresses = entries.map(entry => entry.ensure.status === 'downloading' ? entry.ensure.progress : 0)
  const progress = progresses.length ? Math.min(...progresses) : 0
  const retryScheduled = entries.some(entry => entry.ensure.status === 'failed' && entry.ensure.retryScheduled)
  return {
    blocked: true,
    block_reason: 'asset_preparing',
    asset_gate: 'preparing',
    needs_user_action: false,
    local_preview: false,
    asset_progress: progress,
    retry_scheduled: retryScheduled,
    assets: entries.map(entry => ({
      id: entry.id,
      status: entry.ensure.status,
      progress: entry.ensure.status === 'downloading' ? entry.ensure.progress : 0,
    })),
    message: `这个功能需要的组件正在后台准备(${progress}%),准备好后会自动可用;稍等片刻再试一次就行,不用做任何操作。`,
  }
}

/**
 * 媒体功能门:检查 needs 对应组件是否可用;缺的触发按需下载并返回"准备中"结构化结果。
 * 全部可用 / 没接资产管理器(单测、纯开发)→ null,调用方继续走原路径。
 */
export function gateMediaAssets(env: Env | undefined, needs: MediaBinaryNeed[]): Record<string, unknown> | null {
  const e = toEnv(env)
  const entries: AssetGateEntry[] = []
  for (const need of needs) {
    for (const id of missingAssetIdsFor(need, e)) {
      entries.push({ id, ensure: ensureManagedAsset(id) })
    }
  }
  if (entries.length === 0) return null
  const actionable = entries.filter(entry => !(entry.ensure.status === 'failed' && !entry.ensure.retryScheduled))
  if (actionable.length === 0) return null
  return assetPreparingResult(actionable)
}

/**
 * 转写组件"准备中"的一句话原因(给 resolveTranscribeAvailability/语音输入用);
 * 仅显式本地离线模式调用；没接资产管理器或组件齐全 → null。
 * 调用即触发缺失资产的按需下载，远程 provider 失败不得调用。
 */
export function transcribeAssetsPreparingReason(env?: Env): string | null {
  const gate = gateMediaAssets(env, ['whisper'])
  if (!gate) return null
  const progress = typeof gate.asset_progress === 'number' ? gate.asset_progress : 0
  return `转写组件正在后台准备(${progress}%),准备好后会自动可用;稍等片刻再试就行。`
}
