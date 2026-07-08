import { expect, test } from 'bun:test'
import { runHookEvent } from '../hooks/hooks'
import { Workspace } from '../workspace/workspace'
import { createDomainPackCommandLibrary, createDomainPackHookRegistry, createDomainPackTools, listPublicDomainPacks, mergeHookRegistries, resolveEnabledPacks, suggestedCommandNamesForPacks, suggestedSkillNamesForPacks } from './domainPacks'

test('resolveEnabledPacks supports enabled_packs/knowledge_packs aliases and dedupes', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球', 'pool', 'missing'] })
  expect(packs.map(pack => pack.id)).toEqual(['billiards'])
})

test('resolveEnabledPacks keeps explicit empty packs as generic mode', () => {
  expect(resolveEnabledPacks({ knowledge_packs: [], billiards_mode: true })).toEqual([])
  expect(resolveEnabledPacks({ billiards_mode: true }).map(pack => pack.id)).toEqual(['billiards'])
})

test('domain pack SessionStart hook injects pack context without replacing configured hooks', async () => {
  const packHooks = createDomainPackHookRegistry(resolveEnabledPacks({ knowledgePacks: ['billiards'] }))
  const hooks = mergeHookRegistries(packHooks, {
    rules: [
      { event: 'SessionStart', handler: () => ({ action: 'context', additionalContext: '自定义启动上下文' }) },
    ],
  })
  const decisions = await runHookEvent(hooks, { event: 'SessionStart', sessionId: 's1' }, {
    workspace: new Workspace(process.cwd()),
  })

  expect(decisions).toHaveLength(2)
  expect(decisions[0]).toMatchObject({ action: 'context' })
  expect(decisions[0]?.action === 'context' ? decisions[0].additionalContext : '').toContain('<domain_context id="billiards"')
  expect(decisions[1]).toEqual({ action: 'context', additionalContext: '自定义启动上下文' })
})

test('listPublicDomainPacks exposes stable pack metadata for the frontend', () => {
  expect(listPublicDomainPacks()).toEqual([
    expect.objectContaining({
      id: 'billiards',
      name: '台球运营专家',
      default_enabled: false,
      suggested_skills: expect.arrayContaining(['video-edit']),
      suggested_commands: expect.arrayContaining(['billiards:daily-ops']),
      suggested_tools: expect.arrayContaining(['billiards_ops_checklist']),
    }),
  ])
})

test('suggestedSkillNamesForPacks dedupes skills in pack order', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球', 'pool'] })
  expect(suggestedSkillNamesForPacks(packs)).toEqual([
    'daily-report',
    'find-problems',
    'run-activity',
    'video-edit',
    'what-to-post-today',
  ])
})

test('domain packs expose prompt commands for progressive disclosure', async () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球', 'pool'] })
  expect(suggestedCommandNamesForPacks(packs)).toEqual([
    'billiards:daily-ops',
    'billiards:content-plan',
  ])
  const commands = createDomainPackCommandLibrary(packs)
  expect(commands?.commands.map(command => command.name).sort()).toEqual([
    'billiards:content-plan',
    'billiards:daily-ops',
  ])
  const daily = commands?.byName.get('billiards:daily-ops')
  expect(daily?.description).toContain('每日经营复盘')
  expect(daily?.allowedTools).toContain('search_store_docs')
  const prompt = await daily?.getPrompt('今天收入下滑', { workspace: new Workspace(process.cwd()) })
  expect(prompt).toContain('领域包: 台球运营专家')
  expect(prompt).toContain('命令参数')
  expect(prompt).toContain('今天收入下滑')
  expect(prompt).toContain('不要编造门店真实数字')
})

test('domain pack tools are gated by enabled packs and return source-aware guidance', async () => {
  expect(createDomainPackTools(resolveEnabledPacks({ knowledge_packs: [] })).map(tool => tool.name)).toEqual([])

  const tools = createDomainPackTools(resolveEnabledPacks({ knowledge_packs: ['billiards'] }))
  expect(tools.map(tool => tool.name)).toEqual(['billiards_ops_checklist'])
  const out = await tools[0]!.execute({
    scenario: '周末团购活动海报',
    known_facts: ['黄金档台费 68 元'],
    needs_media: true,
  }, { workspace: new Workspace(process.cwd()) })

  expect(out).toContain('<domain_pack_tool_result pack="billiards" tool="billiards_ops_checklist">')
  expect(out).toContain('黄金档台费 68 元')
  expect(out).toContain('search_store_docs')
  expect(out).toContain('make_poster/generate_image')
})
