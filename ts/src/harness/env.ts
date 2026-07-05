import { execFile } from 'node:child_process'
import { release, type as osType } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface EnvInfoOptions {
  workspaceRoot: string
  isGit: boolean
}

/** <env> 环境块(照 cc-haha computeEnvInfo)。刻意不含模型名/知识截止行——白标 + 模型身份是 W6。 */
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
    '</env>',
  ].join('\n')
}

export async function getIsGit(cwd: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    return true
  } catch {
    return false
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
