import { ToolRegistry } from './registry'
import { fileReadManyTool, fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { fileEditTool, fileMultiEditTool, filePatchManyTool, filePatchTool } from './fileEditTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'
import { powerShellTool } from './powerShellTool'
import { webFetchTool } from './webFetchTool'
import { webSearchTool } from './webSearchTool'
import { todoWriteTool } from './todoTool'
import { saveMemoryTool } from './saveMemoryTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { globFilesTool, grepFilesTool } from './searchTools'
import { codeOutlineTool } from './codeOutlineTool'
import { gitStatusTool } from './gitStatusTool'
import { gitHistoryTool } from './gitHistoryTool'
import { notebookEditTool } from './notebookEditTool'
import { editExcelTool } from './spreadsheetTool'
import { lspTool } from './lspTool'
import { enterWorktreeTool, exitWorktreeTool } from './worktreeTools'
import { createReplTool, REPL_TOOL_NAME } from './replTool'
import { readStoredToolResultTool } from './storedToolResultTool'
import { projectDiagnosticsTool } from './projectDiagnosticsTool'
import { projectInstructionsTool } from './projectInstructionsTool'
import { askUserQuestionCompatTool, askUserQuestionTool, enterPlanCompatTool, enterPlanTool, exitPlanCompatTool, exitPlanTool } from './agentInteractionTools'
import { verifyPlanExecutionCompatTool, verifyPlanExecutionTool } from './verifyPlanExecutionTool'
import { briefCompatTool, sendUserMessageTool } from './briefTool'
import type { Sandbox } from '../sandbox/sandbox'
import { createSkillTools, type ExecuteSkillFn, type SkillLibrary } from '../skills/skillLoader'
import { createCommandTools, type CommandLibrary } from '../commands/commandLoader'
import type { Tool } from './Tool'
import { createToolSearchTool, TOOL_SEARCH_NAME } from './toolSearchTool'
import { createComputerUseTools, type ComputerUseToolsOptions } from './computerUse'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域包只通过可选推荐/额外工具挂载,不改通用底座身份。 */
export function buildGeneralRegistry(opts: { sandbox?: Sandbox; skills?: SkillLibrary; skillsRoot?: string; skillRecommendations?: string[]; executeSkill?: ExecuteSkillFn; commands?: CommandLibrary; extraTools?: Tool[]; computerUse?: boolean | ComputerUseToolsOptions } = {}): ToolRegistry {
  // 本机控制(截图/点击/键鼠)默认关闭 —— 需 owner 显式开启(computerUse: true)+ 平台为 mac/win。
  // 关闭时不构造任何工具、不起 Python;开启时惰性 bootstrap(首个 execute 才建 venv)。
  const computerUseTools = opts.computerUse
    ? createComputerUseTools(typeof opts.computerUse === 'object' ? opts.computerUse : {})
    : []
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
    editExcelTool,
    lspTool,
    enterWorktreeTool,
    exitWorktreeTool,
    readStoredToolResultTool,
    sendUserMessageTool,
    briefCompatTool,
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
    webFetchTool,
    webSearchTool,
    todoWriteTool,
    saveMemoryTool,
    fileHistoryTool,
    restoreFileTool,
    ...(opts.skills ? createSkillTools(opts.skills, { skillRoot: opts.skillsRoot, recommendedSkillNames: opts.skillRecommendations, executeSkill: opts.executeSkill }) : []),
    ...(opts.commands ? createCommandTools(opts.commands) : []),
    ...computerUseTools,
    ...(opts.extraTools ?? []),
  ])
  if (!registry.get(REPL_TOOL_NAME)) registry.register(createReplTool(registry))
  if (!registry.get(TOOL_SEARCH_NAME)) registry.register(createToolSearchTool(registry))
  return registry
}
