import { expect, test } from 'bun:test'
import { fetchSystemPromptParts } from './queryContext.js'

test('caller-owned context and cwd bypass process-global discovery', async () => {
  const previousSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  try {
    const result = await fetchSystemPromptParts({
      tools: [],
      mainLoopModel: 'test-model',
      additionalWorkingDirectories: [],
      mcpClients: [],
      customSystemPrompt: undefined,
      userContextOverride: { project: 'alpha only' },
      systemContextOverride: {},
      disableMemoryDiscovery: true,
      workingDirectoryOverride: '/project/alpha',
    })

    expect(result.userContext).toEqual({ project: 'alpha only' })
    expect(result.systemContext).toEqual({})
    expect(result.defaultSystemPrompt.join('\n')).toContain('CWD: /project/alpha')
  } finally {
    if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = previousSimple
  }
})
