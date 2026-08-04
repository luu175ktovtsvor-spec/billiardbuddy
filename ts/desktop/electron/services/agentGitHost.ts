import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_PATHS = 256
const MAX_PATCH_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type AgentGitStatusEntry = {
  path: string
  index: string
  worktree: string
}

export type AgentGitStatus = {
  branch: string | null
  head: string
  entries: AgentGitStatusEntry[]
}

export type AgentGitBranch = {
  name: string
  current: boolean
  commit: string
}

function isWithin(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonicalDirectory(value: string): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\u0000\r\n]/.test(value)) throw new Error('BILLIARDBUDDY_GIT_WORKSPACE_INVALID')
  try {
    const resolved = await fs.realpath(value)
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error()
    return resolved
  } catch { throw new Error('BILLIARDBUDDY_GIT_WORKSPACE_INVALID') }
}

function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || /[\u0000\r\n]/.test(value)) throw new Error('BILLIARDBUDDY_GIT_PATH_INVALID')
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('BILLIARDBUDDY_GIT_PATH_INVALID')
  }
  return normalized.replace(/^\.\//, '')
}

function branchName(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\u0000\r\n ~^:?*\\[\\]/.test(value) || value.startsWith('-') || value.includes('..') || value.endsWith('.') || value.endsWith('/')) {
    throw new Error('BILLIARDBUDDY_GIT_BRANCH_INVALID')
  }
  return value
}

function remoteName(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('BILLIARDBUDDY_GIT_REMOTE_INVALID')
  return value
}

function commitMessage(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_000 || value.includes('\u0000')) throw new Error('BILLIARDBUDDY_GIT_COMMIT_MESSAGE_INVALID')
  return value
}

async function runGit(cwd: string, args: string[], error: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, '--literal-pathspecs', ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return result.stdout
  } catch {
    throw new Error(error)
  }
}

async function workspaceRoot(value: string): Promise<string> {
  const candidate = await canonicalDirectory(value)
  const root = (await runGit(candidate, ['rev-parse', '--show-toplevel'], 'BILLIARDBUDDY_GIT_NOT_REPOSITORY')).trim()
  const canonical = await canonicalDirectory(root)
  if (!isWithin(candidate, canonical)) throw new Error('BILLIARDBUDDY_GIT_WORKSPACE_INVALID')
  return canonical
}

async function patchFile(directoryRoot: string, patch: string): Promise<{ directory: string, file: string }> {
  if (typeof patch !== 'string' || !patch || Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES || patch.includes('\u0000')) throw new Error('BILLIARDBUDDY_GIT_PATCH_INVALID')
  await fs.mkdir(directoryRoot, { recursive: true, mode: 0o700 })
  const directory = await fs.mkdtemp(path.join(directoryRoot, 'patch-'))
  const file = path.join(directory, `${randomUUID()}.patch`)
  await fs.writeFile(file, patch, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return { directory, file }
}

async function withPatch<T>(directoryRoot: string, patch: string, run: (file: string) => Promise<T>): Promise<T> {
  const temporary = await patchFile(directoryRoot, patch)
  try { return await run(temporary.file) } finally { await fs.rm(temporary.directory, { recursive: true, force: true }).catch(() => undefined) }
}

function parseStatus(raw: string): AgentGitStatusEntry[] {
  const entries: AgentGitStatusEntry[] = []
  const items = raw.split('\0')
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    if (item.length < 4) throw new Error('BILLIARDBUDDY_GIT_STATUS_INVALID')
    const code = item.slice(0, 2)
    let file = item.slice(3)
    // Rename/copy porcelain v1 has a second NUL-delimited source path. The destination is the first path.
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') index += 1
    file = relativePath(file)
    entries.push({ path: file, index: code[0]!, worktree: code[1]! })
  }
  return entries
}

export class AgentGitHost {
  constructor(private readonly options: { userDataPath: string }) {}

  /** Canonicalizes once; every public operation executes exactly at that Thread workspace root. */
  private async workspace(value: string): Promise<string> { return await workspaceRoot(value) }

  async root(worktreePath: string): Promise<string> { return await this.workspace(worktreePath) }

