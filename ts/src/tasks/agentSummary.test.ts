import { expect, test } from 'bun:test'
import { scriptedModel } from '../harness/fakeModel'
import { textBlock, toolResultBlock, toolUseBlock, userText } from '../types/message'
import { startAgentSummarization } from './agentSummary'

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timeout')
}

test('AgentSummary rebuilds cache-safe params from the latest clean fork context', async () => {
  const summaries: string[] = []
  const model = scriptedModel([
    { kind: 'final', text: 'Reading latest file' },
  ])
  const controller = startAgentSummarization({
    taskId: 'summary-cache-safe',
    model,
    intervalMs: 1,
    updateSummary: summary => {
      summaries.push(summary)
    },
  })

  try {
    controller.updateSnapshot({
      system: 'OLD SYS',
      tools: [{ name: 'old_tool', description: '', parameters: { type: 'object' } }],
      messages: [
        userText('old task'),
        { role: 'assistant', content: [textBlock('old assistant')] },
        userText('old result'),
      ],
    })
    controller.updateSnapshot({
      system: 'NEW SYS',
      tools: [{ name: 'read_file', description: '', parameters: { type: 'object' } }],
      messages: [
        userText('new task'),
        { role: 'assistant', content: [textBlock('latest'), toolUseBlock({ id: 'done', name: 'read_file', input: { path: 'latest.ts' } })] },
        { role: 'user', content: [toolResultBlock('done', 'latest content')] },
        { role: 'assistant', content: [toolUseBlock({ id: 'pending', name: 'read_file', input: { path: 'pending.ts' } })] },
      ],
    })

    await waitFor(() => summaries.length === 1)
    const request = model.received[0]!
    expect(request.system).toBe('NEW SYS')
    expect(request.tools.map(tool => tool.name)).toEqual(['read_file'])
    expect(request.messages.some(message =>
      message.role === 'assistant' &&
      message.content.some(block => block.type === 'text' && block.text === 'latest'),
    )).toBe(true)
    expect(request.messages.some(message =>
      message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'done'),
    )).toBe(true)
    expect(request.messages.some(message =>
      message.content.some(block => block.type === 'tool_use' && block.id === 'pending'),
    )).toBe(false)
    expect(request.messages.at(-1)?.content[0]).toMatchObject({ type: 'text' })
    expect(summaries).toEqual(['Reading latest file'])
  } finally {
    controller.stop()
  }
})
