import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { ApprovalClass } from '../permissions/types'
import { Workspace } from '../workspace/workspace'
import type { Tool, ToolContext } from './Tool'

const execFileP = promisify(execFile)
const MAX_WORKTREE_SLUG_LENGTH = 64
const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/

export interface WorktreeSession {
  originalRoot: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string
  originalHeadCommit: string
  conversationId?: string
}

export interface AgentWorktree {
  session: WorktreeSession
  cleanupIfClean(): Promise<AgentWorktreeCleanupResult>
}

export interface AgentWorktreeCleanupResult {
  kept: boolean
  worktreePath?: string
  worktreeBranch?: string
  changedFiles: number
  commits: number
}

interface EnterWorktreeInput {
  name?: string
}

interface ExitWorktreeInput {
  action: 'keep' | 'remove'
  discard_changes?: boolean | string
}

interface ChangeSummary {
  changedFiles: number
  commits: number
}

const worktreeSessions = new Map<string, WorktreeSession>()

export function getActiveWorktreeSession(conversationId: string | undefined): WorktreeSession | null {
  return conversationId ? worktreeSessions.get(conversationId) ?? null : null
}

export function activateWorktreeSessionForContext(ctx: ToolContext): WorktreeSession | null {
  const session = currentWorktreeSession(ctx)
  if (!session) return null
  if (ctx.workspace.root !== session.originalRoot && ctx.workspace.root !== session.worktreePath) return null
  ctx.worktreeSession = session
  if (ctx.workspace.root !== session.worktreePath) ctx.workspace = new Workspace(session.worktreePath)
  return session
}

export function workspaceForActiveWorktree(workspace: Workspace, conversationId: string | undefined): Workspace {
  const session = getActiveWorktreeSession(conversationId)
  if (!session) return workspace
  if (workspace.root !== session.originalRoot && workspace.root !== session.worktreePath) return workspace
  return workspace.root === session.worktreePath ? workspace : new Workspace(session.worktreePath)
}

export async function createIsolatedAgentWorktree(workspaceRoot: string, agentId: string, conversationId?: string): Promise<AgentWorktree> {
  const repoRoot = await findGitTopLevel(workspaceRoot)
  const slug = `agent-${safeAgentWorktreeSlug(agentId).slice(0, 32)}`
  validateWorktreeSlug(slug)
  const session = await createWorktreeForSession(repoRoot, slug, conversationId)
  return agentWorktreeFromSession(session)
}

export function agentWorktreeFromSession(session: WorktreeSession): AgentWorktree {
  return {
    session,
    async cleanupIfClean() {
      const summary = await countWorktreeChanges(session)
      if (summary.changedFiles === 0 && summary.commits === 0) {
        await removeWorktree(session)
        return { kept: false, changedFiles: 0, commits: 0 }
      }
      return {
        kept: true,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        changedFiles: summary.changedFiles,
        commits: summary.commits,
      }
    },
  }
}

export const enterWorktreeTool: Tool<EnterWorktreeInput> = {
  name: 'EnterWorktree',
  description:
    'Create an isolated git worktree for this session and switch subsequent tools into it. Use only when the user explicitly asks for a worktree.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Optional worktree name. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A generated name is used when omitted.',
      },
    },
  },
  isReadOnly: false,
  requiresApproval: true,
  approvalClass: 'file',
  approvalReasonFor(input) {
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : '(auto)'
    return {
      what: `创建并切入 git worktree:${name}`,
      why: '该工具会在当前仓库下创建 .claude/worktrees 工作区和对应 git 分支,并让后续工具在隔离目录内运行。',
      impact: '会新增本地 worktree 目录、git 分支和 git exclude 记录;不会自动推送远端。',
    }
  },
  fatalReasonFor(input) {
    const name = typeof input?.name === 'string' ? input.name : ''
    if (!name.trim()) return null
    try {
      validateWorktreeSlug(name.trim())
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  },
  async previewFor(input, ctx) {
    const repoRoot = await findGitTopLevel(ctx.workspace.root).catch(() => null)
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : generatedWorktreeName()
    const branch = worktreeBranchName(name)
    return [
      '<enter_worktree_preview>',
      `name: ${name}`,
      `repo_root: ${repoRoot ?? '(not a git repository)'}`,
      `worktree_path: ${repoRoot ? worktreePathFor(repoRoot, name) : '(unavailable)'}`,
      `branch: ${branch}`,
      '</enter_worktree_preview>',
    ].join('\n')
  },
  async execute(input, ctx) {
    if (currentWorktreeSession(ctx)) throw new Error('Already in an EnterWorktree session')
    const repoRoot = await findGitTopLevel(ctx.workspace.root)
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : generatedWorktreeName()
    validateWorktreeSlug(name)
    const session = await createWorktreeForSession(repoRoot, name, ctx.conversationId)
    rememberWorktreeSession(ctx, session)
    ctx.workspace = new Workspace(session.worktreePath)
    return [
      '<enter_worktree>',
      `worktree_path: ${session.worktreePath}`,
      `worktree_branch: ${session.worktreeBranch}`,
      `original_root: ${session.originalRoot}`,
      '</enter_worktree>',
      `Created worktree at ${session.worktreePath} on branch ${session.worktreeBranch}. The session is now working in the worktree. Use ExitWorktree with action "keep" or "remove" to leave it.`,
    ].join('\n')
  },
}

