import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProductHookSnapshot } from './productHookSnapshot.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function command(name: string) {
  return { matcher: '', hooks: [{ type: 'command' as const, command: `printf ${name}` }] }
}

test('Product Hook snapshot merges BilliardBuddy settings from checkout root to active directory', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-hooks-')); roots.push(root)
  const active = path.join(root, 'packages', 'app')
  mkdirSync(path.join(root, '.git'))
  mkdirSync(path.join(root, '.BilliardBuddy'), { recursive: true })
  mkdirSync(path.join(active, '.BilliardBuddy'), { recursive: true })
  writeFileSync(path.join(root, '.BilliardBuddy', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [command('product-root')] }, disableAllHooks: true }))
  writeFileSync(path.join(active, '.BilliardBuddy', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [command('product-active')] }, disableAllHooks: false }))

  const snapshot = await createProductHookSnapshot(active)

  expect(snapshot.hooks.UserPromptSubmit?.map(matcher => matcher.hooks[0]?.command)).toEqual([
    'printf product-root',
    'printf product-active',
  ])
  expect(snapshot.disableAllHooks).toBeFalse()
  expect(snapshot.sourceCount).toBe(2)
  expect(snapshot.matcherCount).toBe(2)
  expect(snapshot.commandCount).toBe(2)
})

test('Product Hook snapshot does not silently import Claude project settings', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-hooks-')); roots.push(root)
  mkdirSync(path.join(root, '.claude'), { recursive: true })
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [command('legacy')] } }))

  expect((await createProductHookSnapshot(root)).hooks).toEqual({})
})

test('Product Hook snapshot rejects a settings symlink that escapes the checkout', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-hooks-')); roots.push(root)
  const outside = mkdtempSync(path.join(os.tmpdir(), 'bb-product-hooks-outside-')); roots.push(outside)
  mkdirSync(path.join(root, '.git'))
  mkdirSync(path.join(root, '.BilliardBuddy'))
  const outsideSettings = path.join(outside, 'settings.json')
  writeFileSync(outsideSettings, JSON.stringify({ hooks: { Stop: [command('escaped')] } }))
  symlinkSync(outsideSettings, path.join(root, '.BilliardBuddy', 'settings.json'))

  const snapshot = await createProductHookSnapshot(root)

  expect(snapshot.sourceCount).toBe(0)
  expect(snapshot.hooks).toEqual({})
})
