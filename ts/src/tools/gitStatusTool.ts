import { execFile, spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import type { Tool } from './Tool'

const execFileP = promisify(execFile)
const DEFAULT_MAX_DIFF_BYTES = 80_000
const MAX_DIFF_BYTES = 400_000
const DEFAULT_MAX_UNTRACKED_BYTES = 40_000
const MAX_UNTRACKED_BYTES = 200_000

export interface GitStatusInput {
  include_diff?: boolean | string
  include_untracked?: boolean | string
  staged?: boolean | string
  max_diff_bytes?: number | string
  max_untracked_bytes?: number | string
  paths?: string | string[]
}

type DiffMode = 'worktree' | 'staged' | 'both'

export const gitStatusTool: Tool<GitStatusInput> = {
  name: 'git_status',
  description:
    `Read git branch/status and optional bounded diff for the workspace. Input: { include_diff?, include_untracked?, staged?, max_diff_bytes?, max_untracked_bytes?, paths? }. ` +
    'Use this after file edits to inspect what changed without running arbitrary shell commands.',
  inputSchema: {
    type: 'object',
    properties: {
      include_diff: { type: ['boolean', 'string'], description: 'Set true to include a bounded git diff body.' },
      include_untracked: { type: ['boolean', 'string'], description: 'When include_diff is true, include bounded previews for untracked text files. Defaults true.' },
      staged: { type: ['boolean', 'string'], description: 'When include_diff is true, inspect staged diff with --cached. Use "both" to include staged and unstaged diffs separately.' },
      max_diff_bytes: { type: ['number', 'string'], description: `Diff body byte cap, default ${DEFAULT_MAX_DIFF_BYTES}, max ${MAX_DIFF_BYTES}.` },
      max_untracked_bytes: { type: ['number', 'string'], description: `Untracked file preview total byte cap, default ${DEFAULT_MAX_UNTRACKED_BYTES}, max ${MAX_UNTRACKED_BYTES}.` },
      paths: { type: ['array', 'string'], items: { type: 'string' }, description: 'Optional workspace-relative path or path list to limit status/diff.' },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const cwd = ctx.workspace.root
    if (!(await isGitRepo(cwd))) return '<git_status is_git="false">\n当前工作区不是 git 仓库。\n</git_status>'
    const includeDiff = semanticBoolean(input?.include_diff)
    const mode = diffMode(input?.staged)
    const paths = normalizePathspecs(input?.paths, ctx)
    const branch = await git(cwd, ['--no-optional-locks', 'branch', '--show-current']).then(s => s.trim()).catch(() => '')
    const status = await git(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', ...pathArgs(paths)]).then(s => s.trim()).catch(errText)
    const summary = summarizePorcelainStatus(status)
    const stat = await git(cwd, ['--no-optional-locks', 'diff', '--no-color', '--stat', ...(mode === 'staged' ? ['--cached'] : []), ...pathArgs(paths)]).then(s => s.trim()).catch(errText)
    const parts = [
      `<git_status is_git="true" branch="${xmlAttr(branch || '(detached)')}" diff="${includeDiff ? 'true' : 'false'}" staged="${mode === 'staged' ? 'true' : mode === 'both' ? 'both' : 'false'}" scope="${mode}">`,
      formatSummary(summary),
      '<status>',
      xmlText(status || '(clean)'),
      '</status>',
      '<diff_stat>',
      xmlText(stat || '(no diff)'),
      '</diff_stat>',
    ]
    if (includeDiff) {
      const maxBytes = clampBytes(input?.max_diff_bytes)
      const raw = await gitBuffer(cwd, ['--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', ...(mode === 'staged' ? ['--cached'] : []), ...pathArgs(paths)], MAX_DIFF_BYTES + 1)
        .catch(err => Buffer.from(errText(err)))
      const truncated = raw.length > maxBytes
      const body = raw.subarray(0, Math.min(raw.length, maxBytes)).toString('utf8').trimEnd()
      parts.push(`<diff bytes="${Math.min(raw.length, maxBytes)}" limit="${maxBytes}" truncated="${truncated ? 'true' : 'false'}">`)
      parts.push(xmlText(body || '(empty diff)'))
      parts.push('</diff>')
      if (mode === 'both') {
        const stagedStat = await git(cwd, ['--no-optional-locks', 'diff', '--no-color', '--cached', '--stat', ...pathArgs(paths)]).then(s => s.trim()).catch(errText)
        parts.push('<staged_diff_stat>')
        parts.push(xmlText(stagedStat || '(no staged diff)'))
        parts.push('</staged_diff_stat>')
        const stagedRaw = await gitBuffer(cwd, ['--no-optional-locks', 'diff', '--no-color', '--cached', '--no-ext-diff', ...pathArgs(paths)], MAX_DIFF_BYTES + 1)
          .catch(err => Buffer.from(errText(err)))
        const stagedTruncated = stagedRaw.length > maxBytes
        const stagedBody = stagedRaw.subarray(0, Math.min(stagedRaw.length, maxBytes)).toString('utf8').trimEnd()
        parts.push(`<staged_diff bytes="${Math.min(stagedRaw.length, maxBytes)}" limit="${maxBytes}" truncated="${stagedTruncated ? 'true' : 'false'}">`)
        parts.push(xmlText(stagedBody || '(empty staged diff)'))
        parts.push('</staged_diff>')
      }
      if (mode !== 'staged' && semanticBoolean(input?.include_untracked, true)) {
        const untracked = await readUntrackedFiles(cwd, paths, ctx, clampUntrackedBytes(input?.max_untracked_bytes))
        parts.push(formatUntrackedFiles(untracked))
      }
    }
    parts.push('</git_status>')
    return parts.join('\n')
  },
}

interface GitStatusSummary {
  files: number
  staged: number
  worktree: number
  untracked: number
  modified: number
  added: number
  deleted: number
  renamed: number
  copied: number
  conflicted: number
}

function summarizePorcelainStatus(status: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    files: 0,
    staged: 0,
    worktree: 0,
    untracked: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    conflicted: 0,
  }
  for (const line of status.split(/\r?\n/)) {
    if (!line || line.startsWith('##')) continue
    const code = line.slice(0, 2)
    if (code === '!!') continue
    summary.files += 1
    if (code === '??') {
      summary.untracked += 1
      continue
    }
    if (isConflictedStatus(code)) {
      summary.conflicted += 1
      continue
    }
    const [indexStatus, worktreeStatus] = code
    if (indexStatus && indexStatus !== ' ') {
      summary.staged += 1
    }
    if (worktreeStatus && worktreeStatus !== ' ') {
      summary.worktree += 1
    }
    addStatusKinds(summary, [indexStatus, worktreeStatus])
  }
  return summary
}

function isConflictedStatus(code: string): boolean {
  return code === 'DD' || code === 'AU' || code === 'UD' || code === 'UA' || code === 'DU' || code === 'AA' || code === 'UU'
}

function addStatusKinds(summary: GitStatusSummary, statuses: Array<string | undefined>): void {
  const kinds = new Set(statuses.filter((status): status is string => !!status && status !== ' '))
  if (kinds.has('M')) summary.modified += 1
  if (kinds.has('A')) summary.added += 1
  if (kinds.has('D')) summary.deleted += 1
  if (kinds.has('R')) summary.renamed += 1
  if (kinds.has('C')) summary.copied += 1
}

function formatSummary(summary: GitStatusSummary): string {
  return `<summary files="${summary.files}" staged="${summary.staged}" worktree="${summary.worktree}" untracked="${summary.untracked}" modified="${summary.modified}" added="${summary.added}" deleted="${summary.deleted}" renamed="${summary.renamed}" copied="${summary.copied}" conflicted="${summary.conflicted}" clean="${summary.files === 0 ? 'true' : 'false'}" />`
}

function diffMode(value: unknown): DiffMode {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'both' || v === 'all') return 'both'
  }
  return semanticBoolean(value) ? 'staged' : 'worktree'
}

