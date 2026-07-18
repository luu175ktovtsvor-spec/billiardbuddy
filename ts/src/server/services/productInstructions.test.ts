import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverProductInstructions } from './productInstructions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('loads AGENTS.md and BilliardBuddy.md from root to active directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  roots.push(root)
  const nested = path.join(root, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  writeFileSync(path.join(root, 'AGENTS.md'), 'root agent')
  writeFileSync(path.join(root, 'BilliardBuddy.md'), 'root product')
  writeFileSync(path.join(nested, 'AGENTS.md'), 'nested agent')

  expect(discoverProductInstructions(nested, root).map(item => item.content)).toEqual([
    'root agent',
    'root product',
    'nested agent',
  ])
})

test('deduplicates instruction files that resolve to the same file', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  roots.push(root)
  const original = path.join(root, 'AGENTS.md')
  writeFileSync(original, 'shared rules')
  symlinkSync(original, path.join(root, 'BilliardBuddy.md'))

  expect(discoverProductInstructions(root, root)).toHaveLength(1)
})

test('retains nearer instructions first when the total exceeds the budget', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  roots.push(root)
  const nested = path.join(root, 'packages', 'app')
  mkdirSync(nested, { recursive: true })
  writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(50_000))
  writeFileSync(path.join(root, 'BilliardBuddy.md'), 'b'.repeat(50_000))
  writeFileSync(path.join(nested, 'AGENTS.md'), 'c'.repeat(50_000))
  writeFileSync(path.join(nested, 'BilliardBuddy.md'), 'd'.repeat(50_000))

  const instructions = discoverProductInstructions(nested, root)

  const canonicalRoot = realpathSync(root)
  expect(instructions.map(item => path.relative(canonicalRoot, item.path))).toEqual([
    'BilliardBuddy.md',
    path.join('packages', 'app', 'AGENTS.md'),
    path.join('packages', 'app', 'BilliardBuddy.md'),
  ])
  expect(instructions.reduce((total, item) => total + item.content.length, 0)).toBe(100_000)
  expect(instructions[0]?.content.length).toBe(20_000)
  expect(instructions[1]?.content.length).toBe(40_000)
  expect(instructions[2]?.content.length).toBe(40_000)
  expect(instructions[0]?.content).toEndWith('[content truncated]')
  expect(instructions[1]?.content).toEndWith('[content truncated]')
  expect(instructions[2]?.content).toEndWith('[content truncated]')
})
