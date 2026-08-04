import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_SNAPSHOTS = 15
const MAX_UNTRACKED_FILE_BYTES = 8 * 1024 * 1024
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_WORKTREE_INCLUDE_BYTES = 64 * 1024
const MAX_WORKTREE_INCLUDE_FILES = 4_096
const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/
const REVISION = /^(?:HEAD|[0-9a-fA-F]{7,64}|[A-Za-z0-9][A-Za-z0-9._/-]{0,255})$/

export type AgentWorkspaceLocation = 'source' | 'worktree'

export type AgentWorktree = {
  id: string
  /** The original managed Thread. Additional forked Threads are listed below. */
  threadId: string
  /** Forks remain bound to this same managed workspace after an app restart. */
  threadIds?: string[]
  sourceTree: string
  worktreePath: string
  /** Persisted Electron host routing, never a second Codex Thread state store. */
  activeWorkspace?: AgentWorkspaceLocation
  baseCommit: string
  createdAt: number
  updatedAt: number
}

export type AgentWorktreeSnapshot = {
  id: string
  worktreeId: string
  sourceTree: string
  baseCommit: string
  createdAt: number
  stagedPatch: string
  workingPatch: string
  untrackedFiles: string[]
}

type Registry = { version: 1, worktrees: AgentWorktree[] }
type SnapshotManifest = Omit<AgentWorktreeSnapshot, 'stagedPatch' | 'workingPatch'>

function root(userDataPath: string): string {
  return path.join(userDataPath, 'agent-runtime', 'worktrees')
}

function registryPath(userDataPath: string): string {
  return path.join(root(userDataPath), 'registry.json')
}

function snapshotRoot(userDataPath: string): string {
  return path.join(root(userDataPath), 'snapshots')
}

function safeId(value: string, error: string): string {
  if (!THREAD_ID.test(value)) throw new Error(error)
  return value
}

function worktreeThreads(worktree: AgentWorktree): string[] {
  return [...new Set([worktree.threadId, ...(worktree.threadIds ?? [])])]
}

function ownsThread(worktree: AgentWorktree, threadId: string): boolean {
  return worktreeThreads(worktree).includes(threadId)
}

function activeWorkspace(worktree: AgentWorktree): AgentWorkspaceLocation {
  // Older registries did not persist live Thread routing. Re-open them at the
  // original checkout until the user explicitly activates the private tree;
  // this never guesses from a renderer-provided cwd.
  return worktree.activeWorkspace ?? 'source'
}

function normalizedWorktree(worktree: AgentWorktree): AgentWorktree {
  return {
    ...worktree,
    activeWorkspace: activeWorkspace(worktree),
    threadIds: worktreeThreads(worktree).filter(threadId => threadId !== worktree.threadId),
  }
}

function assertRevision(value: string): void {
  if (!REVISION.test(value) || value.includes('..') || value.startsWith('-')) {
    throw new Error('BILLIARDBUDDY_WORKTREE_REVISION_INVALID')
  }
}

function isWithin(candidate: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonicalDirectory(input: string, error: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4_096 || /[\u0000\r\n]/.test(input)) throw new Error(error)
  let resolved: string
  try { resolved = await fs.realpath(input) } catch { throw new Error(error) }
  const stat = await fs.stat(resolved).catch(() => undefined)
  if (!stat?.isDirectory()) throw new Error(error)
  return resolved
}

async function runGit(cwd: string, args: string[], error: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, '--literal-pathspecs', ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch {
    throw new Error(error)
  }
}

async function regularFileWithin(file: string, ancestor: string, error: string) {
  const details = await fs.lstat(file).catch(() => undefined)
  if (!details?.isFile() || details.isSymbolicLink()) throw new Error(error)
  const [resolved, resolvedAncestor] = await Promise.all([
    fs.realpath(file).catch(() => undefined),
    fs.realpath(ancestor).catch(() => undefined),
  ])
  if (!resolved || !resolvedAncestor || !isWithin(resolved, resolvedAncestor)) throw new Error(error)
  return details
}