  async status(worktreePath: string): Promise<AgentGitStatus> {
    const workspace = await this.workspace(worktreePath)
    const [branch, head, porcelain] = await Promise.all([
      runGit(workspace, ['branch', '--show-current'], 'BILLIARDBUDDY_GIT_STATUS_FAILED'),
      runGit(workspace, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_GIT_STATUS_FAILED'),
      runGit(workspace, ['status', '--porcelain=v1', '-z'], 'BILLIARDBUDDY_GIT_STATUS_FAILED'),
    ])
    return { branch: branch.trim() || null, head: head.trim(), entries: parseStatus(porcelain) }
  }

  async diff(worktreePath: string, input: { staged?: boolean, paths?: string[] } = {}): Promise<string> {
    const workspace = await this.workspace(worktreePath)
    const paths = input.paths ? this.paths(input.paths) : []
    return await runGit(workspace, ['diff', '--binary', ...(input.staged ? ['--cached'] : []), '--', ...paths], 'BILLIARDBUDDY_GIT_DIFF_FAILED')
  }

  async stageFiles(worktreePath: string, paths: string[]): Promise<AgentGitStatus> {
    const workspace = await this.workspace(worktreePath)
    await runGit(workspace, ['add', '--', ...this.paths(paths)], 'BILLIARDBUDDY_GIT_STAGE_FAILED')
    return await this.status(workspace)
  }

  async revertFiles(worktreePath: string, paths: string[]): Promise<AgentGitStatus> {
    const workspace = await this.workspace(worktreePath)
    await runGit(workspace, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...this.paths(paths)], 'BILLIARDBUDDY_GIT_REVERT_FAILED')
    return await this.status(workspace)
  }

  async stagePatch(worktreePath: string, patch: string): Promise<AgentGitStatus> {
    const workspace = await this.workspace(worktreePath)
    await withPatch(this.patchRoot(), patch, async file => await runGit(workspace, ['apply', '--cached', '--whitespace=nowarn', file], 'BILLIARDBUDDY_GIT_STAGE_PATCH_FAILED'))
    return await this.status(workspace)
  }

  async revertPatch(worktreePath: string, patch: string): Promise<AgentGitStatus> {
    const workspace = await this.workspace(worktreePath)
    await withPatch(this.patchRoot(), patch, async file => await runGit(workspace, ['apply', '--reverse', '--index', '--whitespace=nowarn', file], 'BILLIARDBUDDY_GIT_REVERT_PATCH_FAILED'))
    return await this.status(workspace)
  }

  async commit(worktreePath: string, message: string): Promise<{ commit: string }> {
    const workspace = await this.workspace(worktreePath)
    await runGit(workspace, ['commit', '-m', commitMessage(message)], 'BILLIARDBUDDY_GIT_COMMIT_FAILED')
    return { commit: (await runGit(workspace, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_GIT_COMMIT_FAILED')).trim() }
  }

  async push(worktreePath: string, input: { remote?: string, branch: string }): Promise<void> {
    const workspace = await this.workspace(worktreePath)
    const remote = remoteName(input.remote ?? 'origin')
    const branch = branchName(input.branch)
    const remotes = (await runGit(workspace, ['remote'], 'BILLIARDBUDDY_GIT_PUSH_FAILED')).split(/\r?\n/).filter(Boolean)
    if (!remotes.includes(remote)) throw new Error('BILLIARDBUDDY_GIT_REMOTE_UNKNOWN')
    await runGit(workspace, ['push', remote, `HEAD:refs/heads/${branch}`], 'BILLIARDBUDDY_GIT_PUSH_FAILED')
  }

  async listBranches(worktreePath: string): Promise<AgentGitBranch[]> {
    const workspace = await this.workspace(worktreePath)
    const raw = await runGit(workspace, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(HEAD)', 'refs/heads'], 'BILLIARDBUDDY_GIT_BRANCH_FAILED')
    return raw.split(/\r?\n/).filter(Boolean).map(line => {
      const [name, commit, current, ...rest] = line.split('\t')
      if (!name || !commit || current === undefined || rest.length) throw new Error('BILLIARDBUDDY_GIT_BRANCH_FAILED')
      return { name: branchName(name), commit, current: current === '*' }
    })
  }

  async createBranch(worktreePath: string, name: string): Promise<void> {
    const workspace = await this.workspace(worktreePath)
    await this.requireClean(workspace)
    await runGit(workspace, ['switch', '-c', branchName(name)], 'BILLIARDBUDDY_GIT_BRANCH_CREATE_FAILED')
  }

  async switchBranch(worktreePath: string, name: string): Promise<void> {
    const workspace = await this.workspace(worktreePath)
    await this.requireClean(workspace)
    await runGit(workspace, ['switch', branchName(name)], 'BILLIARDBUDDY_GIT_BRANCH_SWITCH_FAILED')
  }

  private paths(value: string[]): string[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) throw new Error('BILLIARDBUDDY_GIT_PATH_LIMIT')
    return [...new Set(value.map(relativePath))]
  }

  private async requireClean(workspace: string): Promise<void> {
    if ((await runGit(workspace, ['status', '--porcelain=v1'], 'BILLIARDBUDDY_GIT_STATUS_FAILED')).trim()) throw new Error('BILLIARDBUDDY_GIT_WORKTREE_DIRTY')
  }

  private patchRoot(): string {
    return path.join(this.options.userDataPath, 'agent-runtime', 'git-patches')
  }
}
