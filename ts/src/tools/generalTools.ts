import { ToolRegistry } from './registry'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'
import { todoWriteTool } from './todoTool'
import type { Sandbox } from '../sandbox/sandbox'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域层(billiards)是后续窗。 */
export function buildGeneralRegistry(opts: { sandbox?: Sandbox } = {}): ToolRegistry {
  const runCmd = opts.sandbox
    ? { ...runCommandTool, description: `${runCommandTool.description}\n${opts.sandbox.describeForPrompt()}` }
    : runCommandTool
  return new ToolRegistry([fileReadTool, fileWriteTool, listDirTool, runCmd, todoWriteTool])
}
