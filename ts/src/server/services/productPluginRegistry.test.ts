import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasProductPluginUpdateSource,
  installProductPluginFromDirectory,
  listProductPlugins,
  uninstallProductPlugin,
  updateProductPluginFromSource,
} from './productPluginRegistry.js'
import { PluginService } from './pluginService.js'

const roots: string[] = []
const originalConfig = process.env.BILLIARDBUDDY_CONFIG_DIR
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalConfig === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
  else process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfig
})

function makeSource(version: string, name = 'review-kit'): string {
  const source = mkdtempSync(join(tmpdir(), 'bb-plugin-source-')); roots.push(source)
  mkdirSync(join(source, '.BilliardBuddy-plugin'))
  mkdirSync(join(source, 'commands'))
  writeFileSync(join(source, '.BilliardBuddy-plugin', 'plugin.json'), JSON.stringify({ name, version, commands: 'commands' }))
  writeFileSync(join(source, 'commands', 'review.md'), `---\ndescription: review\n---\nversion ${version}`)
  return source
}

describe('Product plugin lifecycle', () => {
  test('installs a bounded local source, records a private update source, updates atomically, and uninstalls', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bb-plugin-workspace-')); roots.push(workspace)
    const config = mkdtempSync(join(tmpdir(), 'bb-plugin-config-')); roots.push(config)
    process.env.BILLIARDBUDDY_CONFIG_DIR = config
    const source = makeSource('1.0.0')

    const installed = await installProductPluginFromDirectory(source, 'project', workspace)
    expect(installed).toMatchObject({ id: 'project:review-kit', name: 'review-kit', scope: 'project', enabled: true })
    expect(await hasProductPluginUpdateSource(installed.id, installed.scope, workspace)).toBeTrue()
    expect(readFileSync(join(installed.root, 'commands', 'review.md'), 'utf8')).toContain('version 1.0.0')

    writeFileSync(join(source, '.BilliardBuddy-plugin', 'plugin.json'), JSON.stringify({ name: 'review-kit', version: '2.0.0', commands: 'commands' }))
    writeFileSync(join(source, 'commands', 'review.md'), '---\ndescription: review\n---\nversion 2.0.0')
    await updateProductPluginFromSource(installed.id, workspace)
    const updated = (await listProductPlugins(workspace))[0]!
    expect(updated.manifest.version).toBe('2.0.0')
    expect(readFileSync(join(updated.root, 'commands', 'review.md'), 'utf8')).toContain('version 2.0.0')

    await uninstallProductPlugin(installed.id, workspace)
    expect(await listProductPlugins(workspace)).toEqual([])
  })

  test('rejects plugin sources containing symlinks instead of copying outside content', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bb-plugin-workspace-')); roots.push(workspace)
    const config = mkdtempSync(join(tmpdir(), 'bb-plugin-config-')); roots.push(config)
    process.env.BILLIARDBUDDY_CONFIG_DIR = config
    const source = makeSource('1.0.0')
    const outside = join(workspace, 'outside.txt')
    writeFileSync(outside, 'private')
    symlinkSync(outside, join(source, 'commands', 'escaped.md'))

    await expect(installProductPluginFromDirectory(source, 'project', workspace)).rejects.toThrow('PLUGIN_SOURCE_INVALID')
    expect(await listProductPlugins(workspace)).toEqual([])
  })

  test('serializes concurrent source registration without losing either installed plugin', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bb-plugin-workspace-')); roots.push(workspace)
    const config = mkdtempSync(join(tmpdir(), 'bb-plugin-config-')); roots.push(config)
    process.env.BILLIARDBUDDY_CONFIG_DIR = config
    await Promise.all([
      installProductPluginFromDirectory(makeSource('1.0.0', 'alpha-kit'), 'project', workspace),
      installProductPluginFromDirectory(makeSource('1.0.0', 'beta-kit'), 'project', workspace),
    ])
    expect((await listProductPlugins(workspace)).map(plugin => plugin.name)).toEqual(['alpha-kit', 'beta-kit'])
    const sources = JSON.parse(readFileSync(join(workspace, '.BilliardBuddy', 'plugins-sources.json'), 'utf8'))
    expect(Object.keys(sources).sort()).toEqual(['project:alpha-kit', 'project:beta-kit'])
  })

  test('rejects a project plugin directory redirected outside the workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bb-plugin-workspace-')); roots.push(workspace)
    const outside = mkdtempSync(join(tmpdir(), 'bb-plugin-outside-')); roots.push(outside)
    const config = mkdtempSync(join(tmpdir(), 'bb-plugin-config-')); roots.push(config)
    process.env.BILLIARDBUDDY_CONFIG_DIR = config
    symlinkSync(outside, join(workspace, '.BilliardBuddy'))
    await expect(installProductPluginFromDirectory(makeSource('1.0.0'), 'project', workspace)).rejects.toThrow('PLUGIN_STATE_INVALID')
    await expect(listProductPlugins(workspace)).rejects.toThrow('PLUGIN_STATE_INVALID')
  })

  test('reports invalid installed extension files as attention instead of counting them as loaded', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bb-plugin-workspace-')); roots.push(workspace)
    const config = mkdtempSync(join(tmpdir(), 'bb-plugin-config-')); roots.push(config)
    process.env.BILLIARDBUDDY_CONFIG_DIR = config
    const installed = await installProductPluginFromDirectory(makeSource('1.0.0'), 'project', workspace)
    writeFileSync(join(installed.root, 'commands', 'review.md'), 'missing required frontmatter')
    const service = new PluginService()
    const listed = await service.listPlugins(workspace)
    expect(listed.summary.attention).toBe(1)
    expect(listed.plugins[0]).toMatchObject({ status: 'attention', componentCounts: { commands: 0 } })
    expect((await service.reloadPlugins(workspace)).summary.errors).toBe(1)
  })
})
