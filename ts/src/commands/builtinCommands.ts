import type { ToolContext } from '../tools/Tool'
import { isForkSubagentEnabled } from '../agents/forkSubagent'
import { commandLibraryFromCommands } from './commandLoader'
import type { CommandLibrary } from './commandLoader'
import type { PromptCommand } from './types'

export const FORK_COMMAND_NAME = 'fork'

function forkCommandPrompt(args: string): string {
  const directive = args.trim()
  return [
    `命令: /${FORK_COMMAND_NAME}`,
    '类型: fork-background-worker',
    '',
    'Launch a background fork worker by calling agent_task exactly once.',
    '',
    'Required behavior:',
    '- Call agent_task with only { "task": <directive> } unless the user explicitly requests worktree isolation.',
    '- Do not choose an agent name; omitting agent is what triggers inherited fork context while fork mode is enabled.',
    '- After agent_task returns the background task id, report only that the fork worker has started.',
    '- Do not read, tail, or summarize the worker output unless the user asks for a progress check.',
    '',
    directive
      ? `Directive:\n${directive}`
      : 'Directive is empty. Ask the user for the fork directive instead of launching a worker.',
  ].join('\n')
}

export function createBuiltinCommandLibrary(env: Record<string, string | undefined> = process.env): CommandLibrary {
  const commands: PromptCommand[] = []
  if (isForkSubagentEnabled(env)) {
    commands.push({
      type: 'prompt',
      name: FORK_COMMAND_NAME,
      description: '启动继承当前上下文的后台 fork worker',
      whenToUse: '需要把独立研究、审计或实现任务交给后台 worker 并保持主对话继续推进时使用。',
      allowedTools: ['agent_task'],
      source: 'builtin',
      filePath: 'builtin:/fork',
      baseDir: 'builtin',
      contentLength: forkCommandPrompt('').length,
      async getPrompt(args: string, _ctx: ToolContext): Promise<string> {
        return forkCommandPrompt(args)
      },
    })
  }
  return commandLibraryFromCommands(commands)
}

export function isBuiltinForkCommand(command: { name: string; source: string } | undefined): boolean {
  return command?.name === FORK_COMMAND_NAME && command.source === 'builtin'
}
