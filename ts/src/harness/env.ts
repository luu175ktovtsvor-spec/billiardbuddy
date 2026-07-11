import { execFile } from 'node:child_process'
import { release, type as osType } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface EnvInfoOptions {
  workspaceRoot: string
  isGit: boolean
}

export interface WorkspaceGitStatus {
  isGit: boolean
  branch: string | null
  dirty: boolean
  changed: number
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
}

/** <env> 环境块。刻意不含模型名/知识截止行——白标 + 模型身份是 W6。 */
export function computeEnvInfo(opts: EnvInfoOptions): string {
  const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : 'unknown')
  return [
    'Here is useful information about the environment you are running in:',
    '<env>',
    `Working directory: ${opts.workspaceRoot}`,
    `Is directory a git repo: ${opts.isGit ? 'Yes' : 'No'}`,
    `Platform: ${process.platform}`,
    `Shell: ${shell}`,
    `OS Version: ${osType()} ${release()}`,
    // 当天日期(对齐 cc context.ts:186 Today's date):缺了它,模型对"最近/上周/到期"这类时间判断会错。
    // 用本地日期(店主所在时区),白标下不带知识截止,只给日期。
    `Today's date is ${todayLocalDate()}`,
    '</env>',
  ].join('\n')
}

/** 本地时区当天日期(YYYY-MM-DD),供 <env> 注入。 */
function todayLocalDate(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export async function getIsGit(cwd: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    return true
  } catch {
    return false
  }
}

export function parseGitStatusPorcelain(output: string): WorkspaceGitStatus {
  const lines = output.split(/\r?\n/).filter(Boolean)
  const first = lines[0]?.startsWith('## ') ? lines[0]!.slice(3).trim() : ''
  const branchPart = (first.match(/^No commits yet on (.+)$/)?.[1] ?? first
    .replace(/\s+\[.*\]$/, '')
    .split('...')[0]
    ?.trim()) || null
  const ahead = Number(first.match(/ahead\s+(\d+)/)?.[1] ?? 0)
  const behind = Number(first.match(/behind\s+(\d+)/)?.[1] ?? 0)
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of lines.slice(first ? 1 : 0)) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    if (x === '?' && y === '?') {
      untracked += 1
      continue
    }
    if (x !== ' ') staged += 1
    if (y !== ' ') unstaged += 1
  }
  const changed = staged + unstaged + untracked
  return {
    isGit: true,
    branch: branchPart,
    dirty: changed > 0,
    changed,
    staged,
    unstaged,
    untracked,
    ahead,
    behind,
  }
}

export async function getWorkspaceGitStatus(cwd: string): Promise<WorkspaceGitStatus> {
  const empty = {
    isGit: false,
    branch: null,
    dirty: false,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
  }
  if (!(await getIsGit(cwd))) return empty
  try {
    const result = await execFileP('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: 2000,
      maxBuffer: 128 * 1024,
    })
    return parseGitStatusPorcelain(result.stdout)
  } catch {
    return empty
  }
}

/** 对话开头的 git 快照(照 context.ts getGitStatus):分支 + status --short + 近 5 提交。 */
export async function getGitStatus(cwd: string): Promise<string | null> {
  if (!(await getIsGit(cwd))) return null
  try {
    const run = (args: string[]) =>
      execFileP('git', args, { cwd })
        .then(r => r.stdout.trim())
        .catch(() => '')
    const [branch, status, log] = await Promise.all([
      run(['--no-optional-locks', 'branch', '--show-current']),
      run(['--no-optional-locks', 'status', '--short']),
      run(['--no-optional-locks', 'log', '--oneline', '-n', '5']),
    ])
    return [
      'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
      `Current branch: ${branch}`,
      `Status:\n${status || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch {
    return null
  }
}
