import type { Workspace } from '../workspace/workspace'
import { computeEnvInfo, getGitStatus, getIsGit } from './env'

// W2 占位基座身份。白标 anti-reveal + 完整人设(通用/台球)是 W4/W10;这里只保证不暴露模型。
const BASE_IDENTITY = '你是一个装在用户电脑上的本机 AI 助手,能读写文件、跑命令,实打实把活干完。'

/** 系统提示装配:基座身份 + <env> 环境块 + git 快照(有则附)。 */
export async function buildSystemPrompt(workspace: Workspace): Promise<string> {
  const isGit = await getIsGit(workspace.root)
  const env = computeEnvInfo({ workspaceRoot: workspace.root, isGit })
  const gitStatus = await getGitStatus(workspace.root)
  return [BASE_IDENTITY, env, ...(gitStatus ? [gitStatus] : [])].join('\n\n')
}