export const exitWorktreeTool: Tool<ExitWorktreeInput> = {
  name: 'ExitWorktree',
  description:
    'Exit a worktree session created by EnterWorktree and return to the original workspace. Use only when the user explicitly asks to leave the worktree.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
      },
      discard_changes: {
        type: ['boolean', 'string'],
        description:
          'Required true when action is "remove" and the worktree has uncommitted files or commits not present at creation time.',
      },
    },
    required: ['action'],
  },
  isReadOnly: false,
  requiresApproval: true,
  approvalClassFor(input): ApprovalClass {
    return input?.action === 'remove' ? 'destructive' : 'file'
  },
  forceConfirmFor(input) {
    return input?.action === 'remove'
  },
  approvalReasonFor(input, ctx) {
    const session = currentWorktreeSession(ctx)
    const action = input?.action === 'remove' ? 'remove' : 'keep'
    return {
      what: action === 'remove' ? '退出并删除当前 worktree' : '退出当前 worktree 并保留目录',
      why: session
        ? `当前 worktree: ${session.worktreePath}`
        : '当前会话没有可识别的 EnterWorktree 状态;工具会 no-op。',
      impact: action === 'remove'
        ? '可能删除 worktree 目录和本地分支;有未提交文件或新增 commit 时默认拒绝,必须显式 discard_changes。'
        : '会把后续工具工作区恢复到进入 worktree 前的目录,并保留 worktree 和分支。',
    }
  },
  async previewFor(input, ctx) {
    const session = currentWorktreeSession(ctx)
    const action = input?.action === 'remove' ? 'remove' : 'keep'
    const summary = session ? await countWorktreeChanges(session).catch(() => null) : null
    return [
      '<exit_worktree_preview>',
      `action: ${action}`,
      `active: ${session ? 'true' : 'false'}`,
      `worktree_path: ${session?.worktreePath ?? '(none)'}`,
      `original_root: ${session?.originalRoot ?? '(none)'}`,
      `changed_files: ${summary?.changedFiles ?? 'unknown'}`,
      `commits: ${summary?.commits ?? 'unknown'}`,
      `discard_changes: ${semanticBoolean(input?.discard_changes) ? 'true' : 'false'}`,
      '</exit_worktree_preview>',
    ].join('\n')
  },
  async execute(input, ctx) {
    const session = currentWorktreeSession(ctx)
    if (!session) {
      return 'No-op: there is no active EnterWorktree session to exit. No filesystem changes were made.'
    }
    const action = input?.action
    if (action !== 'keep' && action !== 'remove') throw new Error('ExitWorktree.action must be "keep" or "remove"')
    const summary = await countWorktreeChanges(session)
    if (action === 'remove' && !semanticBoolean(input.discard_changes) && (summary.changedFiles > 0 || summary.commits > 0)) {
      const parts: string[] = []
      if (summary.changedFiles > 0) parts.push(`${summary.changedFiles} uncommitted ${summary.changedFiles === 1 ? 'file' : 'files'}`)
      if (summary.commits > 0) parts.push(`${summary.commits} ${summary.commits === 1 ? 'commit' : 'commits'}`)
      throw new Error(`Worktree has ${parts.join(' and ')}. Confirm with the user, then re-invoke with discard_changes: true, or use action "keep".`)
    }

    if (action === 'keep') {
      forgetWorktreeSession(ctx)
      ctx.workspace = new Workspace(session.originalRoot)
      return [
        '<exit_worktree action="keep">',
        `worktree_path: ${session.worktreePath}`,
        `worktree_branch: ${session.worktreeBranch}`,
        `original_root: ${session.originalRoot}`,
        `changed_files: ${summary.changedFiles}`,
        `commits: ${summary.commits}`,
        '</exit_worktree>',
        `Exited worktree. Your work is preserved at ${session.worktreePath} on branch ${session.worktreeBranch}. Session is now back in ${session.originalRoot}.`,
      ].join('\n')
    }

    await removeWorktree(session)
    forgetWorktreeSession(ctx)
    ctx.workspace = new Workspace(session.originalRoot)
    return [
      '<exit_worktree action="remove">',
      `worktree_path: ${session.worktreePath}`,
      `worktree_branch: ${session.worktreeBranch}`,
      `original_root: ${session.originalRoot}`,
      `discarded_files: ${summary.changedFiles}`,
      `discarded_commits: ${summary.commits}`,
      '</exit_worktree>',
      `Exited and removed worktree at ${session.worktreePath}. Session is now back in ${session.originalRoot}.`,
    ].join('\n')
  },
}

