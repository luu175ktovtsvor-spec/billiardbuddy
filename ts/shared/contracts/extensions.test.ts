import { expect, test } from 'bun:test'
import {
  extensionCommandsResponseSchema,
  mcpListResponseSchema,
  pluginListResponseSchema,
  pluginToggleRequestSchema,
} from './extensions'

test('extension contracts accept current and compatible plugin/command responses', () => {
  const plugins = pluginListResponseSchema.parse({
    plugins: [{
      name: 'demo',
      enabled: false,
      dir: '/private/path-that-must-not-cross-the-boundary',
      components: { skills: 1, commands: 2, 'output-styles': 0, mcp: 1 },
    }],
  })
  expect(plugins.plugins[0]).toEqual({
    name: 'demo',
    enabled: false,
    description: '',
    components: { skills: 1, commands: 2, hooks: 0, 'output-styles': 0, mcp: 1 },
  })

  expect(extensionCommandsResponseSchema.parse({
    commands: [{ name: 'plugin-skill', description: 'Plugin skill', source: 'plugin', layer: 'plugin' }],
  }).commands[0]?.source).toBe('plugin')
})

test('extension contracts reject malformed trust and discovery fields', () => {
  expect(pluginToggleRequestSchema.safeParse({ name: 'demo', enabled: 'yes' }).success).toBe(false)
  expect(extensionCommandsResponseSchema.safeParse({
    commands: [{ name: 'bad', description: 'Bad source', source: 'remote' }],
  }).success).toBe(false)
  expect(mcpListResponseSchema.safeParse({
    servers: [{ name: 'demo', status: 'running', tools: 0, disabled: false }],
  }).success).toBe(false)
})
