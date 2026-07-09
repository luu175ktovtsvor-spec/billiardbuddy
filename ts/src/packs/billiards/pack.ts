// 台球运营领域包 · 「第一个注册的领域包」定义
//
// 这里把台球包装配成一个通用 DomainPack:入口命令 /台球(+ 别名)、两条子命令、经营核对工具、
// 挂载注入的策展上下文、知识统计句柄、守卫句柄、版本。核心(registry / domainPacks 门面)只认
// DomainPack 接口,不感知台球细节;新增别的领域包照此写一个模块并注册即可,不改核心。
//
// 知识内容(knowledge/guardrails/hardSpecs/termWhitelist)一律沿用 ./index 的策展装配,本文件只做「装成 pack」。

import type { Tool } from '../../tools/Tool'
import type { DomainPack } from '../types'
import { renderSessionStartContext, renderOpsBriefing, billiardsPackStats, guardText } from './index'

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

/** 台球运营专家领域包(第一个注册的 pack)。 */
export const billiardsPack: DomainPack = {
  id: 'billiards',
  name: '台球运营专家',
  description: '挂载后,AI 会按台球房经营、活动、客户、助教、赛事、团购、短视频、海报等专家流程来答。',
  version: '1.0.0',
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
      allowedTools: ['search_store_docs', 'list_skills', 'read_skill', 'make_poster', 'generate_image', 'edit_image', 'todo_write'],
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
  // 知识/守卫句柄:核心不感知其形状,pack 自持。knowledge 供面板/报告统计,guardrails 供领域级红线/脱敏扫描。
  knowledge: { stats: () => billiardsPackStats() },
  guardrails: { scan: (text: string) => guardText(text) },
}
