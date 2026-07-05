import { test, expect } from 'bun:test'
import { buildGeneralRegistry } from './generalTools'

test('general registry contains the four core tools', () => {
  const reg = buildGeneralRegistry()
  expect(reg.list().map(t => t.name).sort()).toEqual(['list_dir', 'read_file', 'run_command', 'write_file'])
})

test('general registry specs are model-facing (have parameters)', () => {
  const specs = buildGeneralRegistry().specs()
  for (const s of specs) expect(s.parameters.type).toBe('object')
})
