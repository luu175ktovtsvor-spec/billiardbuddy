import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createProductInstructionSnapshot,
  discoverProductInstructions,
  discoverProductProjectInstructions,
} from './productInstructions.js'

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

test('rejects instruction symlinks that escape the project root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'bb-instructions-outside-'))
  roots.push(root, outside)
  const privateFile = path.join(outside, 'private.md')
  writeFileSync(privateFile, 'must not cross project boundary')
  symlinkSync(privateFile, path.join(root, 'AGENTS.md'))

  expect(discoverProductInstructions(root, root)).toEqual([])
})

test('unifies compatible project instructions and preserves conditional rules', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  roots.push(root)
  const nested = path.join(root, 'packages', 'app')
  const rules = path.join(root, '.claude', 'rules')
  mkdirSync(nested, { recursive: true })
  mkdirSync(rules, { recursive: true })
  writeFileSync(path.join(root, 'CLAUDE.md'), 'root compatible')
  writeFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'dot compatible')
  writeFileSync(path.join(rules, 'always.md'), 'always rule')
  writeFileSync(
    path.join(rules, 'typescript.md'),
    '---\npaths: "**/*.ts"\n---\nconditional rule',
  )
  writeFileSync(path.join(root, 'AGENTS.md'), 'root agent')
  writeFileSync(path.join(root, 'BilliardBuddy.md'), 'root product')
  writeFileSync(path.join(nested, 'CLAUDE.local.md'), 'nested local')

  const instructions = discoverProductProjectInstructions(nested, root)
  expect(instructions.map(item => item.content)).toEqual([
    'root compatible',
    'dot compatible',
    'always rule',
    'conditional rule',
    'root agent',
    'root product',
    'nested local',
  ])
  expect(instructions[3]?.paths).toEqual(['**/*.ts'])
})

test('creates an immutable in-memory snapshot for one project', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-instructions-'))
  roots.push(root)
  const instructionPath = path.join(root, 'BilliardBuddy.md')
  writeFileSync(instructionPath, 'project alpha only')

  const snapshot = createProductInstructionSnapshot(root)
  writeFileSync(instructionPath, 'project beta later')

  expect(snapshot.prompt).toContain('project alpha only')
  expect(snapshot.prompt).not.toContain('project beta later')
  expect(snapshot.digest).toHaveLength(64)
})

test('keeps sibling project instruction snapshots isolated', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'bb-instructions-projects-'))
  roots.push(parent)
  const alpha = path.join(parent, 'alpha')
  const beta = path.join(parent, 'beta')
  mkdirSync(alpha)
  mkdirSync(beta)
  writeFileSync(path.join(alpha, 'CLAUDE.md'), 'alpha private instruction')
  writeFileSync(path.join(beta, 'CLAUDE.md'), 'beta private instruction')

  const alphaSnapshot = createProductInstructionSnapshot(alpha)
  const betaSnapshot = createProductInstructionSnapshot(beta)

  expect(alphaSnapshot.prompt).toContain('alpha private instruction')
  expect(alphaSnapshot.prompt).not.toContain('beta private instruction')
  expect(betaSnapshot.prompt).toContain('beta private instruction')
  expect(betaSnapshot.prompt).not.toContain('alpha private instruction')
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
