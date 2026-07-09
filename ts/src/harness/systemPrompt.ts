import type { Workspace } from '../workspace/workspace'
import { loadMemoryInjection } from './claudemd'
import { computeEnvInfo, getGitStatus, getIsGit } from './env'
import { ACTIONS_SECTION, buildAntiReveal, CODING_WORKFLOW_SECTION, DENIAL_RULE, TOOL_DISCOVERY_SECTION, VERIFICATION_SECTION } from './prompts'
import { buildSkillCommandListingSection, type DiscoverySources } from './skillListing'

const BASE_IDENTITY = '你是一个装在用户电脑上的本机 AI 助手,能读写文件、跑命令,实打实把活干完。'

/**
 * 系统提示装配:白标身份(anti-reveal)+ 基座 + 谨慎执行动作 + 拒绝处理 + 分层记忆注入 + <env> + git 快照。
 *
 * 分层记忆注入对齐 cc(context.ts:172 getClaudeMds(getMemoryFiles())):不再只注入单层项目指令,而是
 * **四层全量**(Managed → User → Project 根到 CWD 逐级 → Local),让 User 层全局指令
 * (~/.billiardbuddy/BILLIARDBUDDY.md)也进主会话。名字白标(见 memoryNames.ts)。
 */
export async function buildSystemPrompt(workspace: Workspace, discovery?: DiscoverySources): Promise<string> {
  const isGit = await getIsGit(workspace.root)
  const env = computeEnvInfo({ workspaceRoot: workspace.root, isGit })
  const [gitStatus, memoryInjection] = await Promise.all([
    getGitStatus(workspace.root),
    loadMemoryInjection(workspace),
  ])
  // 技能/命令发现清单(对齐 cc SkillTool skill listing):汇总 builtin 命令 + 技能 + 已启用领域包命令,
  // 按约 1% 上下文预算截断后注入,让模型「看清单 → 自动调」,并把 /台球 这类斜杠映射到对应技能/命令。
  const skillListing = discovery ? buildSkillCommandListingSection(discovery) : ''
  return [
    buildAntiReveal(),
    BASE_IDENTITY,
    ACTIONS_SECTION,
    CODING_WORKFLOW_SECTION,
    VERIFICATION_SECTION,
    TOOL_DISCOVERY_SECTION,
    DENIAL_RULE,
    ...(skillListing ? [skillListing] : []),
    ...(memoryInjection ? [memoryInjection] : []),
    env,
    ...(gitStatus ? [gitStatus] : []),
  ].join('\n\n')
}
