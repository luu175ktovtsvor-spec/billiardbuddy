import type { HookRegistry } from '../hooks/hooks'
import { commandLibraryFromCommands, normalizeCommandName, type CommandLibrary } from '../commands/commandLoader'
import type { PromptCommand } from '../commands/types'
import type { Tool, ToolContext } from '../tools/Tool'
import { renderSessionStartContext, renderOpsBriefing } from './billiards'

export interface DomainPackCommand {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  /** 额外的斜杠别名(如入口命令 /台球 也接受 /billiards、/球房);仅进 byName 解析,不在清单里重复出条。 */
  aliases?: string[]
  prompt: string
}

export interface DomainPack {
  id: string
  name: string
  description: string
  aliases?: string[]
  defaultEnabled?: boolean
  sessionStartContext: string
  suggestedSkills?: string[]
  commands?: DomainPackCommand[]
  tools?: Tool[]
}

const billiardsOpsChecklistTool: Tool = {
  name: 'billiards_ops_checklist',
  description: 'Build a concise billiards store operations checklist for a business/content task. Use only when the billiards domain pack is enabled and the user is asking about store operations, activities, pricing, staff, members, posters, or short videos.',
  inputSchema: {
    type: 'object',
    properties: {
      scenario: { type: 'string', description: 'The store operation or content scenario to plan.' },
      known_facts: { type: 'array', items: { type: 'string' }, description: 'Facts already provided by the user or retrieved from store docs.' },
      needs_media: { type: 'boolean', description: 'Whether the next action may involve image/video generation or editing.' },
    },
    required: ['scenario'],
  },
  isReadOnly: true,
  async execute(input: unknown): Promise<string> {
    const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const scenario = typeof body.scenario === 'string' && body.scenario.trim() ? body.scenario.trim() : '台球门店运营任务'
    const facts = Array.isArray(body.known_facts)
      ? body.known_facts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 8)
      : []
    const needsMedia = body.needs_media === true || body.needsMedia === true
    return [
      '<domain_pack_tool_result pack="billiards" tool="billiards_ops_checklist">',
      `场景:${scenario}`,
      facts.length ? `已知事实:${facts.join('；')}` : '已知事实:未提供足够本店事实',
      renderOpsBriefing(scenario, facts),
      '先核对:价格/套餐/地址/二维码/排班/合同/活动时间/会员权益等本店事实必须来自用户输入或 search_store_docs 来源,不能编造。',
      '执行顺序:1. 判断经营目标;2. 补齐缺失事实;3. 给老板可直接执行的动作;4. 需要素材时再进入生图或真实素材剪辑工作台。',
      needsMedia
        ? '媒体注意:生图和真实素材剪辑只是延伸能力;先写清主卖点、画面要素、硬文字与核对项,再按需调用 make_poster/generate_image 或让用户导入真实视频素材剪辑。'
        : '媒体注意:如果当前任务只是经营判断或代码/文件修改,不要主动跳到生图/视频。',
      '输出约束:短、可执行、带来源提醒;资料库没看到的事实要明说“资料库里没看到”。',
      '</domain_pack_tool_result>',
    ].join('\n')
  },
}

