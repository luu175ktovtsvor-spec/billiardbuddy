import { ToolRegistry } from './registry'
import { fileReadManyTool, fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { fileEditTool, fileMultiEditTool, filePatchManyTool, filePatchTool } from './fileEditTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'
import { powerShellTool } from './powerShellTool'
import { todoWriteTool } from './todoTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { globFilesTool, grepFilesTool } from './searchTools'
import { codeOutlineTool } from './codeOutlineTool'
import { gitStatusTool } from './gitStatusTool'
import { gitHistoryTool } from './gitHistoryTool'
import { notebookEditTool } from './notebookEditTool'
import { lspTool } from './lspTool'
import { enterWorktreeTool, exitWorktreeTool } from './worktreeTools'
import { createReplTool, REPL_TOOL_NAME } from './replTool'
import { readStoredToolResultTool } from './storedToolResultTool'
import { projectDiagnosticsTool } from './projectDiagnosticsTool'
import { projectInstructionsTool } from './projectInstructionsTool'
import { askUserQuestionCompatTool, askUserQuestionTool, enterPlanCompatTool, enterPlanTool, exitPlanCompatTool, exitPlanTool } from './agentInteractionTools'
import { verifyPlanExecutionCompatTool, verifyPlanExecutionTool } from './verifyPlanExecutionTool'
import type { Sandbox } from '../sandbox/sandbox'
import { createSkillTools, type SkillLibrary } from '../skills/skillLoader'
import { createCommandTools, type CommandLibrary } from '../commands/commandLoader'
import type { Tool } from './Tool'
import { createToolSearchTool, TOOL_SEARCH_NAME } from './toolSearchTool'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域包只通过可选推荐/额外工具挂载,不改通用底座身份。 */
export function buildGeneralRegistry(opts: { sandbox?: Sandbox; skills?: SkillLibrary; skillsRoot?: string; skillRecommendations?: string[]; commands?: CommandLibrary; extraTools?: Tool[] } = {}): ToolRegistry {
  const runCmd = opts.sandbox
    ? { ...runCommandTool, description: `${runCommandTool.description}\n${opts.sandbox.describeForPrompt()}` }
    : runCommandTool
  const registry = new ToolRegistry([
    fileReadTool,
    fileReadManyTool,
    fileWriteTool,
    fileEditTool,
    fileMultiEditTool,
    filePatchTool,
    filePatchManyTool,
    listDirTool,
    globFilesTool,
    grepFilesTool,
    codeOutlineTool,
    gitStatusTool,
    gitHistoryTool,
    notebookEditTool,
    lspTool,
    enterWorktreeTool,
    exitWorktreeTool,
    readStoredToolResultTool,
    projectInstructionsTool,
    projectDiagnosticsTool,
    askUserQuestionTool,
    askUserQuestionCompatTool,
    enterPlanTool,
    enterPlanCompatTool,
    exitPlanTool,
    exitPlanCompatTool,
    verifyPlanExecutionTool,
    verifyPlanExecutionCompatTool,
    powerShellTool,
    runCmd,
    todoWriteTool,
    fileHistoryTool,
    restoreFileTool,
    ...(opts.skills ? createSkillTools(opts.skills, { skillRoot: opts.skillsRoot, recommendedSkillNames: opts.skillRecommendations }) : []),
    ...(opts.commands ? createCommandTools(opts.commands) : []),
    ...(opts.extraTools ?? []),
  ])
  if (!registry.get(REPL_TOOL_NAME)) registry.register(createReplTool(registry))
  if (!registry.get(TOOL_SEARCH_NAME)) registry.register(createToolSearchTool(registry))
  return registry
}
