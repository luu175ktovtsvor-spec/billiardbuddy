import { textBlock, toolResultBlock, type Message, type ToolUseBlock } from '../types/message'

export const FORK_SUBAGENT_TYPE = 'fork'
export const FORK_BOILERPLATE_TAG = 'fork-boilerplate'
export const FORK_DIRECTIVE_PREFIX = 'Your directive: '

const FORK_PLACEHOLDER_RESULT = 'Fork started - processing in background'

export function isInForkChild(messages: Message[]): boolean {
  return messages.some(message =>
    message.role === 'user' &&
    message.content.some(block =>
      block.type === 'text' &&
      block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    ),
  )
}

export function buildForkedMessages(directive: string, assistantMessage: Message): Message[] {
  if (assistantMessage.role !== 'assistant') {
    return [{ role: 'user', content: [textBlock(buildChildMessage(directive))] }]
  }
  const fullAssistantMessage: Message = {
    role: 'assistant',
    content: assistantMessage.content.slice(),
  }
  const toolUseBlocks = assistantMessage.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
  if (toolUseBlocks.length === 0) {
    return [{ role: 'user', content: [textBlock(buildChildMessage(directive))] }]
  }
  return [
    fullAssistantMessage,
    {
      role: 'user',
      content: [
        ...toolUseBlocks.map(block => toolResultBlock(block.id, FORK_PLACEHOLDER_RESULT)),
        textBlock(buildChildMessage(directive)),
      ],
    },
  ]
}

export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT - that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most - other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths - include for research tasks>
  Files changed: <list with commit hash - include only if you modified files>
  Issues: <list - include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} - same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