export const DOMAIN_PACKS: DomainPack[] = [
  {
    id: 'billiards',
    name: '台球运营专家',
    description: '挂载后,AI 会按台球房经营、活动、客户、助教、赛事、团购、短视频、海报等专家流程来答。',
    aliases: ['billiard', 'pool', '台球', '球房', '台球房'],
    defaultEnabled: false,
    suggestedSkills: [
      'daily-report',
      'find-problems',
      'run-activity',
      'video-edit',
      'what-to-post-today',
    ],
    commands: [
      {
        name: '台球',
        description: '台球运营专家入口:切进台球房经营专家视角作答',
        whenToUse: '老板想进入台球运营专家,或问球房经营/活动/客户/助教/赛事/团购/短视频/海报等台球运营问题时;也可直接敲 /台球。',
        aliases: ['billiards', '球房', '台球房', 'pool', 'billiard'],
        allowedTools: ['search_store_docs', 'billiards_ops_checklist', 'list_commands', 'read_command', 'list_skills', 'read_skill', 'todo_write'],
        prompt: [
          '你现在切进「台球运营专家」视角:仍是通用本机助手,但按《台球赋能》PPT 底本策展的真实球房经营语境来答。',
          '先判断老板到底要什么:日报/经营复盘/今日重点 → 走 /billiards:daily-ops;朋友圈/团购/短视频脚本/海报/生图方向 → 走 /billiards:content-plan;要按场景带出硬数字与禁词提醒 → 调 billiards_ops_checklist。',
          '涉及本店价格/套餐/地址/二维码/排班/合同/活动时间/会员权益等事实,必须来自老板输入或 search_store_docs 来源;查不到就明说“资料库里没看到”,不编造。',
          '内行词照用不消毒(美女人设/异性情绪价值/擦边引流/交友软件获客/红包/追分/助教免费体验是 PPT 在册真实打法);平台/渠道/器材通用名照写不脱敏;真底线禁词(性交易/虚假承诺/门店坐庄抽成/假号刷评/未成年)命中即改写。',
          '第三方真实门店/连锁/人名/城市案例名脱敏成“某店/某城市”,只搬逻辑不搬专名。',
          '输出短、可执行、带来源提醒;需要专门流程时用 list_commands / list_skills 渐进披露,别一次性铺开。',
        ].join('\n'),
      },
      {
        name: 'billiards:daily-ops',
        description: '台球门店每日经营复盘与今日动作清单',
        whenToUse: '老板要日报、今日重点、门店经营复盘、客户/助教/活动/收入问题排查时使用。',
        allowedTools: ['search_store_docs', 'list_skills', 'read_skill', 'todo_write'],
        prompt: [
          '你正在执行台球运营专家的每日经营复盘命令。',
          '先判断老板是否给了今日数据、门店文件或具体问题;如果涉及本店合同、价目表、排班、会员、活动记录,优先用 search_store_docs 查本机店铺资料并带出处。',
          '需要行业流程时,先 list_skills({recommended_only:true}),再 read_skill 展开最相关技能;不要一次性展开所有技能。',
          '输出要短、可执行:先给今天最该盯的 3 件事,再给风险提醒,最后给可直接交给员工执行的动作清单。',
          '如果缺关键数据,列出最少需要补充的字段,不要编造门店真实数字。',
        ].join('\n'),
      },
      {
        name: 'billiards:content-plan',
        description: '台球门店短视频/海报/活动内容编排',
        whenToUse: '老板要朋友圈、团购活动、短视频脚本、生图提示词或真实素材剪辑方向时使用。',
        allowedTools: ['search_store_docs', 'list_skills', 'read_skill', 'make_poster', 'generate_image', 'todo_write'],
        prompt: [
          '你正在执行台球运营专家的内容编排命令。',
          '把生图和真实素材剪辑当作 Agent 外壳里的延伸能力:先确定经营目标和受众,再决定是否调用媒体工具或要求用户导入实拍素材。',
          '优先结合本机店铺资料、门店记忆和老板给的素材;涉及价格、套餐、二维码、门店地址、活动时间时必须提醒核对或查询来源。',
          '输出结构:1. 目标和主卖点;2. 可直接发布的文案/脚本;3. 画面或海报提示词;4. 下一步是否需要调用生图工具或导入真实素材剪辑。',
          '风格保持简洁、像 Work Buddy/Codex 的工具流,不要加入装饰性台球挂件或空泛营销话术。',
        ].join('\n'),
      },
    ],
    tools: [billiardsOpsChecklistTool],
    sessionStartContext: renderSessionStartContext(),
  },
]

const PACK_BY_ALIAS = new Map<string, DomainPack>()
for (const pack of DOMAIN_PACKS) {
  PACK_BY_ALIAS.set(normalizePackId(pack.id), pack)
  for (const alias of pack.aliases ?? []) PACK_BY_ALIAS.set(normalizePackId(alias), pack)
}

export function publicDomainPack(pack: DomainPack) {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    aliases: pack.aliases ?? [],
    default_enabled: pack.defaultEnabled === true,
    suggested_skills: pack.suggestedSkills ?? [],
    suggested_commands: (pack.commands ?? []).map(command => command.name),
    suggested_tools: (pack.tools ?? []).map(tool => tool.name),
  }
}

