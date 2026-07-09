// B-Roll 视觉引擎共用的 ffmpeg spawn 小工具。
//
// 三条硬约束:全本地(bundled ffmpeg)、免 key、Windows 可打包。
// 只用 node:child_process spawn 外部 ffmpeg,不 require 任何 .node(避开 ts/CLAUDE.md §8
// Bun+Windows 段错误)。缺 ffmpeg / 失败一律由各调用方 try/catch 优雅降级,绝不崩。

import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { ffmpegBinFrom as sharedFfmpegBinFrom } from './mediaBinaries'

/** 统一解析链(env 显式 → 资产管理器 → 内置 → PATH),实现见 mediaBinaries。 */
export function ffmpegBinFrom(env: Record<string, string | undefined> | undefined): string {
  return sharedFfmpegBinFrom(env)
}

export interface FfmpegRunOptions {
  cwd?: string
  signal?: AbortSignal
  timeoutMs: number
}

export interface FfmpegTextResult {
  stdout: string
  stderr: string
  code: number | null
}

export interface FfmpegBinaryResult {
  stdout: Buffer
  stderr: string
  code: number | null
}

/** 跑一次 ffmpeg,stdout/stderr 都当文本收(scene/signalstats 等诊断输出走 stderr)。 */
export function runFfmpegText(bin: string, args: string[], opts: FfmpegRunOptions): Promise<FfmpegTextResult> {
  return runFfmpegBinary(bin, args, opts).then(r => ({ stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code }))
}

/** 跑一次 ffmpeg,stdout 收为 Buffer(抽 PCM 等二进制到 stdout 时用),stderr 仍是文本。 */
export function runFfmpegBinary(bin: string, args: string[], opts: FfmpegRunOptions): Promise<FfmpegBinaryResult> {
  if (opts.signal?.aborted) return Promise.reject(new Error('任务已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const onAbort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${basename(bin)} 超时`))
    }, opts.timeoutMs)
    child.stdout?.on('data', c => out.push(Buffer.from(c)))
    child.stderr?.on('data', c => err.push(Buffer.from(c)))
    child.on('error', e => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('任务已取消'))
      resolvePromise({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), code })
    })
  })
}
