import type { Workspace } from '../workspace/workspace'
import { computeEnvInfo, getGitStatus, getIsGit } from './env'
import { ACTIONS_SECTION, buildAntiReveal, CODING_WORKFLOW_SECTION, DENIAL_RULE, TOOL_DISCOVERY_SECTION, VERIFICATION_SECTION } from './prompts'
import { loadWorkspaceProjectInstructions } from './projectInstructions'

const BASE_IDENTITY = '你是一个装在用户电脑上的本机 AI 助手,能读写文件、跑命令,实打实把活干完。'

/** 系统提示装配:白标身份(anti-reveal)+ 基座 + 谨慎执行动作 + 拒绝处理 + <env> + git 快照。 */
export async function buildSystemPrompt(workspace: Workspace): Promise<string> {
  const isGit = await getIsGit(workspace.root)
  const env = computeEnvInfo({ workspaceRoot: workspace.root, isGit })
  const [gitStatus, projectInstructions] = await Promise.all([
    getGitStatus(workspace.root),
    loadWorkspaceProjectInstructions(workspace),
  ])
  return [
    buildAntiReveal(),
    BASE_IDENTITY,
    ACTIONS_SECTION,
    CODING_WORKFLOW_SECTION,
    VERIFICATION_SECTION,
    TOOL_DISCOVERY_SECTION,
    DENIAL_RULE,
    ...(projectInstructions ? [projectInstructions] : []),
    env,
    ...(gitStatus ? [gitStatus] : []),
  ].join('\n\n')
}