export function listPublicDomainPacks() {
  return DOMAIN_PACKS.map(publicDomainPack)
}

export function resolveEnabledPacks(input: Record<string, unknown>): DomainPack[] {
  const explicit = firstDefined(
    input.enabled_packs,
    input.enabledPacks,
    input.knowledge_packs,
    input.knowledgePacks,
  )
  const ids = stringArray(explicit)
  if (ids.length === 0 && explicit === undefined && (input.billiards_mode === true || input.billiardsMode === true)) {
    ids.push('billiards')
  }

  const seen = new Set<string>()
  const packs: DomainPack[] = []
  for (const id of ids) {
    const pack = PACK_BY_ALIAS.get(normalizePackId(id))
    if (!pack || seen.has(pack.id)) continue
    seen.add(pack.id)
    packs.push(pack)
  }
  return packs
}

export function createDomainPackHookRegistry(packs: DomainPack[]): HookRegistry | undefined {
  if (packs.length === 0) return undefined
  return {
    rules: packs.map(pack => ({
      event: 'SessionStart',
      handler: () => ({ action: 'context', additionalContext: pack.sessionStartContext }),
    })),
  }
}

export function suggestedSkillNamesForPacks(packs: DomainPack[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const name of pack.suggestedSkills ?? []) {
      const trimmed = name.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

export function suggestedCommandNamesForPacks(packs: DomainPack[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const name = normalizeCommandName(command.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function createDomainPackCommandLibrary(packs: DomainPack[]): CommandLibrary | undefined {
  const commands: PromptCommand[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const name = normalizeCommandName(command.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      commands.push(domainPackCommand(pack, { ...command, name }))
    }
  }
  if (commands.length === 0) return undefined
  const library = commandLibraryFromCommands(commands)
  registerDomainPackCommandAliases(library, packs)
  return library
}

/**
 * 把领域包命令的 aliases 注册进 library.byName(不进 commands 数组,清单不重复出条)。
 * 用于合并后重新挂别名:mergeCommandLibraries 只从 commands 数组重建 byName,会丢掉这些别名键,
 * 所以每次拿到最终 library 后都要再调一次,保证 /台球、/球房、/billiards 都能解析到入口命令。
 */
export function registerDomainPackCommandAliases(library: CommandLibrary, packs: DomainPack[]): void {
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const canonical = normalizeCommandName(command.name)
      const target = canonical ? library.byName.get(canonical) : undefined
      if (!target) continue
      for (const alias of command.aliases ?? []) {
        const key = normalizeCommandName(alias)
        if (!key || library.byName.has(key)) continue
        library.byName.set(key, target)
      }
    }
  }
}

export function createDomainPackTools(packs: DomainPack[]): Tool[] {
  const out: Tool[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const tool of pack.tools ?? []) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      out.push(tool)
    }
  }
  return out
}

export function mergeHookRegistries(...registries: Array<HookRegistry | undefined>): HookRegistry | undefined {
  const rules = registries.flatMap(registry => registry?.rules ?? [])
  return rules.length > 0 ? { rules } : undefined
}

function domainPackCommand(pack: DomainPack, command: DomainPackCommand): PromptCommand {
  const prompt = command.prompt.trim()
  return {
    type: 'prompt',
    name: command.name,
    description: command.description,
    whenToUse: command.whenToUse,
    allowedTools: command.allowedTools,
    source: 'commands',
    filePath: `domain-pack://${pack.id}/${command.name}`,
    baseDir: `domain-pack://${pack.id}`,
    contentLength: prompt.length,
    async getPrompt(args: string, _ctx: ToolContext): Promise<string> {
      const argText = args.trim() ? `\n\n命令参数:\n${args.trim()}` : ''
      return [
        `命令: /${command.name}`,
        `领域包: ${pack.name} (${pack.id})`,
        '',
        prompt,
        argText.trimEnd(),
      ].filter(Boolean).join('\n')
    },
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined)
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
  if (typeof value === 'string' && value.trim()) return value.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
  return []
}

function normalizePackId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}
