import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterEnabledPlugins, loadPluginManifest, normalizePluginManifest } from './pluginManifest'

test('normalizePluginManifest:补默认目录,非法 manifest 返回 null', () => {
  expect(normalizePluginManifest({})).toBeNull()
  expect(normalizePluginManifest({ name: 'billiards', version: '1.0.0' })).toEqual({
    name: 'billiards',
    version: '1.0.0',
    skills: 'skills',
    agents: 'agents',
    hooks: 'hooks.json',
    mcp: '.mcp.json',
  })
})

test('loadPluginManifest + filterEnabledPlugins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-'))
  try {
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'billiards', version: '1.2.3', description: 'pack' }))
    const manifest = await loadPluginManifest(root)
    expect(manifest).toMatchObject({ name: 'billiards', version: '1.2.3', description: 'pack' })
    expect(filterEnabledPlugins([{ manifest: manifest! }], ['other'])).toEqual([])
    expect(filterEnabledPlugins([{ manifest: manifest! }], ['billiards'])).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
