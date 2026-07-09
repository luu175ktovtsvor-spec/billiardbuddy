import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveEnabledPluginContributions } from './pluginLoader'

function makePlugin(root: string, name: string, opts: { enabled?: boolean; skills?: boolean; commands?: boolean; mcp?: boolean } = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', ...(opts.enabled === false ? { enabled: false } : {}) }))
  if (opts.skills) { mkdirSync(join(dir, 'skills'), { recursive: true }); writeFileSync(join(dir, 'skills', 'x.md'), '# skill') }
  if (opts.commands) { mkdirSync(join(dir, 'commands'), { recursive: true }); writeFileSync(join(dir, 'commands', 'c.md'), '# cmd') }
  if (opts.mcp) writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}')
  return dir
}

test('resolveEnabledPluginContributions:只收启用插件的 skills/commands/.mcp.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-contrib-'))
  try {
    const enabledDir = makePlugin(root, 'alpha', { enabled: true, skills: true, commands: true, mcp: true })
    makePlugin(root, 'beta', { enabled: false, skills: true, mcp: true }) // 禁用 → 不收
    makePlugin(root, 'gamma', { enabled: true }) // 启用但无贡献 → 不进列表

    const contribs = await resolveEnabledPluginContributions([root])
    expect(contribs.skillsDirs).toEqual([join(enabledDir, 'skills')])
    expect(contribs.commandsDirs).toEqual([join(enabledDir, 'commands')])
    expect(contribs.mcpConfigPaths).toEqual([join(enabledDir, '.mcp.json')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveEnabledPluginContributions:无插件根目录时安全退空', async () => {
  const contribs = await resolveEnabledPluginContributions([join(tmpdir(), 'nonexistent-plugin-root-xyz')])
  expect(contribs).toEqual({ skillsDirs: [], commandsDirs: [], mcpConfigPaths: [] })
})
