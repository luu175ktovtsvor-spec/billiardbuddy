import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionDiscoveryRouteHandler } from './extensionDiscoveryRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness(env: Record<string, string | undefined> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'extension-discovery-routes-'))
  roots.push(root)
  const commandsRoot = join(root, 'commands')
  const skillsRoot = join(root, 'skills')
  const outputStylesRoot = join(root, 'output-styles')
  const workspaceRoot = join(root, 'workspace')
  const pluginsRoot = join(root, 'plugins')
  mkdirSync(commandsRoot, { recursive: true })
  mkdirSync(skillsRoot, { recursive: true })
  mkdirSync(outputStylesRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(pluginsRoot, { recursive: true })
  const handler = createExtensionDiscoveryRouteHandler({
    commandsRoot,
    skillsRoot,
    defaultWorkspaceRoot: () => workspaceRoot,
    env,
    userSkillsRoot: null,
    outputStyleDirs: [{ source: 'test', dir: outputStylesRoot }],
    pluginRoots: [pluginsRoot],
  })
  return { root, commandsRoot, skillsRoot, outputStylesRoot, workspaceRoot, pluginsRoot, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createExtensionDiscoveryRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('extension discovery routes', () => {
  test('ignores unrelated paths and preserves method errors', async () => {
    const { handler, workspaceRoot } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    for (const path of [
      '/api/v1/agent/skills',
      '/api/v1/agent/output-styles',
      '/api/v1/agent/packs',
      '/api/v1/agent/commands',
    ]) {
      expect((await route(handler, path, { method: 'POST' })).status).toBe(405)
    }
    expect((await route(handler, `/commands?working_dir=${encodeURIComponent(workspaceRoot)}`, { method: 'POST' })).status).toBe(405)
    expect((await route(handler, `/api/commands/expand?working_dir=${encodeURIComponent(workspaceRoot)}`)).status).toBe(405)
  })

  test('lists skills, output styles, packs and public commands', async () => {
    const { root, commandsRoot, skillsRoot, outputStylesRoot, handler } = createHarness()
    const selectedWorkspaceRoot = join(root, 'selected-workspace')
    mkdirSync(selectedWorkspaceRoot, { recursive: true })
    const skillDir = join(skillsRoot, 'fixture-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), `---
name: fixture-skill
description: Fixture skill description
whenToUse: Use for fixture checks
argument-hint: <fixture>
---
Fixture instructions.
`)
    const workspaceSkillDir = join(selectedWorkspaceRoot, '.billiardbuddy', 'skills', 'workspace-skill')
    mkdirSync(workspaceSkillDir, { recursive: true })
    writeFileSync(join(workspaceSkillDir, 'SKILL.md'), `---
name: workspace-skill
description: Workspace skill description
---
Workspace instructions.
`)
    writeFileSync(join(commandsRoot, 'review.md'), `---
description: Review fixture changes
---
Review the fixture.
`)
    writeFileSync(join(outputStylesRoot, 'concise.md'), `---
description: Concise fixture style
---
Keep the answer concise.
`)

    const skills = await (await route(handler, `/api/v1/agent/skills?working_dir=${encodeURIComponent(selectedWorkspaceRoot)}`)).json() as any
    expect(skills.skills).toContainEqual(expect.objectContaining({
      name: 'fixture-skill',
      description: 'Fixture skill description',
      source: 'skills',
      layer: 'bundled',
      when_to_use: 'Use for fixture checks',
      argument_hint: '<fixture>',
      user_invocable: true,
    }))
    expect(skills.skills).toContainEqual(expect.objectContaining({
      name: 'workspace-skill',
      layer: 'workspace',
    }))

    const styles = await (await route(handler, '/api/v1/agent/output-styles')).json() as any
    expect(styles.output_styles).toEqual([{
      name: 'concise',
      description: 'Concise fixture style',
      source: 'test',
    }])

    const packs = await (await route(handler, '/api/v1/agent/packs')).json() as any
    expect(packs.packs).toEqual([expect.objectContaining({ id: 'billiards', default_enabled: true })])

    const commands = await (await route(
      handler,
      `/api/v1/agent/commands?working_dir=${encodeURIComponent(selectedWorkspaceRoot)}&enabledPacks=${encodeURIComponent('台球')}`,
    )).json() as any
    expect(commands.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '台球', source: 'pack', kind: 'command' }),
      expect.objectContaining({ name: 'fixture-skill', source: 'skill', kind: 'skill' }),
      expect.objectContaining({ name: 'workspace-skill', source: 'skill', kind: 'skill', layer: 'workspace' }),
      expect.objectContaining({ name: 'review', source: 'builtin', kind: 'command' }),
    ]))
  })

  test('public command discovery omits Agent-only workflows without disabling model discovery', async () => {
    const { commandsRoot, skillsRoot, workspaceRoot, handler } = createHarness()
    writeFileSync(join(commandsRoot, 'visible.md'), `---
name: visible
description: Visible command
---
Visible command body.
`)
    writeFileSync(join(commandsRoot, 'internal.md'), `---
name: internal
description: Internal command
user-invocable: false
---
Internal command body.
`)
    for (const [name, userInvocable] of [['business-work', true], ['agent-work', false]] as const) {
      const dir = join(skillsRoot, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: ${name} description
user-invocable: ${userInvocable}
---
${name} body.
`)
    }

    const body = await (await route(handler, `/api/v1/agent/commands?working_dir=${encodeURIComponent(workspaceRoot)}`)).json() as any
    const names = body.commands.map((command: any) => command.name)
    expect(names).toEqual(expect.arrayContaining(['visible', 'business-work']))
    expect(names).not.toContain('internal')
    expect(names).not.toContain('agent-work')

    const skills = await (await route(handler, `/api/v1/agent/skills?working_dir=${encodeURIComponent(workspaceRoot)}`)).json() as any
    expect(skills.skills).toContainEqual(expect.objectContaining({ name: 'agent-work', user_invocable: false }))
  })

  test('keeps pack activation discoverable and includes enabled plugin skills and commands with plugin source', async () => {
    const { pluginsRoot, workspaceRoot, handler } = createHarness()
    const pluginDir = join(pluginsRoot, 'demo')
    mkdirSync(join(pluginDir, 'skills', 'plugin-skill'), { recursive: true })
    mkdirSync(join(pluginDir, 'commands'), { recursive: true })
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'demo', enabled: true }))
    writeFileSync(join(pluginDir, 'skills', 'plugin-skill', 'SKILL.md'), `---
name: plugin-skill
description: Plugin skill
---
Plugin skill body.
`)
    writeFileSync(join(pluginDir, 'commands', 'plugin-command.md'), `---
description: Plugin command
---
Plugin command body.
`)

    const body = await (await route(handler, `/api/v1/agent/commands?working_dir=${encodeURIComponent(workspaceRoot)}`)).json() as any
    expect(body.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '台球', source: 'pack', kind: 'command' }),
      expect.objectContaining({ name: 'plugin-skill', source: 'plugin', layer: 'plugin', kind: 'skill' }),
      expect.objectContaining({ name: 'plugin-command', source: 'plugin', kind: 'command' }),
    ]))
    expect(body.commands.some((command: any) => command.name === 'billiards:daily-ops')).toBe(false)
  })

  test('lists and expands markdown prompt commands', async () => {
    const { root, commandsRoot, handler } = createHarness()
    writeFileSync(join(commandsRoot, 'daily.md'), `---
name: daily-report
description: 写日报
---
按门店数据生成日报。
`)

    const listed = await (await route(handler, `/commands?working_dir=${encodeURIComponent(root)}`)).json() as any
    expect(listed.commands).toHaveLength(1)
    expect(listed.commands[0]).toMatchObject({ name: 'daily-report', description: '写日报' })

    const expanded = await route(handler, '/api/commands/expand', {
      method: 'POST',
      body: JSON.stringify({ name: '/daily-report', args: '今天', workspaceRoot: root }),
    })
    expect(expanded.status).toBe(200)
    const body = await expanded.json() as any
    expect(body.prompt).toContain('命令: /daily-report')
    expect(body.prompt).toContain('按门店数据生成日报')
    expect(body.prompt).toContain('今天')

    expect((await route(handler, '/api/commands/expand', {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: root }),
    })).status).toBe(400)
    expect((await route(handler, '/api/commands/expand', {
      method: 'POST',
      body: JSON.stringify({ name: '/missing', workspaceRoot: root }),
    })).status).toBe(404)
  })

  test('keeps Remote Control command filtering', async () => {
    const { commandsRoot, workspaceRoot, handler } = createHarness()
    writeFileSync(join(commandsRoot, 'daily.md'), `---
name: daily-report
description: 写日报
---
按远端资料生成日报。
`)
    const listed = await (await route(
      handler,
      `/commands?working_dir=${encodeURIComponent(workspaceRoot)}&bridge_origin=true`,
    )).json() as any
    expect(listed.commands).toHaveLength(1)
    expect(listed.commands[0]).toMatchObject({ name: 'daily-report', description: '写日报' })
  })

  test('loads workspace commands after built-ins so workspace definitions win', async () => {
    const { commandsRoot, workspaceRoot, handler } = createHarness()
    const workspaceCommands = join(workspaceRoot, '.billiardbuddy', 'commands')
    mkdirSync(workspaceCommands, { recursive: true })
    writeFileSync(join(commandsRoot, 'review.md'), `---
description: Builtin review
---
Use builtin review.
`)
    writeFileSync(join(workspaceCommands, 'review.md'), `---
description: Workspace review
---
Use workspace review.
`)
    writeFileSync(join(workspaceCommands, 'fix.md'), `---
description: Workspace fix
---
Use workspace fix.
`)

    const listed = await (await route(handler, `/commands?working_dir=${encodeURIComponent(workspaceRoot)}`)).json() as any
    expect(listed.commands.map((command: any) => command.name).sort()).toEqual(['fix', 'review'])
    expect(listed.commands.find((command: any) => command.name === 'review')).toMatchObject({
      description: 'Workspace review',
    })
  })

  test('keeps workspace commands independent from the enabled knowledge pack', async () => {
    const { commandsRoot, workspaceRoot, handler } = createHarness()
    const workspaceCommands = join(workspaceRoot, '.billiardbuddy', 'commands')
    mkdirSync(workspaceCommands, { recursive: true })
    writeFileSync(join(workspaceCommands, 'daily.md'), `---
name: billiards:daily-ops
description: Workspace daily override
---
Use workspace-specific daily ops.
`)

    const listed = await (await route(
      handler,
      `/commands?working_dir=${encodeURIComponent(workspaceRoot)}&knowledge_packs=billiards`,
    )).json() as any
    expect(listed.commands.map((command: any) => command.name)).toEqual(expect.arrayContaining([
      '台球',
      'billiards:daily-ops',
    ]))
    expect(listed.commands.find((command: any) => command.name === 'billiards:daily-ops')).toMatchObject({
      description: 'Workspace daily override',
    })

    const expanded = await route(handler, '/api/commands/expand', {
      method: 'POST',
      body: JSON.stringify({
        name: '/台球',
        args: '周末活动',
        workspaceRoot,
        knowledge_packs: ['billiards'],
      }),
    })
    expect(expanded.status).toBe(200)
    const body = await expanded.json() as any
    expect(body.prompt).toContain('领域包: 台球运营知识库')
    expect(body.prompt).toContain('继续按通用 Agent 的正常方式')
    expect(body.prompt).toContain('周末活动')
  })

  test('exposes and expands the built-in fork command only when its gate is enabled', async () => {
    const { workspaceRoot, handler } = createHarness({ DESKTOP_AGENT_FORK_SUBAGENT: '1' })
    const listed = await (await route(handler, `/commands?working_dir=${encodeURIComponent(workspaceRoot)}`)).json() as any
    expect(listed.commands).toContainEqual(expect.objectContaining({
      name: 'fork',
      source: 'builtin',
      allowedTools: ['agent_task'],
    }))

    const expanded = await route(handler, '/api/commands/expand', {
      method: 'POST',
      body: JSON.stringify({ name: '/fork', args: '审计 parser 边界', workspaceRoot }),
    })
    expect(expanded.status).toBe(200)
    const body = await expanded.json() as any
    expect(body.prompt).toContain('Launch a background fork worker')
    expect(body.prompt).toContain('agent_task')
    expect(body.prompt).toContain('审计 parser 边界')
  })
})