interface UntrackedFilePreview {
  path: string
  size: number
  bytes: number
  truncated: boolean
  binary: boolean
  content: string
  error?: string
}

interface UntrackedFilesResult {
  files: UntrackedFilePreview[]
  bytes: number
  limit: number
  truncated: boolean
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileP('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 })
  return result.stdout
}

async function gitBuffer(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let collected = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 5000)
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    child.stdout.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (collected >= maxBuffer) return
      const take = Math.min(buf.length, maxBuffer - collected)
      if (take <= 0) return
      chunks.push(buf.subarray(0, take))
      collected += take
    })
    child.stderr.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stderrBytes >= 65_536) return
      const take = Math.min(buf.length, 65_536 - stderrBytes)
      if (take <= 0) return
      stderrChunks.push(buf.subarray(0, take))
      stderrBytes += take
    })
    child.on('error', error => settle(() => reject(error)))
    child.on('close', code => {
      settle(() => {
        if (timedOut) {
          reject(new Error('git command timed out'))
          return
        }
        if (code && code !== 0) {
          const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').trim()
          reject(new Error(stderr || `git exited with code ${code}`))
          return
        }
        resolve(Buffer.concat(chunks, collected))
      })
    })
  })
}

async function readUntrackedFiles(cwd: string, paths: string[], ctx: Parameters<typeof gitStatusTool.execute>[1], limit: number): Promise<UntrackedFilesResult> {
  const out = await gitBuffer(cwd, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z', ...pathArgs(paths)], 1024 * 1024)
    .catch(() => Buffer.alloc(0))
  const names = out.toString('utf8').split('\0').map(s => s.trim()).filter(Boolean)
  const files: UntrackedFilePreview[] = []
  let bytes = 0
  let truncated = false
  for (const path of names) {
    if (bytes >= limit) {
      truncated = true
      break
    }
    const remaining = limit - bytes
    const preview = await readUntrackedPreview(ctx, path, remaining)
    files.push(preview)
    bytes += preview.bytes
    if (preview.truncated) truncated = true
  }
  return { files, bytes, limit, truncated }
}

async function readUntrackedPreview(ctx: Parameters<typeof gitStatusTool.execute>[1], path: string, maxBytes: number): Promise<UntrackedFilePreview> {
  try {
    const abs = ctx.workspace.resolve(path, 'read')
    const info = await stat(abs)
    if (!info.isFile()) {
      return { path, size: info.size, bytes: 0, truncated: false, binary: false, content: '', error: 'not_file' }
    }
    const bytes = Math.min(info.size, Math.max(0, maxBytes))
    const body = bytes > 0 ? await readFilePrefix(abs, bytes) : Buffer.alloc(0)
    const binary = body.includes(0)
    return {
      path,
      size: info.size,
      bytes,
      truncated: info.size > bytes,
      binary,
      content: binary ? '' : body.toString('utf8'),
    }
  } catch (error) {
    return { path, size: 0, bytes: 0, truncated: false, binary: false, content: '', error: errText(error) }
  }
}

async function readFilePrefix(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const result = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

function formatUntrackedFiles(result: UntrackedFilesResult): string {
  return [
    `<untracked_files count="${result.files.length}" bytes="${result.bytes}" limit="${result.limit}" truncated="${result.truncated ? 'true' : 'false'}">`,
    ...result.files.map(file => file.error
      ? `<file path="${xmlAttr(file.path)}" error="${xmlAttr(file.error)}" />`
      : [
          `<file path="${xmlAttr(file.path)}" size="${file.size}" bytes="${file.bytes}" truncated="${file.truncated ? 'true' : 'false'}" binary="${file.binary ? 'true' : 'false'}">`,
          file.binary ? '' : xmlText(file.content.trimEnd()),
          '</file>',
        ].join('\n')),
    '</untracked_files>',
  ].join('\n')
}

function pathArgs(paths: string[]): string[] {
  return paths.length ? ['--', ...paths] : []
}

function normalizePathspecs(paths: unknown, ctx: Parameters<typeof gitStatusTool.execute>[1]): string[] {
  const items = Array.isArray(paths) ? paths : typeof paths === 'string' ? [paths] : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item !== 'string' || !item.trim()) continue
    const abs = ctx.workspace.resolve(item.trim(), 'read')
    const rel = relative(ctx.workspace.root, abs).replaceAll('\\', '/')
    if (!rel || rel.startsWith('..') || rel.includes('\0') || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

function semanticBoolean(value: unknown, fallback = false): boolean {
  if (value === true) return true
  if (value === false) return false
  if (value == null) return fallback
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function clampBytes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_DIFF_BYTES
  return Math.max(1, Math.min(MAX_DIFF_BYTES, Math.floor(n)))
}

function clampUntrackedBytes(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_UNTRACKED_BYTES
  return Math.max(1, Math.min(MAX_UNTRACKED_BYTES, Math.floor(n)))
}

function errText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const maybe = error as { stderr?: unknown; message?: unknown }
  const stderr = Buffer.isBuffer(maybe.stderr) ? maybe.stderr.toString('utf8') : typeof maybe.stderr === 'string' ? maybe.stderr : ''
  const message = typeof maybe.message === 'string' ? maybe.message : ''
  return (stderr || message || String(error)).trim()
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
