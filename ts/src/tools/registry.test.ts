import { test, expect } from 'bun:test'
import { ToolRegistry } from './registry'
import type { Tool } from './Tool'

const echoTool: Tool<{ msg: string }> = {
  name: 'echo',
  description: 'echoes msg',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  isReadOnly: true,
  async execute(input) {
    return String(input.msg)
  },
}

test('registry registers, looks up, and lists tools', () => {
  const reg = new ToolRegistry([echoTool])
  expect(reg.get('echo')).toBe(echoTool)
  expect(reg.get('nope')).toBeUndefined()
  expect(reg.list().map(t => t.name)).toEqual(['echo'])
})

test('registry produces model-facing specs (name/description/parameters)', () => {
  const reg = new ToolRegistry([echoTool])
  expect(reg.specs()).toEqual([
    { name: 'echo', description: 'echoes msg', parameters: echoTool.inputSchema },
  ])
})

test('registry rejects duplicate tool names', () => {
  const reg = new ToolRegistry([echoTool])
  expect(() => reg.register(echoTool)).toThrow(/duplicate/)
})
