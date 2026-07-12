import type { Workspace } from '../workspace/workspace'
import { loadMemoryInjection } from './claudemd'
import { computeEnvInfo, getGitStatus, getIsGit } from './env'
import { ACTIONS_SECTION, buildAntiReveal, CODING_WORKFLOW_SECTION, DENIAL_RULE, DOING_TASKS_SECTION, OUTPUT_EFFICIENCY_SECTION, SAFETY_RED_LINES, SYSTEM_SECTION, TONE_SECTION, TOOL_DISCOVERY_SECTION, VERIFICATION_SECTION } from './prompts'
import { buildSkillCommandListingSection, type DiscoverySources } from './skillListing'
import type { OutputStyleConfig } from '../outputStyles/outputStyleLoader'
import { buildMemorySystemPrompt } from '../memory/memoryPrompt'

/** auto-memory 是否启用(对齐 cc loadMemoryPrompt:禁用时不注入记忆系统提示)。与 claudemd 的开关口径一致。 */
function autoMemoryEnabled(): boolean {
  const truthy = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes'
  return !truthy(process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY) && !truthy(process.env.BILLIARDBUDDY_DISABLE_MEMORY)
}

const BASE_IDENTITY = '你是一个装在用户电脑上的本机 AI 助手,能读写文件、跑命令,实打实把活干完。'

/**
 * 系统提示装配:白标身份(anti-reveal)+ 基座 + 谨慎执行动作 + 拒绝处理 + 分层记忆注入 + <env> + git 快照。
 *
 * 分层记忆注入对齐 cc(context.ts:172 getClaudeMds(getMemoryFiles())):不再只注入单层项目指令,而是
 * **四层全量**(Managed → User → Project 根到 CWD 逐级 → Local),让 User 层全局指令
 * (~/.billiardbuddy/BILLIARDBUDDY.md)也进主会话。名字白标(见 memoryNames.ts)。
 */
export async function buildSystemPrompt(workspace: Workspace, discovery?: DiscoverySources, outputStyle?: OutputStyleConfig | null): Promise<string> {
  const isGit = await getIsGit(workspace.root)
  const env = computeEnvInfo({ workspaceRoot: workspace.root, isGit })
  const [gitStatus, memoryInjection] = await Promise.all([
    getGitStatus(workspace.root),
    loadMemoryInjection(workspace),
  ])
  // 技能/命令发现清单(对齐 cc SkillTool skill listing):汇总 builtin 命令 + 技能 + 已启用领域包命令,
  // 按约 1% 上下文预算截断后注入,让模型「看清单 → 自动调」,并把 /台球 这类斜杠映射到对应技能/命令。
  const skillListing = discovery ? buildSkillCommandListingSection(discovery) : ''
  // 记忆系统提示(四类分类法/不该存/怎么存/何时访问/据记忆给建议前先核实/搜索过往上下文,对齐 cc buildMemoryLines);
  // 让模型会主动读回自己写的记忆、并在回合末评估是否有耐久事实要 save_memory。auto-memory 禁用时不注入(对齐 cc)。
  const memoryPrompt = autoMemoryEnabled() ? buildMemorySystemPrompt(workspace.root) : ''
  return [
    buildAntiReveal(),
    BASE_IDENTITY,
    // 安全红线无条件注入(CLAUDE.md 铁律 #1:与挂没挂领域包无关、用户偏好松不开;台球包 SAFETY_FLOORS 是领域细化版,并存不冲突)
    SAFETY_RED_LINES,
    SYSTEM_SECTION,
    ACTIONS_SECTION,
    // 编码纪律章门控(对齐 cc:outputStyleConfig===null 或 keepCodingInstructions===true 才注入):
    // 选了非编码输出风格且未声明保留 → 跳过「# 做任务」,让风格主导语气/结构。
    ...(outputStyle == null || outputStyle.keepCodingInstructions === true ? [DOING_TASKS_SECTION] : []),
    TONE_SECTION,
    OUTPUT_EFFICIENCY_SECTION,
    // 输出风格注入系统提示中部(对齐 cc systemPromptSection('output_style'),不再是 server 尾部 extraContext)。
    ...(outputStyle?.prompt ? [outputStyle.prompt] : []),
    CODING_WORKFLOW_SECTION,
    VERIFICATION_SECTION,
    TOOL_DISCOVERY_SECTION,
    DENIAL_RULE,
    ...(skillListing ? [skillListing] : []),
    ...(memoryPrompt ? [memoryPrompt] : []),
    ...(memoryInjection ? [memoryInjection] : []),
    env,
    ...(gitStatus ? [gitStatus] : []),
  ].join('\n\n')
}
