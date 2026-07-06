import { ToolRegistry } from './registry'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { fileEditTool } from './fileEditTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'
import { todoWriteTool } from './todoTool'
import { fileHistoryTool, restoreFileTool } from './fileHistoryTool'
import { globFilesTool, grepFilesTool } from './searchTools'
import { askUserQuestionCompatTool, askUserQuestionTool, exitPlanCompatTool, exitPlanTool } from './agentInteractionTools'
import type { Sandbox } from '../sandbox/sandbox'
import { createSkillTools, type SkillLibrary } from '../skills/skillLoader'
import { createCommandTools, type CommandLibrary } from '../commands/commandLoader'
import type { Tool } from './Tool'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域层(billiards)是后续窗。 */
export function buildGeneralRegistry(opts: { sandbox?: Sandbox; skills?: SkillLibrary; skillsRoot?: string; commands?: CommandLibrary; extraTools?: Tool[] } = {}): ToolRegistry {
  const runCmd = opts.sandbox
    ? { ...runCommandTool, description: `${runCommandTool.description}\n${opts.sandbox.describeForPrompt()}` }
    : runCommandTool
  return new ToolRegistry([
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    listDirTool,
    globFilesTool,
    grepFilesTool,
    askUserQuestionTool,
    askUserQuestionCompatTool,
    exitPlanTool,
    exitPlanCompatTool,
    runCmd,
    todoWriteTool,
    fileHistoryTool,
    restoreFileTool,
    ...(opts.skills ? createSkillTools(opts.skills, { skillRoot: opts.skillsRoot }) : []),
    ...(opts.commands ? createCommandTools(opts.commands) : []),
    ...(opts.extraTools ?? []),
  ])
}