async function safeNewDestination(rootDirectory: string, relative: string, error: string): Promise<string> {
  const rootPath = await fs.realpath(rootDirectory).catch(() => undefined)
  if (!rootPath) throw new Error(error)
  const segments = relative.split('/')
  let current = rootPath
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    let details = await fs.lstat(current).catch(candidate => {
      if ((candidate as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw candidate
    })
    if (!details) {
      await fs.mkdir(current, { mode: 0o700 })
      details = await fs.lstat(current)
    }
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(error)
  }
  const destination = path.join(rootPath, ...segments)
  const existing = await fs.lstat(destination).catch(candidate => {
    if ((candidate as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw candidate
  })
  if (existing) throw new Error(error)
  return destination
}

async function readRegistry(userDataPath: string): Promise<Registry> {
  const raw = await fs.readFile(registryPath(userDataPath), 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!raw) return { version: 1, worktrees: [] }
  try {
    const parsed = JSON.parse(raw) as Registry
    if (parsed.version !== 1 || !Array.isArray(parsed.worktrees) || !parsed.worktrees.every(validWorktree)) throw new Error()
    return parsed
  } catch {
    throw new Error('BILLIARDBUDDY_WORKTREE_REGISTRY_CORRUPT')
  }
}

function validWorktree(value: unknown): value is AgentWorktree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).every(key => ['id', 'threadId', 'threadIds', 'sourceTree', 'worktreePath', 'activeWorkspace', 'baseCommit', 'createdAt', 'updatedAt'].includes(key))
    && typeof item.id === 'string' && THREAD_ID.test(item.id)
    && typeof item.threadId === 'string' && THREAD_ID.test(item.threadId)
    && (item.threadIds === undefined || Array.isArray(item.threadIds)
      && item.threadIds.every(threadId => typeof threadId === 'string' && THREAD_ID.test(threadId))
      && !item.threadIds.includes(item.threadId)
      && new Set(item.threadIds).size === item.threadIds.length)
    && typeof item.sourceTree === 'string' && item.sourceTree.length > 0
    && typeof item.worktreePath === 'string' && item.worktreePath.length > 0
    && (item.activeWorkspace === undefined || item.activeWorkspace === 'source' || item.activeWorkspace === 'worktree')
    && typeof item.baseCommit === 'string' && /^[0-9a-f]{40}$/i.test(item.baseCommit)
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function relativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1_024 || /[\u0000\r\n]/.test(value)) throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_INVALID')
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_INVALID')
  }
  return normalized.replace(/^\.\//, '')
}

async function worktreeIncludeFile(sourceTree: string): Promise<string | undefined> {
  const file = path.join(sourceTree, '.worktreeinclude')
  const raw = await fs.readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (raw === undefined) return undefined
  if (Buffer.byteLength(raw) > MAX_WORKTREE_INCLUDE_BYTES || raw.includes('\u0000')) {
    throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_LIMIT')
  }
  const lines = raw.split(/\r?\n/)
  if (lines.length > 128) throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_LIMIT')
  return file
}

async function ignoredAgentOverrides(sourceTree: string): Promise<string[]> {
  const raw = await runGit(sourceTree, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ], 'BILLIARDBUDDY_WORKTREE_INCLUDE_INVALID')
  return raw.split('\0')
    .filter(Boolean)
    .map(relativePath)
    .filter(relative => path.posix.basename(relative) === 'AGENTS.override.md')
}

async function worktreeIncludeFiles(sourceTree: string): Promise<string[]> {
  const includeFile = await worktreeIncludeFile(sourceTree)
  const configured = includeFile === undefined
    ? []
    : (await runGit(sourceTree, [
        'ls-files', '--others', '--ignored', `--exclude-from=${includeFile}`, '-z',
      ], 'BILLIARDBUDDY_WORKTREE_INCLUDE_INVALID'))
      .split('\0')
      .filter(Boolean)
      .map(relativePath)
  const files = [...new Set([...configured, ...await ignoredAgentOverrides(sourceTree)])]
  if (files.length > MAX_WORKTREE_INCLUDE_FILES) throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_LIMIT')
  return files
}

async function copyInclude(sourceTree: string, worktreePath: string): Promise<void> {
  let total = 0
  for (const relative of await worktreeIncludeFiles(sourceTree)) {
    const source = path.join(sourceTree, relative)
    const stat = await regularFileWithin(source, sourceTree, 'BILLIARDBUDDY_WORKTREE_INCLUDE_SYMLINK')
    total += stat.size
    if (stat.size > MAX_UNTRACKED_FILE_BYTES || total > MAX_UNTRACKED_TOTAL_BYTES) {
      throw new Error('BILLIARDBUDDY_WORKTREE_INCLUDE_LIMIT')
    }
    const destination = await safeNewDestination(worktreePath, relative, 'BILLIARDBUDDY_WORKTREE_INCLUDE_INVALID')
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
  }
}

