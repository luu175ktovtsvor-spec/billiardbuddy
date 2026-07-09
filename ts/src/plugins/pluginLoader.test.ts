import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveEnabledPluginContributions, resolveEnabledPluginHookConfigPaths } from './pluginLoader'
import { loadSkillsDir } from '../skills/skillLoader'
import { loadPluginHookRegistry } from '../hooks/hookConfig'
import { runHookEvent } from '../hooks/hooks'
import { Workspace } from '../workspace/workspace'

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

test('可挂载能力端到端:启用插件的 skill 经 resolveEnabledPluginContributions + loadSkillsDir 真加载出来', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-cap-'))
  try {
    const dir = join(root, 'cap-plugin')
    mkdirSync(join(dir, 'skills', 'my-cap'), { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'cap-plugin', version: '1.0.0' }))
    writeFileSync(join(dir, 'skills', 'my-cap', 'SKILL.md'), '---\nname: my_cap\ndescription: 测试可挂载能力\n---\n# 正文')
    const contribs = await resolveEnabledPluginContributions([root])
    expect(contribs.skillsDirs).toEqual([join(dir, 'skills')])
    const lib = await loadSkillsDir(contribs.skillsDirs[0]!)
    expect(lib.skills.some(s => s.name === 'my_cap')).toBe(true) // 插件 skill 真挂进来了
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveEnabledPluginContributions:无插件根目录时安全退空', async () => {
  const contribs = await resolveEnabledPluginContributions([join(tmpdir(), 'nonexistent-plugin-root-xyz')])
  expect(contribs).toEqual({ skillsDirs: [], commandsDirs: [], mcpConfigPaths: [] })
})

test('插件 hook 端到端:启用插件的 hooks/hooks.json 被 resolveEnabledPluginHookConfigPaths 收集 + loadPluginHookRegistry 真触发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-hooks-e2e-'))
  try {
    // 启用插件 alpha:cc 标准位置 hooks/hooks.json
    const alpha = join(root, 'alpha')
    mkdirSync(join(alpha, 'hooks'), { recursive: true })
    writeFileSync(join(alpha, 'plugin.json'), JSON.stringify({ name: 'alpha', version: '1.0.0' }))
    writeFileSync(join(alpha, 'hooks', 'hooks.json'), JSON.stringify({
      description: 'alpha',
      hooks: { PreToolUse: [{ matcher: 'run_command', hooks: [{ decision: { action: 'deny', message: 'alpha 拦截命令' } }] }] },
    }))
    // 禁用插件 beta:即便有 hooks 也不收
    const beta = join(root, 'beta')
    mkdirSync(join(beta, 'hooks'), { recursive: true })
    writeFileSync(join(beta, 'plugin.json'), JSON.stringify({ name: 'beta', version: '1.0.0', enabled: false }))
    writeFileSync(join(beta, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ decision: { action: 'deny', message: 'beta' } }] }] } }))

    const paths = await resolveEnabledPluginHookConfigPaths([root])
    expect(paths).toEqual([join(alpha, 'hooks', 'hooks.json')]) // 只收启用插件

    const registry = await loadPluginHookRegistry(paths)
    expect(registry?.rules.every(r => r.source === 'plugin')).toBe(true)
    const decisions = await runHookEvent(registry, { event: 'PreToolUse', toolName: 'run_command' }, { workspace: new Workspace(root) })
    expect(decisions).toEqual([{ action: 'deny', message: 'alpha 拦截命令' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
