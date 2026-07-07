import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { lspTool } from './lspTool'

function makeWorkspace(): { root: string; workspace: Workspace } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lsp-tool-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'math.ts'), [
    'export function add(a: number, b: number): number {',
    '  return a + b',
    '}',
    '',
    'export class Calculator {',
    '  total = 0',
    '  add(value: number) {',
    '    this.total = add(this.total, value)',
    '  }',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'use.ts'), [
    "import { add, Calculator } from './math'",
    '',
    'const result = add(1, 2)',
    'const calc = new Calculator()',
    'calc.add(result)',
  ].join('\n'))
  return { root, workspace: new Workspace(root) }
}

test('LSP documentSymbol returns code symbols for a file', async () => {
  const { workspace } = makeWorkspace()
  const out = await lspTool.execute({ operation: 'documentSymbol', filePath: 'src/math.ts', line: 1, character: 18 }, { workspace })

  expect(out).toContain('<lsp operation="documentSymbol"')
  expect(out).toContain('add (function) - Line 1')
  expect(out).toContain('Calculator (class) - Line 5')
})

test('LSP goToDefinition and hover use the symbol at the requested position', async () => {
  const { workspace } = makeWorkspace()
  const def = await lspTool.execute({ operation: 'goToDefinition', filePath: 'src/use.ts', line: 3, character: 17 }, { workspace })
  const hover = await lspTool.execute({ operation: 'hover', filePath: 'src/use.ts', line: 3, character: 17 }, { workspace })

  expect(def).toContain('Found 2 definitions for add')
  expect(def).toContain('src/math.ts:1:')
  expect(hover).toContain('symbol: add')
  expect(hover).toContain('definition: src/math.ts:1:')
})

test('LSP findReferences groups symbol usages by file', async () => {
  const { workspace } = makeWorkspace()
  const out = await lspTool.execute({ operation: 'findReferences', filePath: 'src/use.ts', line: 3, character: 17, max_results: 20 }, { workspace })

  expect(out).toContain('references across')
  expect(out).toContain('src/math.ts:')
  expect(out).toContain('src/use.ts:')
})

test('LSP workspaceSymbol can search symbols across the workspace', async () => {
  const { workspace } = makeWorkspace()
  const out = await lspTool.execute({ operation: 'workspaceSymbol', filePath: 'src/use.ts', line: 1, character: 12, query: 'Calculator' }, { workspace })

  expect(out).toContain('Found 1 symbols in workspace')
  expect(out).toContain('Calculator (class) - Line 5')
})
