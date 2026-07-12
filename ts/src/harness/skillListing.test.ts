import { expect, test } from 'bun:test'
import { commandLibraryFromCommands } from '../commands/commandLoader'
import { createBuiltinCommandLibrary } from '../commands/builtinCommands'
import { createDomainPackCommandLibrary, resolveEnabledPacks } from '../packs/domainPacks'
import { loadSkillFile } from '../skills/skillLoader'
import type { PromptCommand } from '../commands/types'
import {
  buildSkillCommandListingSection,
  collectDiscoveryEntries,
  DEFAULT_CHAR_BUDGET,
  formatEntriesWithinBudget,
  getCharBudget,
  toPublicCommandEntries,
  type DiscoveryEntry,
} from './skillListing'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function skillEntry(name: string, description: string, whenToUse?: string): DiscoveryEntry {
  return { name, description, whenToUse, source: 'skill', alwaysInclude: true }
}
function builtinEntry(name: string, description: string, whenToUse?: string): DiscoveryEntry {
  return { name, description, whenToUse, source: 'builtin', alwaysInclude: false }
}

function fakeCommand(name: string, description: string, whenToUse: string, filePath: string, source: PromptCommand['source']): PromptCommand {
  return {
    type: 'prompt',
    name,
    description,
    whenToUse,
    source,
    filePath,
    baseDir: 'x',
    contentLength: 0,
    async getPrompt() {
      return ''
    },
  }
}

test('getCharBudget: 无窗口回退 8000,1% 上下文,环境覆盖优先', () => {
  const saved = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  try {
    expect(getCharBudget()).toBe(DEFAULT_CHAR_BUDGET)
    // 200k tokens × 4 字符/token × 1% = 8000
    expect(getCharBudget(200_000)).toBe(8_000)
    expect(getCharBudget(1_000_000)).toBe(40_000)
    process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '123'
    expect(getCharBudget(200_000)).toBe(123)
  } finally {
    if (saved === undefined) delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
    else process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = saved
  }
})

test('collectDiscoveryEntries 汇总 builtin 命令 + 技能 + 领域包命令,并按 pack→skill→builtin 排序去重', async () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
  const packCommands = createDomainPackCommandLibrary(packs)!
  const builtins = commandLibraryFromCommands([
    fakeCommand('doctor', '自检', '排查环境时', 'commands/doctor.md', 'commands'),
    createBuiltinForkOrNoop(),
  ].filter(Boolean) as PromptCommand[])

  const skillsDir = mkdtempSync(join(tmpdir(), 'skl-'))
  mkdirSync(join(skillsDir, 'commit'))
  writeFileSync(join(skillsDir, 'commit', 'SKILL.md'), '---\nname: commit\ndescription: 生成规范提交\nwhenToUse: 需要提交代码时\n---\n提交流程')
  const skill = await loadSkillFile(join(skillsDir, 'commit', 'SKILL.md'), 'skills')
  rmSync(skillsDir, { recursive: true, force: true })

  const merged = commandLibraryFromCommands([...builtins.commands, ...packCommands.commands])
  const entries = collectDiscoveryEntries({ commands: merged, skills: { skills: [skill], byName: new Map([[skill.name, skill]]) } })

  const bySource = (s: string) => entries.filter(e => e.source === s).map(e => e.name)
  // 领域包命令(含入口 /台球)= source 'pack'
  expect(bySource('pack')).toEqual(expect.arrayContaining(['台球', 'billiards:daily-ops', 'billiards:content-plan']))
  // 技能 = source 'skill'
  expect(bySource('skill')).toEqual(['commit'])
  // doctor 这类命令 = source 'builtin'
  expect(bySource('builtin')).toEqual(expect.arrayContaining(['doctor']))
  // 排序:pack 全部排在 skill 前,skill 全部排在 builtin 前
  const rank = entries.map(e => e.source)
  const lastPack = rank.lastIndexOf('pack')
  const firstSkill = rank.indexOf('skill')
  const lastSkill = rank.lastIndexOf('skill')
  const firstBuiltin = rank.indexOf('builtin')
  expect(lastPack).toBeLessThan(firstSkill)
  expect(lastSkill).toBeLessThan(firstBuiltin)
})

