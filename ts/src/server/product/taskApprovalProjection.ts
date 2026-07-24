import type { ProductTaskActionApproval } from '../../../shared/product/taskEvents.js'
import type { AgentWorkerApprovalReviewFacts } from '../../../shared/product/agentWorker.js'

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch'])

/**
 * Turn a private Core tool identity into a stable product explanation. Raw
 * commands, paths, tool input and MCP payloads never cross this boundary.
 */
export function projectProductTaskActionApproval(toolName: string): ProductTaskActionApproval {
  if (toolName === 'Bash') return {
    what: '运行一条受限命令',
    scope: '当前任务工作区之外的本机资源或网络边界',
    consequence: '命令可能修改文件、启动进程或访问外部服务。',
  }
  if (toolName === 'Read') return {
    what: '读取受保护的文件',
    scope: '当前任务工作区之外的文件位置',
    consequence: '允许后会读取本次任务所需的文件。',
  }
  if (FILE_TOOLS.has(toolName)) return {
    what: '修改受保护的文件',
    scope: '当前任务工作区之外的文件位置',
    consequence: '允许后会更改磁盘上的文件内容。',
  }
  if (NETWORK_TOOLS.has(toolName)) return {
    what: '访问外部网站',
    scope: '本次请求所需的互联网目标',
    consequence: '必要的请求数据会发送到外部服务。',
  }
  if (toolName === 'Agent' || toolName === 'Skill') return {
    what: '启动扩展任务能力',
    scope: '当前任务及其获准使用的工作区资源',
    consequence: '扩展能力可能继续读取、修改文件或调用受控工具。',
  }
  if (toolName.startsWith('mcp__')) return {
    what: '调用外部扩展能力',
    scope: '当前任务获准连接的扩展服务',
    consequence: '完成操作所需的数据可能发送到该扩展服务。',
  }
  return {
    what: '执行一项受限操作',
    scope: '当前任务请求越过的本机或外部服务边界',
    consequence: '允许后可能修改本地数据或访问外部服务。',
  }
}

type ReviewableTool = {
  name: string
  isReadOnly(input: never): boolean
  isDestructive?(input: never): boolean
  isOpenWorld?(input: never): boolean
}

function toolFlag(operation: (() => boolean) | undefined, fallback: boolean): boolean {
  if (!operation) return fallback
  try { return operation() } catch { return fallback }
}

/** Minimal facts for an independent reviewer; no command, path, host or input. */
export function projectAgentWorkerApprovalReview(
  tool: ReviewableTool,
  input: unknown,
): AgentWorkerApprovalReviewFacts {
  const category = tool.name === 'Bash'
    ? 'command'
    : FILE_TOOLS.has(tool.name) || tool.name === 'Read'
      ? 'filesystem'
      : NETWORK_TOOLS.has(tool.name)
        ? 'network'
        : tool.name === 'Agent' || tool.name === 'Skill' || tool.name.startsWith('mcp__')
          ? 'extension'
          : 'other'
  return {
    category,
    read_only: toolFlag(() => tool.isReadOnly(input as never), false),
    destructive: tool.isDestructive ? toolFlag(() => tool.isDestructive!(input as never), true) : false,
    open_world: toolFlag(tool.isOpenWorld ? () => tool.isOpenWorld!(input as never) : undefined, category === 'network' || category === 'extension'),
  }
}
