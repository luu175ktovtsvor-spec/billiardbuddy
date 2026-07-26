import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProductAgentCommands, loadProductAgentPluginTools } from './productExtensionLoader.js'
import { createProductHookSnapshot } from './productHookSnapshot.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeSkill(root: string, configDirectory: '.BilliardBuddy' | '.claude', name: string, body: string) {
  const directory = path.join(root, configDirectory, 'skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), `---\ndescription: ${name} skill\n---\n${body}`)
}

test('Product Harness loads project Skills only from .BilliardBuddy', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-skills-')); roots.push(root)
  writeSkill(root, '.BilliardBuddy', 'product-skill', 'product body')
  writeSkill(root, '.claude', 'legacy-skill', 'legacy body')

  const commands = await loadProductAgentCommands(root)

  expect(commands.some(command => command.name === 'product-skill')).toBeTrue()
  expect(commands.some(command => command.name === 'legacy-skill')).toBeFalse()
})

test('Product Harness rejects a Skill symlink that escapes the checkout', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-skills-')); roots.push(root)
  const outside = mkdtempSync(path.join(os.tmpdir(), 'bb-product-skills-outside-')); roots.push(outside)
  writeSkill(outside, '.BilliardBuddy', 'escaped-skill', 'outside body')
  const skills = path.join(root, '.BilliardBuddy', 'skills')
  mkdirSync(skills, { recursive: true })
  symlinkSync(path.join(outside, '.BilliardBuddy', 'skills', 'escaped-skill'), path.join(skills, 'escaped-skill'))

  expect((await loadProductAgentCommands(root)).some(command => command.name === 'escaped-skill')).toBeFalse()
})

test('Product plugin commands, named agents, and Hooks enter the same frozen extension surface', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-plugin-')); roots.push(root)
  const plugin = path.join(root, '.BilliardBuddy', 'plugins', 'review-kit')
  mkdirSync(path.join(plugin, '.BilliardBuddy-plugin'), { recursive: true })
  mkdirSync(path.join(plugin, 'commands'))
  mkdirSync(path.join(plugin, 'agents'))
  writeFileSync(path.join(plugin, '.BilliardBuddy-plugin', 'plugin.json'), JSON.stringify({
    name: 'review-kit', version: '1.0.0', commands: 'commands', agents: 'agents', hooks: 'hooks.json',
  }))
  writeFileSync(path.join(plugin, 'commands', 'review.md'), '---\ndescription: Review one change\n---\nReview $ARGUMENTS using repository evidence.')
  writeFileSync(path.join(plugin, 'agents', 'security.md'), '---\ndescription: Inspect security boundaries\ntools: Read, Grep\n---\nInspect trust boundaries and report evidence.')
  writeFileSync(path.join(plugin, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'printf checked' }] }] } }))

  const [commands, tools, hooks] = await Promise.all([
    loadProductAgentCommands(root),
    loadProductAgentPluginTools(root),
    createProductHookSnapshot(root),
  ])

  const command = commands.find(value => value.name === 'review-kit:review')
  expect(command).toBeDefined()
  expect(await command!.getPromptForCommand('auth.ts', {} as never)).toEqual([{ type: 'text', text: 'Review auth.ts using repository evidence.' }])
  expect(tools.map(tool => tool.name)).toContain('agent__review-kit__security')
  expect(hooks.hooks.PreToolUse?.[0]?.hooks[0]).toMatchObject({ type: 'command', command: 'printf checked' })

  const namedAgent = tools.find(tool => tool.name === 'agent__review-kit__security')!
  let observedPrompt = ''
  const result = await namedAgent.call({ prompt: 'Review auth.ts' }, {
    productPromptContext: { workspace: root, date: '2026-01-01' },
    runProductModel: async function* (request: { messages: Array<{ message: { content: unknown } }> }) {
      observedPrompt = JSON.stringify(request.messages[0]?.message.content)
      yield {
        type: 'assistant', uuid: 'agent-result', timestamp: new Date(0).toISOString(),
        message: { id: 'agent-result', role: 'assistant', content: [{ type: 'text', text: 'No boundary issue found.' }], model: 'deepseek-v4-flash', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
      }
    },
    options: { commands, tools, mainLoopModel: 'deepseek-v4-flash', thinkingConfig: { type: 'adaptive' } },
    abortController: new AbortController(), permissionContext: { mode: 'default', isBypassPermissionsModeAvailable: false }, messages: [],
  } as never, async () => ({ behavior: 'allow', updatedInput: {}, reason: 'test' }), {} as never)
  expect(observedPrompt).toContain('Inspect trust boundaries')
  expect(observedPrompt).toContain('Review auth.ts')
  expect(result.data).toBe('No boundary issue found.')
})

test('Product plugin discovery ignores a legacy plugin manifest', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-plugin-')); roots.push(root)
  const plugin = path.join(root, '.BilliardBuddy', 'plugins', 'legacy')
  mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'legacy', version: '1.0.0', commands: 'commands' }))

  expect((await loadProductAgentCommands(root)).some(command => command.name.startsWith('legacy:'))).toBeFalse()
  expect(await loadProductAgentPluginTools(root)).toEqual([])
})

test('Product plugin LSP capability executes a real JSON-RPC request inside the frozen workspace', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bb-product-plugin-lsp-')); roots.push(root)
  const plugin = path.join(root, '.BilliardBuddy', 'plugins', 'language-kit')
  mkdirSync(path.join(plugin, '.BilliardBuddy-plugin'), { recursive: true })
  const server = path.join(plugin, 'server.ts')
  writeFileSync(server, `
const input = await Bun.stdin.text()
if (!input.includes('textDocument/hover') || !input.includes('sample.ts')) process.exit(2)
const send = (value: unknown) => {
  const body = JSON.stringify(value)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
send({ jsonrpc: '2.0', id: 1, result: { capabilities: { hoverProvider: true } } })
send({ jsonrpc: '2.0', id: 2, result: { contents: { kind: 'markdown', value: 'semantic result' } } })
send({ jsonrpc: '2.0', id: 3, result: null })
`)
  writeFileSync(path.join(plugin, '.BilliardBuddy-plugin', 'plugin.json'), JSON.stringify({
    name: 'language-kit', version: '1.0.0',
    lspServers: { typescript: { command: process.execPath, args: ['${BILLIARDBUDDY_PLUGIN_ROOT}/server.ts'], extensionToLanguage: { ts: 'typescript' } } },
  }))
  writeFileSync(path.join(root, 'sample.ts'), 'const answer = 42\n')

  const tools = await loadProductAgentPluginTools(root)
  const lsp = tools.find(tool => tool.name === 'lsp__language-kit__typescript')
  expect(lsp).toBeDefined()
  const controller = new AbortController()
  const result = await runWithProductPermissionEnvelope({
    version: 1, mode: 'policy_bound', sandbox_profile: 'unrestricted', approval_policy: 'never', reviewer: 'none', network_scope: 'denied', digest: 'test',
  }, () => lsp!.call({ operation: 'hover', file_path: 'sample.ts', line: 0, character: 6 }, {
    productPromptContext: { workspace: root, date: '2026-01-01' },
    options: { commands: [], tools, mainLoopModel: 'deepseek-v4-flash', thinkingConfig: { type: 'disabled' } },
    abortController: controller,
    permissionContext: { mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true },
    messages: [],
  } as never, async () => ({ behavior: 'allow', updatedInput: {}, reason: 'test' }), {} as never))

  expect(result.data).toContain('semantic result')
})