function createBuiltinForkOrNoop(): PromptCommand | null {
  const lib = createBuiltinCommandLibrary({ DESKTOP_AGENT_FORK_SUBAGENT: '1' })
  return lib.commands[0] ?? null
}

test('formatEntriesWithinBudget: 预算充足时给全量,含 name + 描述 + 使用时机', () => {
  const entries = [
    skillEntry('commit', '生成规范提交', '需要提交代码时'),
    builtinEntry('doctor', '自检'),
  ]
  const out = formatEntriesWithinBudget(entries)
  expect(out).toContain('- /commit: 生成规范提交 - 需要提交代码时')
  expect(out).toContain('- /doctor: 自检')
})

test('formatEntriesWithinBudget: 预算不足时截断,但 alwaysInclude(技能/领域包)整行永不被削', () => {
  const saved = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '80' // 极小预算,强制退成 names-only
  try {
    const entries = [
      skillEntry('台球', '台球运营专家入口:切进台球房经营专家视角作答', '老板问球房经营/活动/助教/短视频时'),
      builtinEntry('doctor', '自检环境:检查依赖、模型连通、权限档,给出可执行修复建议', '排查环境/连通性问题时'),
      builtinEntry('help', '列出所有可用命令与用法', '想知道能做什么时'),
    ]
    const out = formatEntriesWithinBudget(entries)
    const lines = out.split('\n')
    // 领域包入口整行保留(name + 完整描述 + 使用时机)
    expect(lines[0]).toBe('- /台球: 台球运营专家入口:切进台球房经营专家视角作答 - 老板问球房经营/活动/助教/短视频时')
    // 普通命令退成 names-only,描述被削掉
    expect(out).toContain('- /doctor\n')
    expect(out).toContain('- /help')
    expect(out).not.toContain('自检环境:检查依赖')
  } finally {
    if (saved === undefined) delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
    else process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = saved
  }
})

test('formatEntriesWithinBudget: 中等预算时普通命令削描述(不整行丢),alwaysInclude 仍整行', () => {
  const saved = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
  process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = '70'
  try {
    const entries = [
      skillEntry('台球', '台球运营专家入口', '进台球专家视角时'),
      builtinEntry('doctor', '自检环境并给出可执行修复建议,覆盖依赖/模型连通/权限档等多项检查', '排查环境/连通性问题时'),
    ]
    const out = formatEntriesWithinBudget(entries)
    expect(out).toContain('- /台球: 台球运营专家入口 - 进台球专家视角时')
    // doctor 保留 name + 被截断的描述(带省略号),而不是被整条丢弃或退成 names-only
    expect(out).toMatch(/- \/doctor: .+…/)
  } finally {
    if (saved === undefined) delete process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET
    else process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET = saved
  }
})

test('buildSkillCommandListingSection: 含 cc「斜杠命令=技能」语义 + 渐进披露 + billiards 入口在清单里', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
  const commands = createDomainPackCommandLibrary(packs)!
  const section = buildSkillCommandListingSection({ commands })
  expect(section).toContain('# 可用技能与命令(斜杠命令 = 技能)')
  expect(section).toContain('/台球')
  expect(section).toContain('发现清单')
  expect(section).toContain('别一次性全展开')
  // billiards 领域包命令进清单
  expect(section).toContain('/台球:')
  expect(section).toContain('/billiards:daily-ops:')
  expect(section).toContain('/billiards:content-plan:')
})

test('buildSkillCommandListingSection: 没有任何可发现条目时返回空串', () => {
  expect(buildSkillCommandListingSection({})).toBe('')
  expect(buildSkillCommandListingSection({ commands: commandLibraryFromCommands([]) })).toBe('')
})

test('toPublicCommandEntries: 输出 name/description/source(+可选 whenToUse/argHint),billiards 入口 source=pack', () => {
  const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
  const commands = createDomainPackCommandLibrary(packs)!
  const entries = toPublicCommandEntries(collectDiscoveryEntries({ commands }))
  const entry = entries.find(e => e.name === '台球')!
  expect(entry).toMatchObject({
    name: '台球',
    source: 'pack',
    description: expect.stringContaining('台球运营专家入口'),
    whenToUse: expect.stringContaining('也可直接敲 /台球'),
  })
  expect(entries.every(e => ['builtin', 'skill', 'pack'].includes(e.source))).toBe(true)
})

