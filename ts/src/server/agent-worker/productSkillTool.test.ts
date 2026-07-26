import { expect, test } from 'bun:test'
import { createProductSkillTool } from './productSkillTool.js'

test('Skill tool exposes only the current Turn Skill catalog to the model', async () => {
  const tool = createProductSkillTool([
    {
      type: 'prompt', name: 'review-kit:security', description: 'Review security boundaries',
      source: 'plugin', loadedFrom: 'plugin', contentLength: 10, progressMessage: 'running',
      async getPromptForCommand() { return [{ type: 'text' as const, text: 'review' }] },
    },
    {
      type: 'prompt', name: 'user-only', description: 'User only', disableModelInvocation: true,
      source: 'project', contentLength: 10, progressMessage: 'running',
      async getPromptForCommand() { return [{ type: 'text' as const, text: 'private' }] },
    },
  ])

  expect(tool.inputJSONSchema).toMatchObject({
    properties: { skill: { enum: ['review-kit:security'] } },
  })
  expect(await tool.description({}, { isNonInteractiveSession: true, toolPermissionContext: { mode: 'default', isBypassPermissionsModeAvailable: false }, tools: [tool] })).toContain('review-kit:security: Review security boundaries')
  expect(JSON.stringify(tool.inputJSONSchema)).not.toContain('user-only')
})
