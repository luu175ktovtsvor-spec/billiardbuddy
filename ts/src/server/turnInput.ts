// 回合输入组装与会话生命周期支援:工作区来源、支持上下文、本地命令回执、
// goal 命令处理和 SessionEnd 钩子触发。

import { mkdirSync } from 'node:fs'
import { getDefaultWorkspaceDir } from '../harness/desktopEnvNames'
import { getAutoMemDir } from '../harness/memoryNames'
import { loadWorkspaceHookRegistry } from '../hooks/hookConfig'
import { applySessionEndHooks } from '../hooks/hooks'
import { clearThreadGoalHook, ensureThreadGoalHookFromTranscript, getThreadGoal, parseGoalCommand, setThreadGoalHook } from '../goals/goalState'
import { Workspace } from '../workspace/workspace'
import { textBlock, type Message } from '../types/message'
import type { ToolContext } from '../tools/Tool'
import { stringArray, stringOr } from './requestParams'

export function messageText(message: Message): string {
  return message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return block.thinking
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function supportContext(rawBody: Record<string, unknown>): string {
  const blocks: string[] = []
  const selectedFiles = stringArray(rawBody.selected_files ?? rawBody.selectedFiles)
  if (selectedFiles.length > 0) {
    blocks.push(`<selected_files>\n${selectedFiles.map(file => `- ${file}`).join('\n')}\n</selected_files>`)
  }
  const goal = stringOr(rawBody.goal, '')
  if (goal) {
    blocks.push(`<user_goal>\n${goal}\n</user_goal>`)
  }
  if (rawBody.deep_thinking === true || rawBody.deepThinking === true) {
    blocks.push('用户打开了深度思考。遇到多步骤任务时，先简短拆解，再动手执行；不要只给建议。')
  }
  return blocks.length > 0 ? blocks.join('\n\n') : ''
}

export function workspaceFromBody(rawBody: Record<string, unknown>): Workspace {
  const root = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
  // 主 agent 读放行 carve-out(对齐 cc filesystem.ts isAutoMemFile 放行):AutoMem 记忆目录在
  // 工作区之外(~/.billiardbuddy/projects/<slug>/memory),把它加进 allowedPaths,模型才能 grep/read_file
  // 读回自己写的记忆(与写侧 save_memory、常驻索引读侧派生同一目录)。先 mkdir 保证它作为「目录」被放行。
  const memoryDir = getAutoMemDir(new Workspace(root).root)
  try { mkdirSync(memoryDir, { recursive: true }) } catch { /* 记忆目录创建尽力而为,失败不阻塞会话 */ }
  return new Workspace(root, {
    allowedPaths: [...stringArray(rawBody.selected_files ?? rawBody.selectedFiles), memoryDir],
    fullDiskAccess: rawBody.full_disk_access === true || rawBody.fullDiskAccess === true,
  })
}

export function messagingSocketPathFrom(rawBody: Record<string, unknown>, env: Record<string, string | undefined>): string {
  return stringOr(
    rawBody.messagingSocketPath ?? rawBody.messaging_socket_path ?? rawBody.udsMessagingSocketPath ?? rawBody.uds_messaging_socket_path,
    '',
  ) || stringOr(env.CLAUDE_CODE_MESSAGING_SOCKET, '')
}

export function localCommandMessage(name: string, args: string, output: string): Message {
  return {
    role: 'user',
    content: [textBlock([
      `<command-name>/${name}</command-name>`,
      `<command-args>${args}</command-args>`,
      '<local-command-stdout>',
      output,
      '</local-command-stdout>',
    ].join('\n'))],
  }
}

export async function handleGoalCommand(conversationId: string, args: string, transcript: { load(): Promise<Message[]>; append(messages: Message[]): Promise<void> }): Promise<{ output: string; shouldQuery: boolean }> {
  const messages = await transcript.load()
  let parsed: ReturnType<typeof parseGoalCommand>
  try {
    parsed = parseGoalCommand(args)
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    messages.push(localCommandMessage('goal', args, output))
    await transcript.append(messages)
    return { output, shouldQuery: false }
  }

  if (parsed.type === 'clear') {
    const existing = getThreadGoal(conversationId) ?? ensureThreadGoalHookFromTranscript(conversationId, messages)
    const cleared = clearThreadGoalHook(conversationId)
    const output = cleared || existing ? `Goal cleared: ${(cleared ?? existing)!.objective}` : 'No active goal.'
    messages.push(localCommandMessage('goal', args, output))
    await transcript.append(messages)
    return { output, shouldQuery: false }
  }

  const goal = setThreadGoalHook(conversationId, parsed.objective)
  const output = `Goal set: ${goal.objective}`
  messages.push(localCommandMessage('goal', args, output))
  await transcript.append(messages)
  return { output, shouldQuery: true }
}

// SessionEnd 落点(对齐参考实现 executeSessionEndHooks:会话结束时触发,fire-and-forget)。
// 宿主在"用户删除会话"处调用:载荷带结束原因,失败/超时都不拖垮删除主流程。用最小 ToolContext
// (无 model——SessionEnd 一般是命令/清理类钩子;若配了 agent/prompt 钩子会因缺 model 优雅降级为非阻塞提示)。
// hooks 配置走三级加载(loadWorkspaceHookRegistry:~/.billiardbuddy/settings.json + 工作区
// .billiardbuddy/settings.json + settings.local.json,取代已删除的死路径 server/hooks.json——
// 该目录随老 Python server/ 一并删除,旧 defaultHooksPath() 恒 undefined,SessionEnd 从未真正加载到过
// local hook)。project/local 两级来源钩子仍过工作区信任闸;工作区取显式全局默认工作区
// (getDefaultWorkspaceDir,不选文件夹时的落点)。
export async function fireSessionEndHooks(conversationId: string, reason: string): Promise<void> {
  try {
    const registry = await loadWorkspaceHookRegistry(getDefaultWorkspaceDir())
    if (!registry || registry.rules.length === 0) return
    const ctx: ToolContext = {
      workspace: new Workspace(getDefaultWorkspaceDir()),
      conversationId,
      permissionMode: 'default',
    }
    await applySessionEndHooks(registry, reason, ctx)
  } catch {
    // 忽略 SessionEnd 钩子异常,与参考实现的 fire-and-forget 语义一致。
  }
}