export function validateWorktreeSlug(slug: string): void {
  if (slug.length > MAX_WORKTREE_SLUG_LENGTH) {
    throw new Error(`Invalid worktree name: must be ${MAX_WORKTREE_SLUG_LENGTH} characters or fewer`)
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') throw new Error(`Invalid worktree name "${slug}": must not contain "." or ".." path segments`)
    if (!VALID_WORKTREE_SLUG_SEGMENT.test(segment)) {
      throw new Error(`Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`)
    }
  }
}

export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ['worktree', 'list', '--porcelain'], 5000)
    return out
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).normalize('NFC'))
  } catch {
    return []
  }
}

function currentWorktreeSession(ctx: ToolContext): WorktreeSession | null {
  if (ctx.worktreeSession) return ctx.worktreeSession
  const key = ctx.conversationId
  return key ? worktreeSessions.get(key) ?? null : null
}

function rememberWorktreeSession(ctx: ToolContext, session: WorktreeSession): void {
  ctx.worktreeSession = session
  if (ctx.conversationId) worktreeSessions.set(ctx.conversationId, session)
}

function forgetWorktreeSession(ctx: ToolContext): void {
  if (ctx.conversationId) worktreeSessions.delete(ctx.conversationId)
  ctx.worktreeSession = undefined
}

function generatedWorktreeName(): string {
  return `session-${Date.now().toString(36)}`
}

function safeAgentWorktreeSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || generatedWorktreeName()
}

function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

function worktreePathFor(repoRoot: string, slug: string): string {
  return join(repoRoot, '.claude', 'worktrees', flattenSlug(slug))
}

async function createWorktreeForSession(repoRoot: string, slug: string, conversationId?: string): Promise<WorktreeSession> {
  const worktreePath = worktreePathFor(repoRoot, slug)
  const worktreeBranch = worktreeBranchName(slug)
  const originalHeadCommit = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()
  const existingHead = await git(worktreePath, ['rev-parse', 'HEAD']).then(out => out.trim()).catch(() => '')
  if (existingHead) {
    return {
      originalRoot: repoRoot,
      worktreePath,
      worktreeName: slug,
      worktreeBranch,
      originalHeadCommit: existingHead,
      conversationId,
    }
  }
  await ensureWorktreesDirExcluded(repoRoot)
  await mkdir(join(repoRoot, '.claude', 'worktrees'), { recursive: true })
  await git(repoRoot, ['worktree', 'add', '-B', worktreeBranch, worktreePath, originalHeadCommit], 30_000)
  return {
    originalRoot: repoRoot,
    worktreePath,
    worktreeName: slug,
    worktreeBranch,
    originalHeadCommit,
    conversationId,
  }
}

async function removeWorktree(session: WorktreeSession): Promise<void> {
  await git(session.originalRoot, ['worktree', 'remove', '--force', session.worktreePath], 30_000)
  await git(session.originalRoot, ['branch', '-D', session.worktreeBranch], 30_000).catch(() => '')
}

async function countWorktreeChanges(session: WorktreeSession): Promise<ChangeSummary> {
  const status = await git(session.worktreePath, ['status', '--porcelain'], 10_000)
  const changedFiles = status.split(/\r?\n/).filter(line => line.trim()).length
  const commitsText = await git(session.worktreePath, ['rev-list', '--count', `${session.originalHeadCommit}..HEAD`], 10_000)
  const commits = Number.parseInt(commitsText.trim(), 10) || 0
  return { changedFiles, commits }
}

async function ensureWorktreesDirExcluded(repoRoot: string): Promise<void> {
  const rawGitDir = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).trim()
  const gitDir = isAbsolute(rawGitDir) ? rawGitDir : join(repoRoot, rawGitDir)
  const excludePath = join(gitDir, 'info', 'exclude')
  const pattern = '.claude/worktrees/'
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    // Missing exclude file is normal.
  }
  const alreadyExcluded = existing
    .split(/\r?\n/)
    .map(line => line.trim())
    .some(line => line === pattern || line === `/${pattern}`)
  if (alreadyExcluded) return
  await mkdir(join(gitDir, 'info'), { recursive: true })
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
  await writeFile(excludePath, `${prefix}# Codex worktree sessions copied from CC-Haha behavior\n${pattern}\n`, 'utf8')
}

async function findGitTopLevel(cwd: string): Promise<string> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
  const info = await stat(root).catch(() => null)
  if (!info?.isDirectory()) throw new Error('Current workspace is not a valid git repository')
  return root
}

async function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  try {
    const result = await execFileP('git', args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
      },
    })
    return result.stdout
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed in ${relative(process.cwd(), cwd) || cwd}: ${errText(err)}`)
  }
}

function semanticBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return fallback
}

function errText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown }
    if (typeof e.stderr === 'string' && e.stderr.trim()) return e.stderr.trim()
    if (typeof e.message === 'string') return e.message
  }
  return String(err)
}