async function listUntracked(worktreePath: string): Promise<string[]> {
  const raw = await runGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED')
  return raw.split('\0').filter(Boolean).map(relativePath)
}

async function copyUntracked(worktreePath: string, target: string): Promise<string[]> {
  const copied: string[] = []
  let total = 0
  for (const relative of await listUntracked(worktreePath)) {
    const source = path.join(worktreePath, relative)
    const stat = await regularFileWithin(source, worktreePath, 'BILLIARDBUDDY_WORKTREE_SNAPSHOT_UNTRACKED_UNSUPPORTED')
    total += stat.size
    if (stat.size > MAX_UNTRACKED_FILE_BYTES || total > MAX_UNTRACKED_TOTAL_BYTES) {
      throw new Error('BILLIARDBUDDY_WORKTREE_SNAPSHOT_UNTRACKED_LIMIT')
    }
    const untrackedRoot = path.join(target, 'untracked')
    await fs.mkdir(untrackedRoot, { recursive: true, mode: 0o700 })
    const destination = await safeNewDestination(untrackedRoot, relative, 'BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT')
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
    copied.push(relative)
  }
  return copied
}

async function copySnapshotUntracked(snapshotPath: string, target: string, files: readonly string[]): Promise<void> {
  const untrackedRoot = path.join(snapshotPath, 'untracked')
  for (const item of files) {
    const relative = relativePath(item)
    const source = path.join(untrackedRoot, relative)
    await regularFileWithin(source, untrackedRoot, 'BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT')
    const destination = await safeNewDestination(target, relative, 'BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT')
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
  }
}

async function hashRegularFile(file: string): Promise<string> {
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_UNTRACKED_FILE_BYTES) {
    throw new Error('BILLIARDBUDDY_WORKTREE_STATE_INVALID')
  }
  return createHash('sha256').update(await fs.readFile(file)).digest('hex')
}

async function hasUserChanges(workspace: string): Promise<boolean> {
  return Boolean((await runGit(
    workspace,
    ['status', '--porcelain=v1', '-z'],
    'BILLIARDBUDDY_WORKTREE_GIT_FAILED',
  )).length)
}

