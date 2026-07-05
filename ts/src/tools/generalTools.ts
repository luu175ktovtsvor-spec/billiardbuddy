import { ToolRegistry } from './registry'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域层(billiards)是后续窗。 */
export function buildGeneralRegistry(): ToolRegistry {
  return new ToolRegistry([fileReadTool, fileWriteTool, listDirTool, runCommandTool])
}
