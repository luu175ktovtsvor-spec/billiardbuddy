import { execFile, spawn } from 'node:child_process'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import type { Tool } from './Tool'

const execFileP = promisify(execFile)
const DEFAULT_MAX_COUNT = 12
const MAX_COUNT = 50
const DEFAULT_MAX_PATCH_BYTES = 80_000
const MAX_PATCH_BYTES = 400_000
const LOG_SEP = '\x1f'
const RECORD_SEP = '\x1e'

export interface GitHistoryInput {
  rev?: string
  max_count?: number | string
  include_patch?: boolean | string
  max_patch_bytes?: number | string
  paths?: string[]
}

interface CommitInfo {
  sha: string
  shortSha: string
  author: string
  date: string
  title: string
}

export const gitHistoryTool: Tool<GitHistoryInput> = {
  name: 'git_history',
  description:
    'Read recent git commit history and optionally a bounded commit patch. Input: { rev?, max_count?, include_patch?, max_patch_bytes?, paths? }. Use this for regression/history analysis without arbitrary shell commands.',
  inputSchema: {
    type: 'object',
    properties: {
      rev: { type: 'string', description: 'Optional commit/branch/tag/range. Defaults to HEAD. Must not start with - or contain whitespace.' },
      max_count: { type: ['number', 'string'], description: `Number of commits to list, default ${DEFAULT_MAX_COUNT}, max ${MAX_COUNT}.` },
      include_patch: { type: ['boolean', 'string'], description: 'Set true to include a bounded git show patch for rev.' },
      max_patch_bytes: { type: ['number', 'string'], description: `Patch byte cap, default ${DEFAULT_MAX_PATCH_BYTES}, max ${MAX_PATCH_BYTES}.` },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional workspace-relative paths to limit log/patch.' },
    },
  },
  isReadOnly: true,
  async execute(input, ctx) {
    const cwd = ctx.workspace.root
    if (!(await isGitRepo(cwd))) return '<git_history is_git="false">\n当前工作区不是 git 仓库。\n</git_history>'
    const rev = normalizeRev(input?.rev)
    if (!rev) {
      return `<git_history is_git="true" status="invalid_rev" rev="${xmlAttr(String(input?.rev ?? ''))}">\nrev 只能是提交/分支/tag/range,不能以 - 开头,也不能包含空白或冒号。\n</git_history>`
    }

    const maxCount = clampNumber(input?.max_count, DEFAULT_MAX_COUNT, MAX_COUNT)
    const paths = normalizePathspecs(input?.paths, ctx)
    const includePatch = semanticBoolean(input?.include_patch)
    let commits: CommitInfo[]
    try {
      commits = await readCommits(cwd, rev, maxCount, paths)
    } catch (error) {
      return `<git_history is_git="true" status="error" rev="${xmlAttr(rev)}">\n${xmlText(errText(error))}\n</git_history>`
    }
    const parts = [
      `<git_history is_git="true" status="completed" rev="${xmlAttr(rev)}" count="${commits.length}" patch="${includePatch ? 'true' : 'false'}">`,
      '<commits>',
      ...commits.map(formatCommit),
      '</commits>',
    ]

    if (includePatch) {
      const maxBytes = clampNumber(input?.max_patch_bytes, DEFAULT_MAX_PATCH_BYTES, MAX_PATCH_BYTES)
      const patch = await gitBufferLimited(cwd, ['--no-optional-locks', 'show', '--no-ext-diff', '--format=fuller', '--stat', '--patch', rev, ...pathArgs(paths)], maxBytes)
      const body = patch.stdout.toString('utf8').trimEnd() || patch.stderr.trim() || '(empty patch)'
      parts.push(`<patch bytes="${Buffer.byteLength(body, 'utf8')}" limit="${maxBytes}" truncated="${patch.truncated ? 'true' : 'false'}" exit_code="${patch.exitCode}">`)
      parts.push(xmlText(body))
      parts.push('</patch>')
    }

    parts.push('</git_history>')
    return parts.join('\n')
  },
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

async function readCommits(cwd: string, rev: string, maxCount: number, paths: string[]): Promise<CommitInfo[]> {
  const format = `%H${LOG_SEP}%h${LOG_SEP}%an${LOG_SEP}%ad${LOG_SEP}%s${RECORD_SEP}`
  const out = await git(cwd, ['--no-optional-locks', 'log', rev, '-n', String(maxCount), '--date=iso-strict', `--format=${format}`, ...pathArgs(paths)])
  return out.split(RECORD_SEP)
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [sha = '', shortSha = '', author = '', date = '', ...titleParts] = record.split(LOG_SEP)
      return { sha, shortSha, author, date, title: titleParts.join(LOG_SEP).trim() }
    })
    .filter(commit => commit.sha)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileP('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 })
  return result.stdout
}

function gitBufferLimited(cwd: string, args: string[], maxBytes: number): Promise<{ stdout: Buffer; stderr: string; truncated: boolean; exitCode: number }> {
  const child = spawn('git', args, { cwd })
  const chunks: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let stderrBytes = 0
  let truncated = false
  let settled = false
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      truncated = true
      child.kill('SIGKILL')
    }, 5000)
    child.stdout.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes >= maxBytes) {
        truncated = true
        child.kill('SIGKILL')
        return
      }
      const allowed = maxBytes - bytes
      if (buf.length > allowed) {
        chunks.push(buf.subarray(0, allowed))
        bytes += allowed
        truncated = true
        child.kill('SIGKILL')
        return
      }
      chunks.push(buf)
      bytes += buf.length
    })
    child.stderr.on('data', chunk => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const allowed = Math.max(0, 32_000 - stderrBytes)
      if (allowed <= 0) return
      stderr.push(buf.subarray(0, allowed))
      stderrBytes += Math.min(buf.length, allowed)
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks), stderr: errText(error), truncated, exitCode: -1 })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(chunks),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        exitCode: code ?? (truncated ? 137 : -1),
      })
    })
  })
}

function formatCommit(commit: CommitInfo): string {
  return [
    `<commit sha="${xmlAttr(commit.sha)}" short_sha="${xmlAttr(commit.shortSha)}" author="${xmlAttr(commit.author)}" date="${xmlAttr(commit.date)}">`,
    '<title>',
    xmlText(commit.title),
    '</title>',
    '</commit>',
  ].join('\n')
}

function normalizeRev(value: unknown): string | null {
  const rev = typeof value === 'string' && value.trim() ? value.trim() : 'HEAD'
  if (rev.length > 120 || rev.startsWith('-') || /[\s:\0\\]/.test(rev)) return null
  if (!/^[A-Za-z0-9_./@{}^~+\-!]+$/.test(rev)) return null
  return rev
}

function pathArgs(paths: string[]): string[] {
  return paths.length ? ['--', ...paths] : []
}

function normalizePathspecs(paths: unknown, ctx: Parameters<typeof gitHistoryTool.execute>[1]): string[] {
  if (!Array.isArray(paths)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of paths) {
    if (typeof item !== 'string' || !item.trim()) continue
    const abs = ctx.workspace.resolve(item.trim(), 'read')
    const rel = relative(ctx.workspace.root, abs).replaceAll('\\', '/')
    if (!rel || rel.startsWith('..') || rel.includes('\0') || seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return out
}

function semanticBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === false || value == null) return false
  if (typeof value !== 'string') return false
  const v = value.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'y'
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
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