test('toPublicCommandEntries: 技能的 skillLayer 透传为 layer(前端「系统/个人/项目」作用域标注用)', async () => {
  const skillsDir = mkdtempSync(join(tmpdir(), 'skl-layer-'))
  try {
    mkdirSync(join(skillsDir, 'demo'))
    writeFileSync(join(skillsDir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n内容')
    const skill = await loadSkillFile(join(skillsDir, 'demo', 'SKILL.md'), 'skills')
    skill.skillLayer = 'user'
    const entries = toPublicCommandEntries(collectDiscoveryEntries({ skills: { skills: [skill], byName: new Map([[skill.name, skill]]) } }))
    expect(entries.find(e => e.name === 'demo')?.layer).toBe('user')
    // 无 skillLayer 的条目不带 layer 键(领域包/builtin 命令)
    const packs = resolveEnabledPacks({ enabled_packs: ['台球'] })
    const packEntries = toPublicCommandEntries(collectDiscoveryEntries({ commands: createDomainPackCommandLibrary(packs)! }))
    expect('layer' in packEntries.find(e => e.name === '台球')!).toBe(false)
  } finally {
    rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('用户面清单(toPublicCommandEntries)剔除 user-invocable:false;模型面(buildSkillCommandListingSection)剔除 disable-model-invocation', async () => {
  const { collectDiscoveryEntries, toPublicCommandEntries, buildSkillCommandListingSection } = await import('./skillListing')
  const mk = (name: string, extra: Partial<import('../commands/types').PromptCommand> = {}): import('../commands/types').PromptCommand => ({
    type: 'prompt', name, description: `${name} desc`, source: 'commands',
    filePath: '', baseDir: '', contentLength: 0, async getPrompt() { return '' }, ...extra,
  })
  const commands = {
    commands: [mk('open'), mk('userhidden', { userInvocable: false }), mk('modelhidden', { disableModelInvocation: true })],
    byName: new Map(),
  }
  const entries = collectDiscoveryEntries({ commands })
  // 用户面:userhidden 不给,modelhidden 保留
  const publicNames = toPublicCommandEntries(entries).map(e => e.name)
  expect(publicNames).toContain('open')
  expect(publicNames).toContain('modelhidden')
  expect(publicNames).not.toContain('userhidden')
  // 模型面:modelhidden 不列,userhidden 保留
  const section = buildSkillCommandListingSection({ commands })
  expect(section).toContain('/open')
  expect(section).toContain('/userhidden')
  expect(section).not.toContain('/modelhidden')
})

test('问题3修复:条件技能激活后经 activatedConditionalSkills 并回发现清单(默认隐身→碰到文件现身)', async () => {
  const { collectDiscoveryEntries, buildSkillCommandListingSection } = await import('./skillListing')
  const mk = (name: string, extra: Partial<import('../commands/types').PromptCommand> = {}): import('../commands/types').PromptCommand => ({
    type: 'prompt', name, description: `${name} desc`, source: 'skills',
    filePath: '', baseDir: '', contentLength: 0, async getPrompt() { return '' }, ...extra,
  })
  const sqlSkill = mk('sqlhelper', { paths: ['*.sql'] })
  // 未激活:发现清单不含 sqlhelper
  const withoutActivation = buildSkillCommandListingSection({ skills: { skills: [mk('always')], byName: new Map() } })
  expect(withoutActivation).not.toContain('sqlhelper')
  // 激活后:并回清单
  const withActivation = buildSkillCommandListingSection({
    skills: { skills: [mk('always')], byName: new Map() },
    activatedConditionalSkills: [sqlSkill],
  })
  expect(withActivation).toContain('sqlhelper')
  // collectDiscoveryEntries 层面也含激活的条件技能
  const entries = collectDiscoveryEntries({ skills: { skills: [], byName: new Map() }, activatedConditionalSkills: [sqlSkill] })
  expect(entries.map(e => e.name)).toContain('sqlhelper')
})