async function workspaceMatchesSnapshot(
  workspace: string,
  snapshotPath: string,
  snapshot: AgentWorktreeSnapshot,
): Promise<boolean> {
  const [baseCommit, stagedPatch, workingPatch, untrackedFiles] = await Promise.all([
    runGit(workspace, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
    runGit(workspace, ['diff', '--binary', '--cached'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
    runGit(workspace, ['diff', '--binary'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
    listUntracked(workspace),
  ])
  const expected = [...snapshot.untrackedFiles].sort()
  const actual = [...untrackedFiles].sort()
  if (
    baseCommit.trim() !== snapshot.baseCommit
    || stagedPatch !== snapshot.stagedPatch
    || workingPatch !== snapshot.workingPatch
    || expected.length !== actual.length
    || expected.some((item, index) => item !== actual[index])
  ) return false
  for (const relative of expected) {
    const [snapshotHash, workspaceHash] = await Promise.all([
      hashRegularFile(path.join(snapshotPath, 'untracked', relative)),
      hashRegularFile(path.join(workspace, relative)),
    ])
    if (snapshotHash !== workspaceHash) return false
  }
  return true
}

async function clearUserChanges(workspace: string): Promise<void> {
  await runGit(
    workspace,
    ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'],
    'BILLIARDBUDDY_HANDOFF_SOURCE_CLEANUP_FAILED',
  )
  for (const relative of await listUntracked(workspace)) {
    const file = path.join(workspace, relative)
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat) continue
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error('BILLIARDBUDDY_HANDOFF_SOURCE_CLEANUP_FAILED')
    }
    await fs.rm(file, { recursive: stat.isDirectory(), force: false })
  }
  if (await hasUserChanges(workspace)) throw new Error('BILLIARDBUDDY_HANDOFF_SOURCE_CLEANUP_FAILED')
}

export class AgentWorkspaceHost {
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: { userDataPath: string, now?: () => number } ) {}

  private async serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }

  async list(): Promise<AgentWorktree[]> {
    const registry = await readRegistry(this.options.userDataPath)
    return registry.worktrees
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(item => structuredClone(normalizedWorktree(item)))
  }

  async forThread(threadId: string): Promise<AgentWorktree | undefined> {
    safeId(threadId, 'BILLIARDBUDDY_WORKTREE_THREAD_INVALID')
    const registry = await readRegistry(this.options.userDataPath)
    const worktree = registry.worktrees.find(item => ownsThread(item, threadId))
    if (!worktree) return undefined
    return await this.requireWorktree(worktree.id)
  }

  /** Return the only persisted workspace a managed Thread may resume into. */
  async activeWorkspacePath(threadId: string): Promise<string | undefined> {
    const worktree = await this.forThread(threadId)
    if (!worktree) return undefined
    return activeWorkspace(worktree) === 'source'
      ? await canonicalDirectory(worktree.sourceTree, 'BILLIARDBUDDY_WORKTREE_SOURCE_INVALID')
      : worktree.worktreePath
  }

  /** Record a host-side relocation after Rust has accepted the idle Thread move. */
  async setActiveWorkspace(worktreeId: string, location: AgentWorkspaceLocation): Promise<AgentWorktree> {
    if (location !== 'source' && location !== 'worktree') throw new Error('BILLIARDBUDDY_WORKTREE_LOCATION_INVALID')
    return await this.serializeMutation(async () => {
      const id = safeId(worktreeId, 'BILLIARDBUDDY_WORKTREE_ID_INVALID')
      const registry = await readRegistry(this.options.userDataPath)
      const worktree = registry.worktrees.find(item => item.id === id)
      if (!worktree) throw new Error('BILLIARDBUDDY_WORKTREE_NOT_FOUND')
      // Verify both paths before persisting a resume target. This is host
      // workspace metadata only; Rust remains the source of Thread state.
      await Promise.all([
        canonicalDirectory(worktree.sourceTree, 'BILLIARDBUDDY_WORKTREE_SOURCE_INVALID'),
        canonicalDirectory(worktree.worktreePath, 'BILLIARDBUDDY_WORKTREE_MISSING'),
      ])
      worktree.activeWorkspace = location
      worktree.updatedAt = this.options.now?.() ?? Date.now()
      await writePrivateJson(registryPath(this.options.userDataPath), registry)
      return structuredClone(normalizedWorktree(worktree))
    })
  }

  /** Bind a source-native fork to its parent managed checkout, never to renderer cwd. */
  async attachThread(worktreeId: string, threadId: string): Promise<AgentWorktree> {
    return await this.serializeMutation(async () => {
      const id = safeId(worktreeId, 'BILLIARDBUDDY_WORKTREE_ID_INVALID')
      const childId = safeId(threadId, 'BILLIARDBUDDY_WORKTREE_THREAD_INVALID')
      const registry = await readRegistry(this.options.userDataPath)
      const worktree = registry.worktrees.find(item => item.id === id)
      if (!worktree) throw new Error('BILLIARDBUDDY_WORKTREE_NOT_FOUND')
      const existing = registry.worktrees.find(item => ownsThread(item, childId))
      if (existing && existing.id !== id) throw new Error('BILLIARDBUDDY_WORKTREE_THREAD_EXISTS')
      if (!ownsThread(worktree, childId)) {
        const aliases = worktree.threadIds ?? []
        worktree.threadIds = [...aliases, childId]
        worktree.updatedAt = this.options.now?.() ?? Date.now()
        await writePrivateJson(registryPath(this.options.userDataPath), registry)
      }
      return structuredClone(normalizedWorktree(worktree))
    })
  }

  /** Remove a non-primary fork binding after its source-native Thread is deleted. */
  async detachThread(threadId: string): Promise<void> {
    await this.serializeMutation(async () => {
      const id = safeId(threadId, 'BILLIARDBUDDY_WORKTREE_THREAD_INVALID')
      const registry = await readRegistry(this.options.userDataPath)
      const worktree = registry.worktrees.find(item => (item.threadIds ?? []).includes(id))
      if (!worktree) return
      worktree.threadIds = (worktree.threadIds ?? []).filter(candidate => candidate !== id)
      worktree.updatedAt = this.options.now?.() ?? Date.now()
      await writePrivateJson(registryPath(this.options.userDataPath), registry)
    })
  }

  async forWorkspace(workspacePath: string): Promise<AgentWorktree | undefined> {
    const workspace = await canonicalDirectory(workspacePath, 'BILLIARDBUDDY_WORKTREE_PATH_INVALID')
    for (const worktree of (await readRegistry(this.options.userDataPath)).worktrees) {
      const current = await fs.realpath(worktree.worktreePath).catch(() => undefined)
      if (current === workspace) return await this.requireWorktree(worktree.id)
    }
    return undefined
  }

  async create(input: { threadId: string, sourceTree: string, revision?: string, includeSourceChanges?: boolean }): Promise<AgentWorktree> {
    return await this.serializeMutation(async () => await this.createUnlocked(input))
  }

  private async createUnlocked(input: { threadId: string, sourceTree: string, revision?: string, includeSourceChanges?: boolean }): Promise<AgentWorktree> {
    const threadId = safeId(input.threadId, 'BILLIARDBUDDY_WORKTREE_THREAD_INVALID')
    const sourceTree = await canonicalDirectory(input.sourceTree, 'BILLIARDBUDDY_WORKTREE_SOURCE_INVALID')
    const requestedRevision = input.revision ?? 'HEAD'
    assertRevision(requestedRevision)
    const gitTopLevel = await runGit(sourceTree, ['rev-parse', '--show-toplevel'], 'BILLIARDBUDDY_WORKTREE_SOURCE_NOT_GIT')
    if ((await fs.realpath(gitTopLevel.trim())) !== sourceTree) throw new Error('BILLIARDBUDDY_WORKTREE_SOURCE_NOT_ROOT')
    const baseCommit = (await runGit(sourceTree, ['rev-parse', '--verify', `${requestedRevision}^{commit}`], 'BILLIARDBUDDY_WORKTREE_REVISION_UNKNOWN')).trim()
    const sourceHead = (await runGit(sourceTree, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED')).trim()
    const sourceHasChanges = input.includeSourceChanges !== false && await hasUserChanges(sourceTree)
    if (sourceHasChanges && sourceHead !== baseCommit) {
      throw new Error('BILLIARDBUDDY_WORKTREE_SOURCE_CHANGES_BASE_MISMATCH')
    }
    const registry = await readRegistry(this.options.userDataPath)
    if (registry.worktrees.some(item => ownsThread(item, threadId))) throw new Error('BILLIARDBUDDY_WORKTREE_THREAD_EXISTS')
    const id = randomUUID().replaceAll('-', '')
    const directory = root(this.options.userDataPath)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const worktreePath = path.join(directory, id)
    try {
      await runGit(sourceTree, ['worktree', 'add', '--detach', worktreePath, baseCommit], 'BILLIARDBUDDY_WORKTREE_CREATE_FAILED')
      await copyInclude(sourceTree, worktreePath)
      if (sourceHasChanges) {
        const initialPath = path.join(snapshotRoot(this.options.userDataPath), `initial-${id}`)
        await fs.mkdir(initialPath, { recursive: true, mode: 0o700 })
        try {
          const initial = await this.captureWorkspace(id, sourceTree, sourceTree, initialPath)
          await this.applySnapshot(initialPath, initial, worktreePath)
        } finally {
          await fs.rm(initialPath, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      const now = this.options.now?.() ?? Date.now()
      const record: AgentWorktree = {
        id,
        threadId,
        threadIds: [],
        sourceTree,
        worktreePath: await fs.realpath(worktreePath),
        // If creation fails before Main relocates the live Thread, recovery
        // must remain at its original source checkout rather than trust UI cwd.
        activeWorkspace: 'source',
        baseCommit,
        createdAt: now,
        updatedAt: now,
      }
      registry.worktrees.push(record)
      await writePrivateJson(registryPath(this.options.userDataPath), registry)
      return structuredClone(record)
    } catch (error) {
      await runGit(sourceTree, ['worktree', 'remove', '--force', worktreePath], 'BILLIARDBUDDY_WORKTREE_CLEANUP_FAILED').catch(() => undefined)
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async snapshot(worktreeId: string): Promise<AgentWorktreeSnapshot> {
    return await this.serializeMutation(async () => await this.snapshotUnlocked(worktreeId))
  }

  private async snapshotUnlocked(worktreeId: string): Promise<AgentWorktreeSnapshot> {
    const worktree = await this.requireWorktree(worktreeId)
    const snapshotId = randomUUID().replaceAll('-', '')
    const directory = path.join(snapshotRoot(this.options.userDataPath), snapshotId)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const snapshot = await this.captureWorkspace(worktree.id, worktree.sourceTree, worktree.worktreePath, directory, snapshotId)
      await this.pruneSnapshots()
      return structuredClone(snapshot)
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async restore(input: { snapshotId: string, threadId: string }): Promise<AgentWorktree> {
    return await this.serializeMutation(async () => await this.restoreUnlocked(input))
  }

  /** Read the source checkout a snapshot will restore into before mutation. */
  async snapshotSourceTree(snapshotId: string): Promise<string> {
    const snapshot = await this.readSnapshot(snapshotId)
    return await canonicalDirectory(snapshot.sourceTree, 'BILLIARDBUDDY_WORKTREE_SOURCE_INVALID')
  }

  private async restoreUnlocked(input: { snapshotId: string, threadId: string }): Promise<AgentWorktree> {
    const snapshotId = safeId(input.snapshotId, 'BILLIARDBUDDY_WORKTREE_SNAPSHOT_INVALID')
    const threadId = safeId(input.threadId, 'BILLIARDBUDDY_WORKTREE_THREAD_INVALID')
    const snapshot = await this.readSnapshot(snapshotId)
    // Recovery must reproduce the persisted snapshot exactly. Current Local
    // checkout changes are independent state and must not be layered into it.
    const record = await this.createUnlocked({
      threadId,
      sourceTree: snapshot.sourceTree,
      revision: snapshot.baseCommit,
      includeSourceChanges: false,
    })
    const snapshotPath = path.join(snapshotRoot(this.options.userDataPath), snapshot.id)
    try {
      await this.applySnapshot(snapshotPath, snapshot, record.worktreePath)
      await this.touch(record.id)
      return (await this.requireWorktree(record.id))
    } catch (error) {
      await this.cleanupUnlocked(record.id).catch(() => undefined)
      throw error
    }
  }

  async cleanup(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot }> {
    return await this.serializeMutation(async () => await this.cleanupUnlocked(worktreeId))
  }

  private async cleanupUnlocked(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot }> {
    const worktree = await this.requireWorktree(worktreeId)
    const snapshot = await this.snapshotUnlocked(worktree.id)
    await runGit(worktree.sourceTree, ['worktree', 'remove', '--force', worktree.worktreePath], 'BILLIARDBUDDY_WORKTREE_CLEANUP_FAILED')
    await fs.rm(worktree.worktreePath, { recursive: true, force: true }).catch(() => undefined)
    const registry = await readRegistry(this.options.userDataPath)
    registry.worktrees = registry.worktrees.filter(item => item.id !== worktree.id)
    await writePrivateJson(registryPath(this.options.userDataPath), registry)
    return { snapshot }
  }

  /** Move one managed worktree's recoverable state into another safe target. */
  async handoff(input: { sourceWorktreeId: string, targetWorktreeId: string }): Promise<{ snapshot: AgentWorktreeSnapshot }> {
    return await this.serializeMutation(async () => await this.handoffUnlocked(input))
  }

  private async handoffUnlocked(input: { sourceWorktreeId: string, targetWorktreeId: string }): Promise<{ snapshot: AgentWorktreeSnapshot }> {
    const source = await this.requireWorktree(input.sourceWorktreeId)
    const target = await this.requireWorktree(input.targetWorktreeId)
    if (source.id === target.id || source.sourceTree !== target.sourceTree) throw new Error('BILLIARDBUDDY_HANDOFF_TARGET_INVALID')
    const snapshot = await this.transfer(source, source.worktreePath, target.worktreePath)
    await this.touch(source.id)
    await this.touch(target.id)
    return { snapshot }
  }

  /** Move code from a managed worktree back to its clean source checkout. */
  async handoffToSource(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot, workspacePath: string }> {
    return await this.serializeMutation(async () => await this.handoffToSourceUnlocked(worktreeId))
  }

  private async handoffToSourceUnlocked(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot, workspacePath: string }> {
    const worktree = await this.requireWorktree(worktreeId)
    const snapshot = await this.transfer(worktree, worktree.worktreePath, worktree.sourceTree)
    await this.touch(worktree.id)
    return { snapshot, workspacePath: worktree.sourceTree }
  }

  /** Move code from the source checkout into its existing managed worktree. */
  async handoffFromSource(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot, workspacePath: string }> {
    return await this.serializeMutation(async () => await this.handoffFromSourceUnlocked(worktreeId))
  }

  private async handoffFromSourceUnlocked(worktreeId: string): Promise<{ snapshot: AgentWorktreeSnapshot, workspacePath: string }> {
    const worktree = await this.requireWorktree(worktreeId)
    const snapshot = await this.transfer(worktree, worktree.sourceTree, worktree.worktreePath)
    await this.touch(worktree.id)
    return { snapshot, workspacePath: worktree.worktreePath }
  }

  private async captureWorkspace(
    worktreeId: string,
    sourceTree: string,
    workspacePath: string,
    directory: string,
    snapshotId = randomUUID().replaceAll('-', ''),
  ): Promise<AgentWorktreeSnapshot> {
    const [baseCommit, stagedPatch, workingPatch] = await Promise.all([
      runGit(workspacePath, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
      runGit(workspacePath, ['diff', '--binary', '--cached'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
      runGit(workspacePath, ['diff', '--binary'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED'),
    ])
    const untrackedFiles = await copyUntracked(workspacePath, directory)
    const snapshot: AgentWorktreeSnapshot = {
      id: snapshotId,
      worktreeId,
      sourceTree,
      baseCommit: baseCommit.trim(),
      createdAt: this.options.now?.() ?? Date.now(),
      stagedPatch,
      workingPatch,
      untrackedFiles,
    }
    await Promise.all([
      fs.writeFile(path.join(directory, 'staged.patch'), stagedPatch, { mode: 0o600 }),
      fs.writeFile(path.join(directory, 'working.patch'), workingPatch, { mode: 0o600 }),
      writePrivateJson(path.join(directory, 'manifest.json'), {
        id: snapshot.id, worktreeId: snapshot.worktreeId, sourceTree: snapshot.sourceTree,
        baseCommit: snapshot.baseCommit, createdAt: snapshot.createdAt, untrackedFiles: snapshot.untrackedFiles,
      } satisfies SnapshotManifest),
    ])
    return snapshot
  }

  private async transfer(
    worktree: AgentWorktree,
    sourcePath: string,
    targetPath: string,
  ): Promise<AgentWorktreeSnapshot> {
    const source = await canonicalDirectory(sourcePath, 'BILLIARDBUDDY_HANDOFF_SOURCE_INVALID')
    const target = await canonicalDirectory(targetPath, 'BILLIARDBUDDY_HANDOFF_TARGET_INVALID')
    const snapshotId = randomUUID().replaceAll('-', '')
    const directory = path.join(snapshotRoot(this.options.userDataPath), snapshotId)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const snapshot = await this.captureWorkspace(worktree.id, worktree.sourceTree, source, directory, snapshotId)
      const targetHead = (await runGit(target, ['rev-parse', 'HEAD'], 'BILLIARDBUDDY_WORKTREE_GIT_FAILED')).trim()
      if (targetHead !== snapshot.baseCommit) throw new Error('BILLIARDBUDDY_HANDOFF_BASE_MISMATCH')
      if (await hasUserChanges(target)) {
        if (!await workspaceMatchesSnapshot(target, directory, snapshot)) {
          throw new Error('BILLIARDBUDDY_HANDOFF_TARGET_DIRTY')
        }
      } else {
        await this.applySnapshot(directory, snapshot, target)
      }
      await clearUserChanges(source)
      await this.pruneSnapshots()
      return snapshot
    } catch (error) {
      // Keep the persisted snapshot whenever capture succeeded. It is the
      // recovery boundary if apply/cleanup failed after partially moving code.
      throw error
    }
  }

  private async requireWorktree(id: string): Promise<AgentWorktree> {
    safeId(id, 'BILLIARDBUDDY_WORKTREE_ID_INVALID')
    const registry = await readRegistry(this.options.userDataPath)
    const worktree = registry.worktrees.find(item => item.id === id)
    if (!worktree) throw new Error('BILLIARDBUDDY_WORKTREE_NOT_FOUND')
    const parent = await canonicalDirectory(root(this.options.userDataPath), 'BILLIARDBUDDY_WORKTREE_ROOT_INVALID')
    const current = await canonicalDirectory(worktree.worktreePath, 'BILLIARDBUDDY_WORKTREE_MISSING')
    if (!isWithin(current, parent) || current === parent) throw new Error('BILLIARDBUDDY_WORKTREE_PATH_INVALID')
    return normalizedWorktree({ ...worktree, worktreePath: current })
  }

  private async touch(id: string): Promise<void> {
    const registry = await readRegistry(this.options.userDataPath)
    const item = registry.worktrees.find(worktree => worktree.id === id)
    if (!item) return
    item.updatedAt = this.options.now?.() ?? Date.now()
    await writePrivateJson(registryPath(this.options.userDataPath), registry)
  }

  private async readSnapshot(id: string): Promise<AgentWorktreeSnapshot> {
    const directory = path.join(snapshotRoot(this.options.userDataPath), id)
    const [raw, stagedPatch, workingPatch] = await Promise.all([
      fs.readFile(path.join(directory, 'manifest.json'), 'utf8').catch(() => { throw new Error('BILLIARDBUDDY_WORKTREE_SNAPSHOT_NOT_FOUND') }),
      fs.readFile(path.join(directory, 'staged.patch'), 'utf8').catch(() => { throw new Error('BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT') }),
      fs.readFile(path.join(directory, 'working.patch'), 'utf8').catch(() => { throw new Error('BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT') }),
    ])
    try {
      const manifest = JSON.parse(raw) as SnapshotManifest
      if (
        !manifest || typeof manifest !== 'object' || manifest.id !== id || !THREAD_ID.test(manifest.worktreeId)
        || typeof manifest.sourceTree !== 'string' || !/^[0-9a-f]{40}$/i.test(manifest.baseCommit)
        || typeof manifest.createdAt !== 'number' || !Array.isArray(manifest.untrackedFiles)
        || !manifest.untrackedFiles.every(item => typeof item === 'string')
      ) throw new Error()
      return { ...manifest, stagedPatch, workingPatch } as AgentWorktreeSnapshot
    } catch {
      throw new Error('BILLIARDBUDDY_WORKTREE_SNAPSHOT_CORRUPT')
    }
  }

  private async applySnapshot(directory: string, snapshot: AgentWorktreeSnapshot, target: string): Promise<void> {
    const stagedFile = path.join(directory, 'staged.patch')
    const workingFile = path.join(directory, 'working.patch')
    if (snapshot.stagedPatch) await runGit(target, ['apply', '--index', '--whitespace=nowarn', stagedFile], 'BILLIARDBUDDY_HANDOFF_APPLY_FAILED')
    if (snapshot.workingPatch) await runGit(target, ['apply', '--whitespace=nowarn', workingFile], 'BILLIARDBUDDY_HANDOFF_APPLY_FAILED')
    await copySnapshotUntracked(directory, target, snapshot.untrackedFiles)
  }

  private async pruneSnapshots(): Promise<void> {
    const directory = snapshotRoot(this.options.userDataPath)
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as Dirent[]
      throw error
    })
    const snapshots: { name: string, createdAt: number }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !THREAD_ID.test(entry.name)) continue
      const raw = await fs.readFile(path.join(directory, entry.name, 'manifest.json'), 'utf8').catch(() => undefined)
      if (!raw) continue
      try {
        const manifest = JSON.parse(raw) as SnapshotManifest
        if (typeof manifest.createdAt === 'number' && Number.isFinite(manifest.createdAt)) snapshots.push({ name: entry.name, createdAt: manifest.createdAt })
      } catch { /* malformed directories are not trusted for automatic deletion */ }
    }
    snapshots.sort((a, b) => b.createdAt - a.createdAt)
    await Promise.all(snapshots.slice(MAX_SNAPSHOTS).map(snapshot => fs.rm(path.join(directory, snapshot.name), { recursive: true, force: true })))
  }

}
