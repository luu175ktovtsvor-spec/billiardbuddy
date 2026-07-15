import { expect, test } from 'bun:test'
import { runHookEvent } from '../hooks/hooks'
import { Workspace } from '../workspace/workspace'
import { mergeCommandLibraries } from '../commands/commandLoader'
import { createDomainPackCommandLibrary, createDomainPackHookRegistry, createDomainPackTools, listPublicDomainPacks, mergeHookRegistries, registerDomainPackCommandAliases, resolveEnabledPacks, suggestedCommandNamesForPacks, suggestedSkillNamesForPacks } from './domainPacks'

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
      name: '台球运营知识库',
      version: '2.0.0',
      default_enabled: true,
      suggested_skills: [
        'venue-daily-review',
        'customer-follow-up',
        'venue-campaign-planning',
        'venue-inspection-followup',
        'staff-performance-coaching',
        'boss-recruiting',
        'image-creation',
        'video-editing',
      ],
      suggested_commands: ['台球'],
      suggested_tools: ['billiards_knowledge_search'],
    }),
  ])
})

test('billiards knowledge pack prioritizes vertical skills without granting tools', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球', 'pool'] })
  expect(suggestedSkillNamesForPacks(packs)).toEqual([
    'venue-daily-review',
    'customer-follow-up',
    'venue-campaign-planning',
    'venue-inspection-followup',
    'staff-performance-coaching',
    'boss-recruiting',
    'image-creation',
    'video-editing',
  ])
  expect(createDomainPackTools(packs).map(tool => tool.name)).toEqual(['billiards_knowledge_search'])
})

test('billiards pack exposes only the knowledge activation command', async () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球', 'pool'] })
  expect(suggestedCommandNamesForPacks(packs)).toEqual(['台球'])
  const commands = createDomainPackCommandLibrary(packs)
  expect(commands?.commands.map(command => command.name)).toEqual(['台球'])
  const entry = commands?.byName.get('台球')
  const prompt = await entry?.getPrompt('今天收入下滑', { workspace: new Workspace(process.cwd()) })
  expect(prompt).toContain('领域包: 台球运营知识库')
  expect(prompt).toContain('命令参数')
  expect(prompt).toContain('今天收入下滑')
  expect(prompt).toContain('继续按球房管家的正常方式')
  expect(prompt).toContain('billiards_knowledge_search')
})

test('billiards 入口命令 /台球 及别名(/billiards、/球房)都解析到同一入口,清单只出一条', async () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
  const commands = createDomainPackCommandLibrary(packs)!
  // 入口命令在清单里只出一条(canonical = 台球),别名不重复占位
  const entry = commands.byName.get('台球')
  expect(entry?.description).toBe('启用球房运营知识与建议')
  expect(commands.commands).toHaveLength(1)
  // 别名 /billiards、/球房、/台球房、/pool 都解析到同一入口命令对象
  for (const alias of ['billiards', '球房', '台球房', 'pool', 'billiard']) {
    expect(commands.byName.get(alias)).toBe(entry!)
  }
  // 入口 prompt 只挂载知识,不切换通用 Agent 工作流
  const prompt = await entry?.getPrompt('周末怎么搞活动', { workspace: new Workspace(process.cwd()) })
  expect(prompt).toContain('命令: /台球')
  expect(prompt).toContain('billiards_knowledge_search')
  expect(prompt).not.toContain('/billiards:')
  expect(prompt).toContain('周末怎么搞活动')
})

test('registerDomainPackCommandAliases: 合并重建 byName 后重新挂别名', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
  const packLib = createDomainPackCommandLibrary(packs)!
  // 模拟 mergeCommandLibraries:只从 commands 数组重建 byName(别名键会丢)
  const merged = mergeCommandLibraries({ commands: packLib.commands, byName: new Map(packLib.commands.map(c => [c.name, c])) })
  expect(merged.byName.get('球房')).toBeUndefined()
  registerDomainPackCommandAliases(merged, packs)
  expect(merged.byName.get('球房')?.name).toBe('台球')
  expect(merged.byName.get('billiards')?.name).toBe('台球')
})

test('domain pack tools are gated by enabled packs and return sourced knowledge only', async () => {
  expect(createDomainPackTools(resolveEnabledPacks({ knowledge_packs: [] })).map(tool => tool.name)).toEqual([])

  const tools = createDomainPackTools(resolveEnabledPacks({ knowledge_packs: ['billiards'] }))
  expect(tools.map(tool => tool.name)).toEqual(['billiards_knowledge_search'])
  const out = await tools[0]!.execute({ query: '周末团购活动' }, { workspace: new Workspace(process.cwd()) })

  expect(out).toContain('<domain_knowledge pack="billiards">')
  expect(out).toContain('知识库来源')
  expect(out).toContain('</domain_knowledge>')
  expect(out).not.toContain('执行顺序')
})

test('packIdForCommandName:斜杠入口命令名映射到领域包(owner 设计:/台球→billiards)', async () => {
  const { packIdForCommandName } = await import('./domainPacks')
  // 入口命令 + 别名(pack.aliases 含台球/球房/台球房/pool/billiard)
  expect(packIdForCommandName('台球')).toBe('billiards')
  expect(packIdForCommandName('球房')).toBe('billiards')
  expect(packIdForCommandName('billiards')).toBe('billiards')
  expect(packIdForCommandName('pool')).toBe('billiards')
  // 兼容第三方或工作区命名空间命令的 pack 前缀识别
  expect(packIdForCommandName('billiards:daily-ops')).toBe('billiards')
  // 无关命令不误映射
  expect(packIdForCommandName('commit')).toBeUndefined()
  expect(packIdForCommandName('')).toBeUndefined()
})

test('mergeEnabledPacks:并入额外 pack id 去重,未知 id 跳过', async () => {
  const { mergeEnabledPacks, resolveEnabledPacks } = await import('./domainPacks')
  const base = resolveEnabledPacks({})  // 空
  expect(base).toHaveLength(0)
  const merged = mergeEnabledPacks(base, ['billiards', 'billiards', 'nonexistent-pack'])
  expect(merged.map(p => p.id)).toEqual(['billiards'])  // 去重 + 跳过未知
  // 已在 base 里的不重复加
  const merged2 = mergeEnabledPacks(merged, ['billiards'])
  expect(merged2.map(p => p.id)).toEqual(['billiards'])
})
