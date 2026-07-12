// hook `if` 输入谓词(对齐 cc utils/hooks.ts:1401-1439 prepareIfConditionMatcher):
// 让工具类 hook(PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest)按【工具输入】精细过滤,
// 而不只按工具名。`if` 值是一条权限规则字符串(如 `Bash(git *)` / `Edit(.env)`),语义:
//   - 工具名不匹配当前工具 → 不运行该 hook;
//   - 只有工具名、无括号内容 → 工具名匹配即运行;
//   - 带内容 → 命令类按命令模式匹配(复用审批闸同一个 shellCommandMatchesPermissionRule),
//             文件类按路径 glob 匹配(复用同一个 fileGlobMatchesPathForRule),其余工具无内容匹配器 → 不运行(安全方向)。
// cc 用 tool.preparePermissionMatcher(需 registry);本实现走"按工具族复用审批闸纯匹配器",覆盖命令/文件两大类
// (hook.if 的绝大多数真实用例),不引入 registry 依赖。

import { isAbsolute, resolve as resolvePath } from 'node:path'
import { permissionRuleValueFromString, shellCommandMatchesPermissionRule } from '../permissions/permissionRules'
import { fileGlobMatchesPathForRule } from '../permissions/filePathRuleMatch'

// if 条件写规范名(Bash/Read/Edit…),payload.toolName 是内部名(run_command/read_file…);两边归一到同族比较。
// 与 permissions/resolve.ts TOOL_RULE_ALIASES 同表(此处独立一份避免 hooks→resolve 反向依赖)。
const HOOK_IF_TOOL_ALIASES: Record<string, string[]> = {
  run_command: ['run_command', 'Bash'],
  read_file: ['read_file', 'Read'],
  read_many_files: ['read_many_files', 'Read'],
  write_file: ['write_file', 'Write'],
  edit_file: ['edit_file', 'Edit'],
  list_dir: ['list_dir', 'LS'],
  grep_files: ['grep_files', 'Grep'],
  glob_files: ['glob_files', 'Glob'],
  agent_task: ['agent_task', 'Task'],
  todo_write: ['todo_write', 'TodoWrite'],
  PowerShell: ['PowerShell'],
  NotebookEdit: ['NotebookEdit'],
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

/**
 * 判定一条 `if` 规则是否命中当前工具调用。事件类型的门在调用方(runHookEvent)已限工具类,这里只做匹配。
 * @param workspaceRoot 文件类工具的相对路径解析基准。
 */
export function hookIfConditionMatches(ifCondition: string, payloadToolName: string | undefined, input: unknown, workspaceRoot: string): boolean {
  if (!payloadToolName) return false
  const parsed = permissionRuleValueFromString(ifCondition)
  const candidates = HOOK_IF_TOOL_ALIASES[payloadToolName] ?? [payloadToolName]
  if (parsed.toolName !== '*' && !candidates.includes(parsed.toolName)) return false
  if (!parsed.ruleContent) return true

  const rec = record(input)
  const command = typeof rec.command === 'string' ? rec.command.trim() : ''
  if (command) return shellCommandMatchesPermissionRule(command, parsed.ruleContent)

  const rawPath = typeof rec.path === 'string' ? rec.path : typeof rec.file_path === 'string' ? rec.file_path : ''
  if (rawPath) {
    const abs = isAbsolute(rawPath) ? rawPath : resolvePath(workspaceRoot, rawPath)
    return fileGlobMatchesPathForRule(workspaceRoot, abs, parsed.ruleContent, 'localSettings')
  }
  // 无命令/路径可匹配的工具 + 带内容的 if → 无匹配器,保守不运行(对齐 cc patternMatcher 缺省 false)。
  return false
}
